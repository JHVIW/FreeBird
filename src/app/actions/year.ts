"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { timeEntries, assets, fiscalParams } from "@/db/schema";
import { run, fstr, fnum } from "@/lib/action";
import { runDepreciation } from "@/lib/reports";
import { parseEur } from "@/lib/money";
import { postEntry, reverseEntry } from "@/lib/ledger";
import { today } from "@/lib/dates";

export async function addHours(fd: FormData) {
  const y = fstr(fd, "date").slice(0, 4);
  await run(`/jaar?y=${y}`, async () => {
    const h = fnum(fd, "hours");
    if (!h || h <= 0) throw new Error("Vul het aantal uren in");
    await db.insert(timeEntries).values({ date: fstr(fd, "date"), minutes: Math.round(h * 60), note: fstr(fd, "note") || null });
  }, "Uren toegevoegd");
}

export async function deleteHours(fd: FormData) {
  await run(`/jaar?y=${fstr(fd, "y")}`, async () => { await db.delete(timeEntries).where(eq(timeEntries.id, Number(fd.get("rowId")))); });
}

export async function setOtherIncome(fd: FormData) {
  const year = Number(fstr(fd, "y"));
  await run(`/jaar?y=${year}`, async () => {
    if (!Number.isInteger(year)) throw new Error("Ongeldig jaar");
    const cents = parseEur(fstr(fd, "otherIncome") || "0");
    if (cents == null || cents < 0) throw new Error("Vul een geldig bedrag in");
    await db.insert(fiscalParams).values({ year, key: "other_income_cents", value: cents, note: "Ander box 1-inkomen (loon)" })
      .onConflictDoUpdate({ target: [fiscalParams.year, fiscalParams.key], set: { value: cents } });
  }, "Ander inkomen opgeslagen");
}

export async function addAsset(fd: FormData) {
  await run(`/jaar`, async () => {
    const cost = parseEur(fstr(fd, "cost"));
    if (!cost) throw new Error("Vul de aanschafwaarde in");
    await db.insert(assets).values({ name: fstr(fd, "name"), purchaseDate: fstr(fd, "date"), costCents: cost, residualCents: parseEur(fstr(fd, "residual")) ?? 0, months: fnum(fd, "months") ?? 36 });
  }, "Bedrijfsmiddel toegevoegd. Let op: de aankoop zelf boek je via de bon of bank op 0200 Inventaris.");
}

export async function depreciate() {
  await run(`/jaar`, async () => {
    const r = await runDepreciation(today().slice(0, 7));
    return { ok: `${r.booked} afschrijving(en) geboekt` };
  });
}

export async function addMemorial(fd: FormData) {
  await run(`/journaal`, async () => {
    const lines: { accountCode: string; amountCents: number; memo?: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const code = fstr(fd, `acc${i}`);
      const d = parseEur(fstr(fd, `d${i}`)) ?? 0;
      const c = parseEur(fstr(fd, `c${i}`)) ?? 0;
      if (code && (d || c)) lines.push({ accountCode: code, amountCents: d - c });
    }
    await postEntry(db, { date: fstr(fd, "date"), description: fstr(fd, "description") || "Memoriaalboeking", sourceType: fstr(fd, "kind") === "opening" ? "opening" : "memorial", lines });
  }, "Geboekt");
}

export async function reverseMemorial(fd: FormData) {
  await run(`/journaal`, async () => { await reverseEntry(db, Number(fd.get("rowId")), fstr(fd, "date") || today()); }, "Tegenboeking gemaakt");
}
