/**
 * Achtergrondtaken. Draait als apart proces naast de web-app (zie docker-compose.yml).
 * Elke minuut wordt gekeken welke taken aan de beurt zijn; de laatste run staat in job_runs.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { importPayments, syncAccounts, ensureCallback } from "@/lib/bunq/sync";
import { createSession } from "@/lib/bunq/client";
import { pollReceiptsMailbox } from "@/lib/receipts";
import { runMatching } from "@/lib/bank";
import { processReminders, processRecurring } from "@/lib/invoice-delivery";
import { runDepreciation } from "@/lib/reports";
import { today } from "@/lib/dates";
import { aiConfigured } from "@/lib/ai";
import { suggestOpen, bulkStatus } from "@/lib/ai-bank";
import { maybeRunFetch } from "@/lib/moneybird-fetch";

type Job = { name: string; every?: number; dailyAt?: number; run: () => Promise<string> };

const JOBS: Job[] = [
  {
    name: "bonnen-ophalen", every: 2 * 60_000,
    run: async () => { const r = await pollReceiptsMailbox(); return r.skipped ? "IMAP niet ingesteld" : `${r.imported} bijlagen`; },
  },
  {
    name: "bunq-sync", every: 15 * 60_000,
    run: async () => {
      if (!(await getSetting("bunq")).apiKey) return "bunq niet gekoppeld";
      await syncAccounts();
      const r = await importPayments();
      return `${r.inserted} nieuw, ${r.autoBooked} automatisch geboekt`;
    },
  },
  {
    name: "bunq-sessie-en-callback", dailyAt: 4,
    run: async () => {
      if (!(await getSetting("bunq")).apiKey) return "bunq niet gekoppeld";
      await createSession();
      const url = await ensureCallback().catch((e) => `callback: ${(e as Error).message}`);
      return `sessie vernieuwd · ${url}`;
    },
  },
  {
    name: "ai-boekvoorstellen", every: 15 * 60_000,
    run: async () => {
      if (!(await aiConfigured())) return "geen DeepSeek key";
      if ((await bulkStatus()).running) return "overgeslagen: bulk loopt al";
      const r = await suggestOpen(500);
      return `${r.suggested} voorstellen${r.failed ? `, ${r.failed} mislukt` : ""}`;
    },
  },
  { name: "moneybird-ophalen", every: 60_000, run: maybeRunFetch },
  { name: "matching", dailyAt: 5, run: async () => { const r = await runMatching(); return `${r.checked} bekeken, ${r.applied} geboekt`; } },
  { name: "terugkerende-facturen", dailyAt: 7, run: async () => `${(await processRecurring()).created} aangemaakt` },
  { name: "herinneringen", dailyAt: 9, run: async () => `${(await processReminders()).sent} verstuurd` },
  {
    name: "afschrijvingen", dailyAt: 6,
    run: async () => {
      // boek t/m de vorige maand, zodat een maand pas na afloop wordt afgeschreven
      const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
      return `${(await runDepreciation(d.toISOString().slice(0, 7))).booked} geboekt`;
    },
  },
];

function amsterdamHour(): number {
  return Number(new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", hour12: false }).format(new Date()));
}

async function due(job: Job): Promise<boolean> {
  const [r] = await db.select().from(jobRuns).where(eq(jobRuns.name, job.name));
  const last = r?.lastRunAt?.getTime() ?? 0;
  if (job.every) return Date.now() - last >= job.every;
  if (job.dailyAt != null) {
    const lastDay = last ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam" }).format(new Date(last)) : "";
    return lastDay !== today() && amsterdamHour() >= job.dailyAt;
  }
  return false;
}

async function record(name: string, status: string, message: string) {
  await db.insert(jobRuns).values({ name, lastRunAt: new Date(), lastStatus: status, lastMessage: message.slice(0, 500) })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: new Date(), lastStatus: status, lastMessage: message.slice(0, 500) } });
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const job of JOBS) {
      if (!(await due(job))) continue;
      const t0 = Date.now();
      try {
        const msg = await job.run();
        await record(job.name, "ok", msg);
        console.log(`[${new Date().toISOString()}] ${job.name}: ${msg} (${Date.now() - t0} ms)`);
      } catch (e) {
        await record(job.name, "fout", (e as Error).message);
        console.error(`[${new Date().toISOString()}] ${job.name} mislukt:`, e);
      }
    }
  } finally {
    running = false;
  }
}

console.log("FreeBird-worker gestart");
void tick();
setInterval(() => void tick(), 60_000);
