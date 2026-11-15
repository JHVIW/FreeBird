import { and, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, mbItems } from "@/db/schema";
import { mbGet, mbGetAll, mbDownload, mbCents, mbContactName, importMoneybirdContacts, MoneybirdError, type MbContact } from "./moneybird";
import { storeFile } from "./storage";
import { getSetting } from "./settings";
import { today } from "./dates";

/** Ophalen uit Moneybird: alles naar mb_items en bestanden naar de opslag. Kan na een onderbreking verder. */

export type MbFile = { kind: "pdf" | "attachment"; attachmentId?: string; name: string; fileId?: string; error?: string };
type MbAttachment = { id: string; filename: string; content_type: string };
type MbDoc = {
  id: string; version?: number; state?: string; date?: string; invoice_date?: string | null; invoice_id?: string | null; reference?: string | null;
  contact_id?: string | null; contact?: MbContact | null; total_price_incl_tax?: string | null; attachments?: MbAttachment[];
  general_journal_document_entries?: { debit: string }[];
};

/** Soorten documenten, met het pad in de API. */
export const DOC_KINDS = [
  { kind: "sales_invoice", path: "sales_invoices", label: "Verkoopfacturen", extraFilter: ",state:all" },
  { kind: "external_sales_invoice", path: "external_sales_invoices", label: "Externe verkoopfacturen", extraFilter: "" },
  { kind: "purchase_invoice", path: "documents/purchase_invoices", label: "Inkoopfacturen", extraFilter: "" },
  { kind: "receipt", path: "documents/receipts", label: "Bonnen", extraFilter: "" },
  { kind: "general_journal_document", path: "documents/general_journal_documents", label: "Memoriaalboekingen", extraFilter: "" },
  { kind: "general_document", path: "documents/general_documents", label: "Overige documenten", extraFilter: "" },
  { kind: "typeless_document", path: "documents/typeless_documents", label: "Ongesorteerde documenten", extraFilter: "" },
] as const;

export const KIND_LABEL: Record<string, string> = Object.fromEntries(DOC_KINDS.map((k) => [k.kind, k.label]));

const JOB = "moneybird";

export async function fetchStatus() {
  const [r] = await db.select().from(jobRuns).where(eq(jobRuns.name, JOB));
  const fresh = !!r?.lastRunAt && Date.now() - r.lastRunAt.getTime() < 10 * 60_000;
  return {
    status: r?.lastStatus ?? null, message: r?.lastMessage ?? null, at: r?.lastRunAt ?? null,
    running: r?.lastStatus === "bezig" && fresh,
    queued: r?.lastStatus === "gevraagd",
    /** Bezig maar al 10 minuten geen voortgang: de vorige run is onderbroken (herstart). */
    stale: r?.lastStatus === "bezig" && !fresh,
  };
}

async function progress(status: string, message: string) {
  await db.insert(jobRuns).values({ name: JOB, lastRunAt: new Date(), lastStatus: status, lastMessage: message.slice(0, 500) })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: new Date(), lastStatus: status, lastMessage: message.slice(0, 500) } });
}

/** Zet het ophalen in de wachtrij; de worker pakt het binnen een minuut op. */
export async function requestFetch() {
  const s = await fetchStatus();
  if (s.running || s.queued) return false;
  await progress("gevraagd", "In de wachtrij, start binnen een minuut");
  return true;
}

function filesFor(kind: string, d: MbDoc): MbFile[] {
  const out: MbFile[] = [];
  if (kind === "sales_invoice" && d.state !== "draft" && d.invoice_id) out.push({ kind: "pdf", name: `${d.invoice_id}.pdf` });
  for (const a of d.attachments ?? []) out.push({ kind: "attachment", attachmentId: String(a.id), name: a.filename });
  return out;
}

/** Slaat een Moneybird-document op; bestaande bestanden blijven bewaard als de bijlagen niet veranderd zijn. */
async function upsertDoc(kind: string, d: MbDoc) {
  const total = d.total_price_incl_tax != null ? mbCents(d.total_price_incl_tax)
    : d.general_journal_document_entries ? d.general_journal_document_entries.reduce((s, e) => s + mbCents(e.debit), 0) : null;
  const values = {
    kind, mbId: String(d.id), version: d.version ?? null, date: (kind === "sales_invoice" ? d.invoice_date : d.date) ?? null,
    number: (kind === "sales_invoice" ? d.invoice_id : d.reference) ?? null, contactMbId: d.contact_id ? String(d.contact_id) : null,
    contactName: d.contact ? mbContactName(d.contact) : null, totalCents: total, state: d.state ?? null, raw: d,
  };
  const [ex] = await db.select().from(mbItems).where(and(eq(mbItems.kind, kind), eq(mbItems.mbId, String(d.id))));
  const wanted = filesFor(kind, d);
  if (!ex) { await db.insert(mbItems).values({ ...values, files: wanted }); return; }
  if (ex.version != null && ex.version === values.version) return;
  // bestaande downloads hergebruiken, nieuwe bijlagen toevoegen
  const have = ex.files as MbFile[];
  const files = wanted.map((w) => have.find((h) => h.kind === w.kind && h.attachmentId === w.attachmentId && h.fileId) ?? w);
  await db.update(mbItems).set({ ...values, files, fetchedAt: new Date() }).where(eq(mbItems.id, ex.id));
}

async function upsertRef(kind: string, mbId: string, raw: unknown, extra: { date?: string | null; number?: string | null } = {}) {
  await db.insert(mbItems).values({ kind, mbId, raw: raw as object, date: extra.date ?? null, number: extra.number ?? null, files: [] })
    .onConflictDoUpdate({ target: [mbItems.kind, mbItems.mbId], set: { raw: raw as object, fetchedAt: new Date() } });
}

/** Alle documenten van een soort, eerst met één brede periode; weigert Moneybird dat, dan per jaar. */
async function listAll(path: string, extraFilter: string, onCount: (n: number) => void): Promise<MbDoc[]> {
  const enc = (f: string) => encodeURIComponent(f);
  try {
    return await mbGetAll<MbDoc>(`${path}.json?filter=${enc(`period:20000101..${new Date().getFullYear() + 1}1231${extraFilter}`)}`, onCount);
  } catch (e) {
    if (!(e instanceof MoneybirdError) || (e.status !== 400 && e.status !== 422)) throw e;
    const out: MbDoc[] = [];
    for (let y = 2010; y <= new Date().getFullYear() + 1; y++) {
      out.push(...(await mbGetAll<MbDoc>(`${path}.json?filter=${enc(`period:${y}0101..${y}1231${extraFilter}`)}`)));
      onCount(out.length);
    }
    return out;
  }
}

type GL = Record<"start_balance" | "debit_sums" | "credit_sums" | "final_balance", { ledger_accounts: { ledger_account_id: string; value: string }[] }>;

/** Het hele ophaalproces. Elke stap is idempotent, dus opnieuw starten gaat verder waar het bleef. */
export async function runFetch() {
  const step = (m: string) => progress("bezig", m);
  try {
    await step("Grootboekrekeningen en BTW-tarieven ophalen");
    for (const a of await mbGet<{ id: string }[]>("ledger_accounts.json")) await upsertRef("ledger_account", String(a.id), a);
    for (const t of await mbGetAll<{ id: string }>("tax_rates.json")) await upsertRef("tax_rate", String(t.id), t);
    for (const f of await mbGet<{ id: string }[]>("financial_accounts.json")) await upsertRef("financial_account", String(f.id), f);

    await step("Contacten ophalen");
    const c = await importMoneybirdContacts();

    const counts: string[] = [];
    for (const k of DOC_KINDS) {
      await step(`${k.label} ophalen`);
      try {
        const docs = await listAll(k.path, k.extraFilter, (n) => void step(`${k.label} ophalen: ${n}`));
        for (const d of docs) await upsertDoc(k.kind, d);
        counts.push(`${docs.length} ${k.label.toLowerCase()}`);
      } catch (e) {
        // geen recht op één soort (scope) mag de rest niet tegenhouden
        if (e instanceof MoneybirdError && (e.status === 403 || e.status === 404)) { counts.push(`${k.label.toLowerCase()}: ${e.message}`); continue; }
        throw e;
      }
    }

    await reportsStep(step);
    const files = await filesStep(step);
    const [stored] = await db.select({ n: dsql<number>`coalesce(sum((select count(*) from jsonb_array_elements(${mbItems.files}) f where f->>'fileId' is not null)),0)` }).from(mbItems);
    await progress("ok", `Klaar: ${c.imported + c.updated} contacten, ${counts.join(", ")}; ${Number(stored.n)} bestanden bewaard${files.done ? ` (${files.done} nieuw)` : ""}${files.failed ? `, ${files.failed} mislukt (worden bij de volgende keer opnieuw geprobeerd)` : ""}`);
  } catch (e) {
    await progress("fout", (e as Error).message);
  }
}

/** Grootboekrapporten: per maand voor het jaar van de startdatum (voor de overname), per jaar daarvoor (archief). */
async function reportsStep(step: (m: string) => Promise<void>) {
  const g = await getSetting("general");
  const start = g.openingDate ?? `${today().slice(0, 4)}-01-01`;
  const year = Number(start.slice(0, 4));
  const lastMonth = Math.min(12, year < Number(today().slice(0, 4)) ? 12 : Number(today().slice(5, 7)));
  const [first] = await db.select({ y: dsql<number | null>`min(extract(year from ${mbItems.date}))::int` }).from(mbItems);
  for (let m = 1; m <= lastMonth; m++) {
    const key = `general_ledger:${year}-${String(m).padStart(2, "0")}`;
    const [have] = await db.select().from(mbItems).where(and(eq(mbItems.kind, "report"), eq(mbItems.mbId, key)));
    // afgesloten maanden hoeven niet opnieuw; de lopende en vorige maand wel (kunnen nog wijzigen)
    if (have && m < lastMonth - 1) continue;
    await step(`Grootboek ${year}-${String(m).padStart(2, "0")} ophalen`);
    const p = `${year}${String(m).padStart(2, "0")}`;
    const gl = await mbGet<GL>(`reports/general_ledger.json?period=${p}..${p}`);
    await upsertRef("report", key, gl, { date: `${p.slice(0, 4)}-${p.slice(4)}-01` });
  }
  for (let y = first?.y ?? year; y < year; y++) {
    const key = `general_ledger:${y}`;
    const [have] = await db.select().from(mbItems).where(and(eq(mbItems.kind, "report"), eq(mbItems.mbId, key)));
    if (have) continue;
    await step(`Grootboek ${y} ophalen (archief)`);
    const gl = await mbGet<GL>(`reports/general_ledger.json?period=${y}01..${y}12`);
    await upsertRef("report", key, gl, { date: `${y}-01-01` });
  }
}

function downloadPath(kind: string, mbId: string, f: MbFile): string {
  const base = DOC_KINDS.find((k) => k.kind === kind)!.path;
  if (f.kind === "pdf") return `sales_invoices/${mbId}/download_pdf.json`;
  return `${base}/${mbId}/attachments/${f.attachmentId}/download.json`;
}

/** Downloadt alle bestanden die nog ontbreken. Mislukte worden bij een volgende run opnieuw geprobeerd. */
async function filesStep(step: (m: string) => Promise<void>) {
  const items = await db.select({ id: mbItems.id, kind: mbItems.kind, mbId: mbItems.mbId, files: mbItems.files, number: mbItems.number }).from(mbItems)
    .where(dsql`exists (select 1 from jsonb_array_elements(${mbItems.files}) f where f->>'fileId' is null)`);
  const total = items.reduce((s, i) => s + (i.files as MbFile[]).filter((f) => !f.fileId).length, 0);
  let done = 0, failed = 0;
  for (const it of items) {
    const files = it.files as MbFile[];
    for (const f of files) {
      if (f.fileId) continue;
      await step(`Bestanden downloaden: ${done + failed} van ${total}`);
      try {
        const { buf, mime } = await mbDownload(downloadPath(it.kind, it.mbId, f));
        const stored = await storeFile(buf, f.name, f.kind === "pdf" ? "application/pdf" : mime);
        f.fileId = stored.id; delete f.error; done++;
      } catch (e) {
        if (e instanceof MoneybirdError && e.status === 401) throw e;
        f.error = (e as Error).message; failed++;
      }
      await db.update(mbItems).set({ files }).where(eq(mbItems.id, it.id));
    }
  }
  return { done, failed };
}

/** Worker: start een gevraagde of onderbroken run. Draait los, zodat andere taken doorgaan. */
let active = false;
export async function maybeRunFetch(): Promise<string> {
  const s = await fetchStatus();
  if (active) return "loopt al";
  if (!s.queued && !s.stale) return "niets te doen";
  active = true;
  void runFetch().finally(() => { active = false; });
  return s.stale ? "onderbroken run hervat" : "gestart";
}
