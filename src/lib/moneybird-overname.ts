import { and, eq, inArray, like, sql as dsql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import {
  accounts, bankTransactions, contacts, invoiceLines, invoices, journalEntries, mbItems, numberSequences, periods, receipts, reconciliations, vatCodes,
} from "@/db/schema";
import { postEntry, LedgerError, type PostLine, type PostVat } from "./ledger";
import { getVatCodes, vatPostingLines, type VatCodeRow } from "./vat";
import { getSetting, setSetting } from "./settings";
import { mbCents, upsertMoneybirdContact, type MbContact } from "./moneybird";
import type { MbFile } from "./moneybird-fetch";
import { aiJson } from "./ai";
import { runMatching } from "./bank";
import { addDays, addMonths, daysBetween, quarterRange, today } from "./dates";
import { audit } from "./audit";

/**
 * Overname uit Moneybird naar de boekhouding van FreeBird.
 * - Saldi op 1 januari en maandtotalen per grootboekrekening tot de startdatum (zodat het jaaroverzicht klopt).
 * - Facturen en inkoopdocumenten die op de startdatum nog openstonden: zonder boeking (zitten al in de saldi), wel om betalingen op te koppelen.
 * - Alles vanaf de startdatum als echte boekingen, net als in FreeBird zelf.
 * Alles wat de overname boekt heeft sourceType "moneybird" en kan in één keer ongedaan worden gemaakt.
 */

type LedgerRef = { id: string; name: string; account_type: string; account_id: string | null; financial_account_id?: string | null };
type TaxRef = { id: string; name: string; percentage: string; tax_rate_type: string; country: string | null };
type GlList = { ledger_accounts: { ledger_account_id: string; value: string }[] };
type GL = { start_balance: GlList; debit_sums: GlList; credit_sums: GlList; final_balance: GlList };
type Detail = { ledger_account_id: string; tax_rate_id: string; total_price_excl_tax_with_discount: string; description: string; amount?: string | null; amount_decimal?: string | null; price: string };
type Payment = { price: string; payment_date: string };
type TaxTotal = { tax_rate_id: string; taxable_amount: string; tax_amount: string };
type SalesRaw = {
  id: string; invoice_id: string | null; invoice_date: string; due_date: string; currency: string; language?: string | null; reference?: string | null;
  contact?: MbContact | null; contact_id?: string | null; details: Detail[]; payments?: Payment[]; tax_totals?: TaxTotal[];
  total_price_incl_tax: string; total_price_excl_tax: string; original_sales_invoice_id?: string | null; state: string;
};
type DocRaw = {
  id: string; reference: string | null; date: string; due_date?: string | null; currency?: string | null; state: string; contact?: MbContact | null; contact_id?: string | null;
  details?: Detail[]; payments?: Payment[]; total_price_incl_tax: string | null; total_price_excl_tax: string | null; prices_are_incl_tax?: boolean | null;
};
type JournalRaw = { id: string; reference: string | null; date: string; journal_type?: string | null; general_journal_document_entries: { ledger_account_id: string; debit: string; credit: string; description?: string | null; contact_id?: string | null }[] };

const DEBIT_TYPES = new Set(["non_current_assets", "current_assets", "direct_costs", "expenses"]);
const PL_TYPES = new Set(["revenue", "direct_costs", "expenses", "other_income_expenses"]);
const SALES_KINDS = ["sales_invoice", "external_sales_invoice"];
const PURCHASE_KINDS = ["purchase_invoice", "receipt"];

// ---------- referentiegegevens ----------

async function refs() {
  const rows = await db.select().from(mbItems).where(inArray(mbItems.kind, ["ledger_account", "tax_rate", "report"]));
  const ledger = new Map<string, LedgerRef>();
  const tax = new Map<string, TaxRef>();
  const reports = new Map<string, GL>();
  for (const r of rows) {
    if (r.kind === "ledger_account") ledger.set(r.mbId, r.raw as LedgerRef);
    else if (r.kind === "tax_rate") tax.set(r.mbId, r.raw as TaxRef);
    else reports.set(r.mbId.replace("general_ledger:", ""), r.raw as GL);
  }
  return { ledger, tax, reports };
}

/**
 * Saldi uit een grootboekrapport, debet positief. Moneybird zegt niet welk teken het gebruikt, dus we leiden het af:
 * tellen de waarden op tot (bijna) nul, dan zijn ze al getekend; staan de bezittingen dan negatief, dan draaien we om.
 * Zijn ze allemaal positief, dan bepaalt het soort rekening de kant.
 */
export function signedBalances(list: GlList | undefined, ledger: Map<string, Pick<LedgerRef, "account_type">>): Map<string, number> {
  const raw = (list?.ledger_accounts ?? []).map((l) => [String(l.ledger_account_id), mbCents(l.value)] as const).filter(([, v]) => v !== 0);
  const out = new Map<string, number>();
  const sum = raw.reduce((s, [, v]) => s + v, 0);
  const allPositive = raw.every(([, v]) => v >= 0);
  if (Math.abs(sum) <= raw.length && !(allPositive && raw.length > 1 && sum !== 0)) {
    const assets = raw.filter(([id]) => DEBIT_TYPES.has(ledger.get(id)?.account_type ?? "")).reduce((s, [, v]) => s + v, 0);
    const flip = assets < 0 ? -1 : 1;
    for (const [id, v] of raw) out.set(id, v * flip);
  } else {
    for (const [id, v] of raw) out.set(id, DEBIT_TYPES.has(ledger.get(id)?.account_type ?? "") ? v : -v);
  }
  return out;
}

/** Mutaties per rekening in een maand: debet min credit. */
export function movements(gl: GL): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of gl.debit_sums?.ledger_accounts ?? []) out.set(String(l.ledger_account_id), (out.get(String(l.ledger_account_id)) ?? 0) + Math.abs(mbCents(l.value)));
  for (const l of gl.credit_sums?.ledger_accounts ?? []) out.set(String(l.ledger_account_id), (out.get(String(l.ledger_account_id)) ?? 0) - Math.abs(mbCents(l.value)));
  for (const [k, v] of out) if (v === 0) out.delete(k);
  return out;
}

const lastDayOfMonth = (m: string) => addDays(addMonths(`${m}-01`, 1), -1);
const paidBefore = (payments: Payment[] | undefined, date: string) => (payments ?? []).filter((p) => p.payment_date < date).reduce((s, p) => s + mbCents(p.price), 0);

// ---------- plan ----------

export type PlanLine = { mbLedgerId: string | null; code: string | null; cents: number; label: string };
export type PlanEntry = { date: string; description: string; sourceId: string; lines: PlanLine[] };

export type Plan = {
  start: string; year: number; takeYear: boolean; canTakeYear: boolean; warnings: string[];
  opening: PlanEntry | null; months: PlanEntry[];
  openSales: number; openPurchases: number; salesFromStart: number; purchasesFromStart: number; journalsFromStart: number;
  quartersBefore: string[];
  neededLedger: { id: string; name: string; type: string; code: string | null }[];
  neededTax: { id: string; name: string; percentage: string; type: string; code: string | null }[];
  balanceAtStart: { code: string | null; label: string; cents: number }[];
};

/** Bouwt het overnameplan. Puur lezen: dezelfde berekening voor het voorbeeld en voor het boeken. */
export async function buildPlan(opts: { takeYear?: boolean } = {}): Promise<Plan> {
  const g = await getSetting("general");
  const st = await getSetting("moneybird");
  const start = g.openingDate ?? `${today().slice(0, 4)}-01-01`;
  const year = Number(start.slice(0, 4));
  const startMonth = Number(start.slice(5, 7));
  const canTakeYear = start.endsWith("-01") && startMonth > 1;
  const takeYear = (opts.takeYear ?? true) && canTakeYear;
  const { ledger, tax, reports } = await refs();
  const warnings: string[] = [];
  if (!start.endsWith("-01")) warnings.push(`De startdatum ${start} is niet de eerste van een maand. Moneybird levert saldi per maand, dus het beginsaldo is dat van 1 ${start.slice(0, 7)}.`);
  const map = st.ledgerMap ?? {};
  const codeOf = (id: string | null) => (id ? map[id] ?? null : null);
  const labelOf = (id: string) => ledger.get(id)?.name ?? `Moneybird-rekening ${id}`;
  const needed = new Set<string>();
  const neededTaxIds = new Set<string>();

  // beginsaldo
  const openingMonth = takeYear ? `${year}-01` : start.slice(0, 7);
  const firstGl = reports.get(openingMonth);
  let opening: PlanEntry | null = null;
  if (!firstGl) warnings.push(`Grootboekrapport ${openingMonth} ontbreekt; haal eerst alles op uit Moneybird.`);
  else {
    const bal = signedBalances(firstGl.start_balance, ledger);
    const lines: PlanLine[] = [];
    let previousResult = 0;
    for (const [id, cents] of bal) {
      if (PL_TYPES.has(ledger.get(id)?.account_type ?? "")) { previousResult += cents; continue; }
      needed.add(id);
      lines.push({ mbLedgerId: id, code: codeOf(id), cents, label: labelOf(id) });
    }
    if (previousResult) lines.push({ mbLedgerId: null, code: "0900", cents: previousResult, label: "Resultaat eerdere perioden" });
    const diff = lines.reduce((s, l) => s + l.cents, 0);
    if (diff) { lines.push({ mbLedgerId: null, code: "1900", cents: -diff, label: "Verschil beginsaldo (controleren)" }); warnings.push(`Het beginsaldo sluit niet: ${diff / 100} euro staat op 1900 Vraagposten.`); }
    opening = { date: takeYear ? `${year}-01-01` : start, description: `Beginsaldo uit Moneybird per ${takeYear ? `1-1-${year}` : start}`, sourceId: `opening:${openingMonth}`, lines };
  }

  // maandtotalen tot de startdatum
  const months: PlanEntry[] = [];
  if (takeYear) {
    for (let m = 1; m < startMonth; m++) {
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const gl = reports.get(key);
      if (!gl) { warnings.push(`Grootboekrapport ${key} ontbreekt.`); continue; }
      const lines: PlanLine[] = [];
      for (const [id, cents] of movements(gl)) { needed.add(id); lines.push({ mbLedgerId: id, code: codeOf(id), cents, label: labelOf(id) }); }
      const diff = lines.reduce((s, l) => s + l.cents, 0);
      if (diff) { lines.push({ mbLedgerId: null, code: "1900", cents: -diff, label: "Verschil (controleren)" }); warnings.push(`${key} sluit niet: ${diff / 100} euro op 1900.`); }
      if (lines.length) months.push({ date: lastDayOfMonth(key), description: `Overname Moneybird ${key}`, sourceId: `month:${key}`, lines });
    }
  }

  // documenten
  const docs = await db.select().from(mbItems).where(inArray(mbItems.kind, [...SALES_KINDS, ...PURCHASE_KINDS, "general_journal_document"]));
  let openSales = 0, openPurchases = 0, salesFromStart = 0, purchasesFromStart = 0, journalsFromStart = 0;
  for (const d of docs) {
    if (!d.date) continue;
    if (SALES_KINDS.includes(d.kind)) {
      const r = d.raw as SalesRaw;
      if (d.state === "draft") continue;
      if (d.date >= start) {
        salesFromStart++;
        for (const det of r.details ?? []) { needed.add(String(det.ledger_account_id)); neededTaxIds.add(String(det.tax_rate_id)); }
      } else if (d.state !== "uncollectible" && mbCents(r.total_price_incl_tax) - paidBefore(r.payments, start) !== 0) openSales++;
    } else if (PURCHASE_KINDS.includes(d.kind)) {
      const r = d.raw as DocRaw;
      if (d.date >= start) {
        purchasesFromStart++;
        for (const det of r.details ?? []) { needed.add(String(det.ledger_account_id)); neededTaxIds.add(String(det.tax_rate_id)); }
      } else if (mbCents(r.total_price_incl_tax) - paidBefore(r.payments, start) > 0 && d.state !== "new") openPurchases++;
    } else if (d.date >= start && (d.raw as JournalRaw).journal_type !== "fiscal_year_ending") {
      journalsFromStart++;
      for (const e of (d.raw as JournalRaw).general_journal_document_entries ?? []) needed.add(String(e.ledger_account_id));
    }
  }

  const quartersBefore: string[] = [];
  if (takeYear) for (let q = 1; q <= 4; q++) if (quarterRange(year, q).to < start) quartersBefore.push(`${year}-${q}`);

  // balans op de startdatum = beginsaldo + maanden, per FreeBird-rekening
  const bal = new Map<string, { code: string | null; label: string; cents: number }>();
  for (const e of [opening, ...months].filter(Boolean) as PlanEntry[]) {
    for (const l of e.lines) {
      const k = l.code ?? `?${l.mbLedgerId}`;
      const b = bal.get(k) ?? { code: l.code, label: l.label, cents: 0 };
      b.cents += l.cents; bal.set(k, b);
    }
  }

  return {
    start, year, takeYear, canTakeYear, warnings, opening, months, openSales, openPurchases, salesFromStart, purchasesFromStart, journalsFromStart, quartersBefore,
    neededLedger: [...needed].map((id) => ({ id, name: labelOf(id), type: ledger.get(id)?.account_type ?? "?", code: codeOf(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    neededTax: [...neededTaxIds].map((id) => ({ id, name: tax.get(id)?.name ?? id, percentage: tax.get(id)?.percentage ?? "?", type: tax.get(id)?.tax_rate_type ?? "?", code: st.taxMap?.[id] ?? null })),
    balanceAtStart: [...bal.values()].filter((b) => b.cents !== 0).sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~")),
  };
}

// ---------- koppeling ----------

/** Laat de AI de Moneybird-rekeningen en -tarieven koppelen aan FreeBird. Bestaande keuzes blijven staan. */
export async function suggestMapping() {
  const plan = await buildPlan();
  const st = await getSetting("moneybird");
  const [accs, codes] = await Promise.all([db.select().from(accounts).where(eq(accounts.active, true)), db.select().from(vatCodes).where(eq(vatCodes.active, true))]);
  const { ledger } = await refs();
  const todoLedger = plan.neededLedger.filter((l) => !l.code);
  const todoTax = plan.neededTax.filter((t) => !t.code);
  if (!todoLedger.length && !todoTax.length) return { ledger: 0, tax: 0 };
  const res = await aiJson<{ ledger?: Record<string, string>; tax?: Record<string, string> }>({
    system: `Je zet een Nederlandse boekhouding over van Moneybird naar FreeBird. Koppel elke Moneybird-grootboekrekening aan de best passende FreeBird-rekening, en elk Moneybird-BTW-tarief aan een FreeBird-BTW-code.
Regels: bankrekeningen → 1000; debiteuren → 1100; crediteuren → 1600; af te dragen/te betalen omzetbelasting → 1550 (of 1500/1510 voor hoog/laag als het om BTW op verkopen gaat); voorbelasting → 1530; verlegde BTW → 1520; eigen vermogen/kapitaal → 0900; privé-opnamen → 0920; privé-stortingen → 0910; kruisposten, tussenrekeningen en onbekend → 1900.
Past er geen FreeBird-rekening goed bij een kosten- of omzetrekening, gebruik dan "new" (dan maakt FreeBird een rekening met dezelfde naam).
BTW: verkoop 21% → V21, 9% → V9, 0% of vrijgesteld → V0, verlegd binnenland → VERL_NL, EU-ondernemer diensten → ICP_S, goederen → ICP_G, buiten EU → NONEU_S of EXPORT; inkoop 21% → I21, 9% → I9, verlegd EU → RC_EU, verlegd buiten EU → RC_NONEU, verlegd binnenland → RC_NL, geen BTW → NONE. Verkooptarieven alleen op verkoopcodes, inkooptarieven alleen op inkoopcodes.
Antwoord met een json-object: {"ledger":{"<moneybird-id>":"<code of new>"},"tax":{"<moneybird-id>":"<btw-code>"}}`,
    user: [
      "FreeBird-rekeningen:", ...accs.map((a) => `${a.code} ${a.name} (${a.type})`),
      "", "FreeBird-BTW-codes:", ...codes.map((c) => `${c.code} ${c.name} (${c.direction})`),
      "", "Moneybird-rekeningen (id, code, naam, soort):", ...todoLedger.map((l) => `${l.id} ${ledger.get(l.id)?.account_id ?? ""} ${l.name} (${l.type})`),
      "", "Moneybird-BTW-tarieven (id, naam, percentage, soort, land):", ...todoTax.map((t) => `${t.id} ${t.name} ${t.percentage}% ${t.type}`),
    ].join("\n"),
    maxTokens: 3000,
  });
  const accSet = new Set(accs.map((a) => a.code));
  const codeRows = new Map(codes.map((c) => [c.code, c]));
  const ledgerMap = { ...(st.ledgerMap ?? {}) };
  const taxMap = { ...(st.taxMap ?? {}) };
  let nl = 0, nt = 0;
  for (const l of todoLedger) {
    const v = res.ledger?.[l.id];
    if (v === "new" && PL_TYPES.has(l.type)) { ledgerMap[l.id] = "new"; nl++; }
    else if (v && accSet.has(v)) { ledgerMap[l.id] = v; nl++; }
  }
  for (const t of todoTax) {
    const v = res.tax?.[t.id];
    const row = v ? codeRows.get(v) : undefined;
    const want = t.type === "sales_invoice" ? "sale" : t.type === "purchase_invoice" ? "purchase" : null;
    if (row && row.code !== "OSS" && (!want || row.direction === want)) { taxMap[t.id] = v!; nt++; }
  }
  await setSetting("moneybird", { ledgerMap, taxMap });
  return { ledger: nl, tax: nt };
}

export async function saveMapping(ledgerMap: Record<string, string>, taxMap: Record<string, string>) {
  const st = await getSetting("moneybird");
  await setSetting("moneybird", { ledgerMap: { ...(st.ledgerMap ?? {}), ...ledgerMap }, taxMap: { ...(st.taxMap ?? {}), ...taxMap } });
}

/** Vrije code voor een nieuwe rekening, in de reeks die past bij het soort Moneybird-rekening. */
async function createAccountFor(ex: Executor, ref: LedgerRef): Promise<string> {
  const ranges: Record<string, [number, number, "asset" | "liability" | "equity" | "revenue" | "expense"]> = {
    expenses: [4000, 4999, "expense"], direct_costs: [7000, 7999, "expense"], revenue: [8000, 8899, "revenue"], other_income_expenses: [8900, 8999, "revenue"],
  };
  const [from, to, type] = ranges[ref.account_type] ?? [4000, 4999, "expense"];
  const used = new Set((await ex.select({ code: accounts.code }).from(accounts)).map((a) => a.code));
  for (const step of [10, 1]) {
    for (let c = from; c <= to; c += step) {
      const code = String(c).padStart(4, "0");
      if (!used.has(code)) {
        await ex.insert(accounts).values({ code, name: ref.name, type, ibCategory: type === "expense" ? "Andere kosten" : "Netto-omzet" });
        return code;
      }
    }
  }
  throw new LedgerError(`Geen vrije rekeningcode voor ${ref.name}`);
}

// ---------- boeken ----------

export type OvernameResult = { entries: number; invoices: number; receipts: number; evidence: number; skipped: number; quarters: number };

export async function overnameDone(): Promise<boolean> {
  const [r] = await db.select({ n: dsql<number>`count(*)` }).from(journalEntries).where(eq(journalEntries.sourceType, "moneybird"));
  return Number(r.n) > 0 || !!(await getSetting("moneybird")).importedAt;
}

/** Boekt de hele overname in één transactie: lukt het niet, dan is er niets veranderd. */
export async function runOvername(opts: { takeYear: boolean; fileQuarters: string[] }): Promise<OvernameResult> {
  if (await overnameDone()) throw new LedgerError("De overname is al gedaan. Maak hem eerst ongedaan als je hem opnieuw wilt doen.");
  const plan = await buildPlan({ takeYear: opts.takeYear });
  const missingLedger = plan.neededLedger.filter((l) => !l.code);
  const missingTax = plan.neededTax.filter((t) => !t.code);
  if (missingLedger.length || missingTax.length) throw new LedgerError(`Koppel eerst alle rekeningen en tarieven (${missingLedger.length + missingTax.length} open)`);
  if (!plan.opening) throw new LedgerError(plan.warnings[0] ?? "Geen beginsaldo");
  const { ledger, tax } = await refs();
  const st = await getSetting("moneybird");
  const start = plan.start;

  // contacten die nog niet bestaan eerst aanmaken (buiten de transactie: upsert gebruikt de gewone verbinding)
  const docs = await db.select().from(mbItems).where(inArray(mbItems.kind, [...SALES_KINDS, ...PURCHASE_KINDS, "general_journal_document"]));
  const contactByMb = new Map<string, number>();
  for (const c of await db.select({ id: contacts.id, ref: contacts.externalRef }).from(contacts).where(like(contacts.externalRef, "moneybird:%"))) contactByMb.set(c.ref!.slice(10), c.id);
  for (const d of docs) {
    const c = (d.raw as { contact?: MbContact | null }).contact;
    if (d.contactMbId && !contactByMb.has(d.contactMbId) && c) contactByMb.set(d.contactMbId, (await upsertMoneybirdContact({ ...c, id: d.contactMbId })).id);
  }

  // nieuw aangemaakte rekeningen onthouden, zodat ongedaan maken en opnieuw doen ze hergebruikt
  const created: Record<string, string> = {};
  const result = await db.transaction(async (ex) => {
    const res: OvernameResult = { entries: 0, invoices: 0, receipts: 0, evidence: 0, skipped: 0, quarters: 0 };
    const codes = await getVatCodes(ex);
    // "new" omzetten naar echte rekeningen
    const map: Record<string, string> = { ...(st.ledgerMap ?? {}) };
    for (const [id, v] of Object.entries(map)) if (v === "new" && plan.neededLedger.some((l) => l.id === id)) { map[id] = await createAccountFor(ex, ledger.get(id)!); created[id] = map[id]; }
    const acc = (id: string | null, fallback = "1900") => (id ? map[id] ?? fallback : fallback);
    const vatOf = (taxId: string) => codes.get(st.taxMap?.[taxId] ?? "")!;
    const setItem = (id: number, importedAs: string, note: string | null = null) => ex.update(mbItems).set({ importedAs, importNote: note }).where(eq(mbItems.id, id));
    const firstFile = (d: typeof mbItems.$inferSelect, kind?: "pdf" | "attachment") => (d.files as MbFile[]).find((f) => f.fileId && (!kind || f.kind === kind))?.fileId ?? null;

    // 1. beginsaldo en maandtotalen
    for (const e of [plan.opening!, ...plan.months]) {
      const lines = new Map<string, number>();
      for (const l of e.lines) {
        const code = l.mbLedgerId ? acc(l.mbLedgerId) : l.code!;
        lines.set(code, (lines.get(code) ?? 0) + l.cents);
      }
      const pl: PostLine[] = [...lines].filter(([, c]) => c !== 0).map(([accountCode, amountCents]) => ({ accountCode, amountCents }));
      if (pl.length < 2) continue;
      await postEntry(ex, { date: e.date, description: e.description, sourceType: "moneybird", sourceId: e.sourceId, lines: pl });
      res.entries++;
    }

    // 2. kwartalen die al in Moneybird zijn aangegeven
    for (const q of opts.fileQuarters.filter((q) => plan.quartersBefore.includes(q))) {
      const [y, qq] = q.split("-").map(Number);
      await ex.insert(periods).values({ year: y, quarter: qq, status: "filed", filedAt: new Date(), totals: { source: "moneybird" } }).onConflictDoNothing();
      res.quarters++;
    }

    const existingNumbers = new Set((await ex.select({ n: invoices.number }).from(invoices)).map((r) => r.n));
    const invoiceByMb = new Map<string, number>();
    const seq = new Map<number, number>();

    // 3. verkoopfacturen
    for (const d of docs.filter((x) => SALES_KINDS.includes(x.kind) && x.date && x.state !== "draft").sort((a, b) => (a.date! < b.date! ? -1 : 1))) {
      const r = d.raw as SalesRaw;
      const number = d.kind === "external_sales_invoice" ? `EXT-${r.reference ?? d.mbId}` : r.invoice_id ?? `MB-${d.mbId}`;
      const contactId = d.contactMbId ? contactByMb.get(d.contactMbId) : undefined;
      const total = mbCents(r.total_price_incl_tax);
      const before = d.date! < start;
      const paid = paidBefore(r.payments, start);
      if (before && (d.state === "uncollectible" || total - paid === 0)) continue;
      if (existingNumbers.has(number)) { await setItem(d.id, "skipped", `Factuurnummer ${number} bestaat al in FreeBird`); res.skipped++; continue; }
      if ((r.currency ?? "EUR") !== "EUR") { await setItem(d.id, "skipped", `Valuta ${r.currency} wordt niet ondersteund`); res.skipped++; continue; }
      if (!contactId) { await setItem(d.id, "skipped", "Geen klant bij deze factuur"); res.skipped++; continue; }
      const [c] = await ex.select().from(contacts).where(eq(contacts.id, contactId));
      const subtotal = mbCents(r.total_price_excl_tax);
      const lines = (r.details ?? []).map((det, i) => {
        const code = before ? null : vatOf(String(det.tax_rate_id));
        const base = mbCents(det.total_price_excl_tax_with_discount);
        const pct = Number(tax.get(String(det.tax_rate_id))?.percentage ?? 0);
        return {
          position: i, description: det.description || "—", quantity: String(Number(det.amount_decimal ?? det.amount ?? 1) || 1), unitPriceCents: mbCents(det.price),
          vatCode: code?.code ?? (pct === 21 ? "V21" : pct === 9 ? "V9" : "V0"), rateBp: Math.round(pct * 100), accountCode: before ? "8000" : acc(String(det.ledger_account_id), "8000"),
          baseCents: base, vatCents: Math.round((base * pct) / 100),
        };
      });
      let journalEntryId: number | null = null;
      if (!before) {
        // BTW per tarief uit Moneybird zelf (geen eigen afronding), omzet per rekening
        const plines: PostLine[] = [{ accountCode: "1100", amountCents: total, contactId, memo: number }];
        const byAcc = new Map<string, number>();
        for (const l of lines) byAcc.set(l.accountCode, (byAcc.get(l.accountCode) ?? 0) + l.baseCents);
        const baseSum = lines.reduce((s, l) => s + l.baseCents, 0);
        if (baseSum !== subtotal && byAcc.size) { const k = [...byAcc.keys()][0]; byAcc.set(k, byAcc.get(k)! + (subtotal - baseSum)); }
        for (const [code, base] of byAcc) plines.push({ accountCode: code, amountCents: -base, contactId });
        const totals = r.tax_totals?.length ? r.tax_totals : groupTax(r.details ?? [], tax);
        const pvat: PostVat[] = [];
        let vatSum = 0;
        for (const t of totals) {
          const code = vatOf(String(t.tax_rate_id));
          const vat = mbCents(t.tax_amount);
          vatSum += vat;
          plines.push(...vatPostingLines(code, vat, contactId));
          if (code.kind !== "none") pvat.push({ vatCode: code.code, rateBp: code.rateBp ?? Math.round(Number(tax.get(String(t.tax_rate_id))?.percentage ?? 0) * 100), baseCents: mbCents(t.taxable_amount), vatCents: vat, country: c.country, customerKind: c.kind, contactId, vatNumber: c.vatNumber });
        }
        // een paar cent afronding mag op de omzet; meer betekent een BTW-tarief op een code zonder BTW (verkeerde koppeling)
        const diff = plines.reduce((s, l) => s + l.amountCents, 0);
        if (Math.abs(diff) > 2) throw new LedgerError(`Factuur ${number} sluit niet (${diff / 100} euro, BTW in Moneybird ${vatSum / 100}). Controleer de koppeling van de BTW-tarieven.`);
        if (diff !== 0) plines[1].amountCents -= diff;
        journalEntryId = await postEntry(ex, { date: d.date!, description: `Factuur ${number} ${c.name} (Moneybird)`, sourceType: "moneybird", sourceId: `${d.kind}:${d.mbId}`, lines: plines, vat: pvat });
        res.entries++;
      }
      const [inv] = await ex.insert(invoices).values({
        number, contactId, status: "open", issueDate: d.date, dueDate: r.due_date ?? d.date, currency: "EUR", language: r.language?.startsWith("en") ? "en" : "nl",
        reference: r.reference ?? null, subtotalCents: subtotal, vatCents: total - subtotal, totalCents: total, paidCents: before ? paid : 0,
        journalEntryId, pdfFileId: firstFile(d, "pdf") ?? firstFile(d),
        notes: before ? `Uit Moneybird: stond open op ${start}` : "Uit Moneybird",
      }).returning({ id: invoices.id });
      if (lines.length) await ex.insert(invoiceLines).values(lines.map((l) => ({ ...l, invoiceId: inv.id })));
      invoiceByMb.set(d.mbId, inv.id);
      existingNumbers.add(number);
      const m = /^(\d{4})-(\d+)$/.exec(number);
      if (m) seq.set(Number(m[1]), Math.max(seq.get(Number(m[1])) ?? 0, Number(m[2])));
      await setItem(d.id, `invoice:${inv.id}`, before ? `Stond open op ${start}: ${((total - paid) / 100).toFixed(2)} euro` : d.state === "paid" ? "In Moneybird al betaald; de betaling wordt in Bank gekoppeld" : null);
      res.invoices++;
    }
    // creditnota's verrekenen met het origineel
    for (const d of docs.filter((x) => x.kind === "sales_invoice" && (x.raw as SalesRaw).original_sales_invoice_id)) {
      const credit = invoiceByMb.get(d.mbId), orig = invoiceByMb.get(String((d.raw as SalesRaw).original_sales_invoice_id));
      if (!credit || !orig) continue;
      const [ci] = await ex.select().from(invoices).where(eq(invoices.id, credit));
      const [oi] = await ex.select().from(invoices).where(eq(invoices.id, orig));
      const amount = Math.min(-ci.totalCents, oi.totalCents - oi.paidCents);
      await ex.update(invoices).set({ creditOf: orig }).where(eq(invoices.id, credit));
      if (amount > 0) {
        await ex.update(invoices).set({ paidCents: oi.paidCents + amount, status: oi.paidCents + amount >= oi.totalCents ? "credited" : oi.status }).where(eq(invoices.id, orig));
        await ex.update(invoices).set({ paidCents: -amount, status: "paid" }).where(eq(invoices.id, credit));
      }
    }
    // doorlopende nummering: FreeBird gaat verder na het hoogste overgenomen nummer
    for (const [y, n] of seq) {
      await ex.insert(numberSequences).values({ key: `invoice-${y}`, next: n + 1 })
        .onConflictDoUpdate({ target: numberSequences.key, set: { next: dsql`greatest(${numberSequences.next}, ${n + 1})` } });
    }

    // 4. inkoopfacturen en bonnen
    const directBooked = await ex.select({ t: bankTransactions, entryId: reconciliations.journalEntryId }).from(bankTransactions)
      .innerJoin(reconciliations, and(eq(reconciliations.bankTransactionId, bankTransactions.id), eq(reconciliations.targetType, "entry")))
      .where(and(eq(bankTransactions.status, "booked"), dsql`${bankTransactions.amountCents} < 0`, dsql`${bankTransactions.evidenceFileId} is null`));
    const usedTx = new Set<number>();
    for (const d of docs.filter((x) => PURCHASE_KINDS.includes(x.kind) && x.date)) {
      const r = d.raw as DocRaw;
      const total = mbCents(r.total_price_incl_tax);
      const before = d.date! < start;
      const paid = paidBefore(r.payments, start);
      const supplierId = d.contactMbId ? contactByMb.get(d.contactMbId) ?? null : null;
      const fileId = firstFile(d);
      const base = { source: "moneybird", fileId, supplierContactId: supplierId, date: d.date, invoiceNumber: r.reference, totalCents: total,
        parsed: { supplierName: d.contactName ?? undefined, invoiceNumber: r.reference ?? undefined, date: d.date!, totalCents: total, currency: r.currency ?? "EUR" } };
      if (before) {
        if (total - paid <= 0 || d.state === "new") continue;
        const [rc] = await ex.insert(receipts).values({ ...base, status: "booked", paidCents: paid, autoNote: `Uit Moneybird: stond open op ${start}` }).returning({ id: receipts.id });
        await setItem(d.id, `receipt:${rc.id}`, `Stond open op ${start}`);
        res.receipts++;
        continue;
      }
      if ((r.currency ?? "EUR") !== "EUR") { await setItem(d.id, "skipped", `Valuta ${r.currency} wordt niet ondersteund`); res.skipped++; continue; }
      // al direct op de bank geboekt? dan alleen als bewijs koppelen
      const dup = directBooked.find(({ t }) => !usedTx.has(t.id) && -t.amountCents === total && Math.abs(daysBetween(t.date, d.date!)) <= 10);
      if (dup && fileId) {
        usedTx.add(dup.t.id);
        await ex.update(bankTransactions).set({ evidenceFileId: fileId }).where(eq(bankTransactions.id, dup.t.id));
        const [rc] = await ex.insert(receipts).values({ ...base, status: "booked", journalEntryId: dup.entryId, paidCents: total, autoNote: `Uit Moneybird; betaling van ${dup.t.date} was al geboekt, als bewijs gekoppeld` }).returning({ id: receipts.id });
        await setItem(d.id, `evidence:${dup.t.id}`, `Als bewijs gekoppeld bij de betaling van ${dup.t.date} (receipt:${rc.id})`);
        res.evidence++;
        continue;
      }
      if (d.state === "new" || !r.details?.length) {
        const [rc] = await ex.insert(receipts).values({ ...base, status: "parsed", autoNote: "Uit Moneybird, daar nog niet verwerkt: boek hem hier" }).returning({ id: receipts.id });
        await setItem(d.id, `receipt:${rc.id}`, "Nog te boeken");
        res.receipts++;
        continue;
      }
      const entryId = await postPurchase(ex, d, r, { acc, vatOf, tax, supplierId, codes });
      const [rc] = await ex.insert(receipts).values({ ...base, status: "booked", journalEntryId: entryId, paidCents: 0, autoNote: "Uit Moneybird" }).returning({ id: receipts.id });
      await setItem(d.id, `receipt:${rc.id}`);
      res.receipts++; res.entries++;
    }

    // 5. memoriaalboekingen vanaf de startdatum
    for (const d of docs.filter((x) => x.kind === "general_journal_document" && x.date && x.date >= start)) {
      const r = d.raw as JournalRaw;
      if (r.journal_type === "fiscal_year_ending") continue;
      const lines: PostLine[] = r.general_journal_document_entries.map((e) => ({
        accountCode: acc(String(e.ledger_account_id)), amountCents: mbCents(e.debit) - mbCents(e.credit), memo: e.description ?? null,
        contactId: e.contact_id ? contactByMb.get(String(e.contact_id)) ?? null : null,
      }));
      const id = await postEntry(ex, { date: d.date!, description: `Memoriaal ${r.reference ?? d.mbId} (Moneybird)`, sourceType: "moneybird", sourceId: `general_journal_document:${d.mbId}`, lines });
      await setItem(d.id, `entry:${id}`);
      res.entries++;
    }

    await audit("moneybird", "overname", "import", null, res, ex);
    return res;
  });
  await setSetting("moneybird", { importedAt: new Date().toISOString(), ledgerMap: { ...(st.ledgerMap ?? {}), ...created } });
  await runMatching();
  return result;
}

/** BTW per tarief als Moneybird geen tax_totals meegeeft. */
function groupTax(details: Detail[], tax: Map<string, TaxRef>): TaxTotal[] {
  const by = new Map<string, number>();
  for (const d of details) by.set(String(d.tax_rate_id), (by.get(String(d.tax_rate_id)) ?? 0) + mbCents(d.total_price_excl_tax_with_discount));
  return [...by].map(([id, base]) => ({ tax_rate_id: id, taxable_amount: String(base / 100), tax_amount: String(Math.round((base * Number(tax.get(id)?.percentage ?? 0)) / 100) / 100) }));
}

/** Boekt een inkoopfactuur of bon met meerdere regels: kosten per rekening, BTW per tarief, crediteuren voor het totaal. */
async function postPurchase(ex: Executor, d: typeof mbItems.$inferSelect, r: DocRaw, c: {
  acc: (id: string | null, fb?: string) => string; vatOf: (id: string) => VatCodeRow; tax: Map<string, TaxRef>; supplierId: number | null; codes: Map<string, VatCodeRow>;
}) {
  const total = mbCents(r.total_price_incl_tax);
  const excl = mbCents(r.total_price_excl_tax);
  const [sup] = c.supplierId ? await ex.select().from(contacts).where(eq(contacts.id, c.supplierId)) : [];
  const groups = new Map<string, { code: VatCodeRow; base: number; byAcc: Map<string, number> }>();
  for (const det of r.details ?? []) {
    const code = c.vatOf(String(det.tax_rate_id));
    const g = groups.get(code.code) ?? { code, base: 0, byAcc: new Map() };
    const base = mbCents(det.total_price_excl_tax_with_discount);
    g.base += base;
    const a = c.acc(String(det.ledger_account_id), "4800");
    g.byAcc.set(a, (g.byAcc.get(a) ?? 0) + base);
    groups.set(code.code, g);
  }
  // BTW die je betaalt (standaardtarieven) volgt uit totaal min excl; verlegde BTW reken je zelf uit
  const chargedVat = total - excl;
  const charged = [...groups.values()].filter((g) => g.code.kind === "standard");
  const chargedBase = charged.reduce((s, g) => s + g.base, 0);
  const lines: PostLine[] = [];
  const pvat: PostVat[] = [];
  let allocated = 0;
  for (const g of groups.values()) {
    for (const [a, b] of g.byAcc) lines.push({ accountCode: a, amountCents: b, contactId: c.supplierId, memo: r.reference });
    let vat = 0;
    if (g.code.kind === "standard") {
      const isLast = charged[charged.length - 1] === g;
      vat = isLast ? chargedVat - allocated : Math.round((chargedVat * g.base) / (chargedBase || 1));
      allocated += vat;
    } else if (g.code.kind.startsWith("rc_")) vat = Math.round((g.base * (g.code.rateBp ?? 0)) / 10000);
    lines.push(...vatPostingLines(g.code, vat, c.supplierId));
    if (g.code.kind !== "none") pvat.push({ vatCode: g.code.code, rateBp: g.code.rateBp ?? 0, baseCents: g.base, vatCents: vat, country: sup?.country ?? "NL", contactId: c.supplierId, vatNumber: sup?.vatNumber ?? null });
  }
  lines.push({ accountCode: "1600", amountCents: -total, contactId: c.supplierId, memo: r.reference });
  const diff = lines.reduce((s, l) => s + l.amountCents, 0);
  if (Math.abs(diff) > 2) throw new LedgerError(`${d.contactName ?? "Inkoop"} ${r.reference ?? ""} sluit niet (${diff / 100} euro). Er is BTW betaald maar het tarief is gekoppeld aan een code zonder BTW; controleer de koppeling.`);
  if (diff !== 0) lines[0].amountCents -= diff;
  return postEntry(ex, { date: d.date!, description: `Inkoop ${d.contactName ?? ""} ${r.reference ?? ""} (Moneybird)`.replace(/\s+/g, " ").trim(), sourceType: "moneybird", sourceId: `${d.kind}:${d.mbId}`, lines, vat: pvat });
}

/** Maakt de overname ongedaan, zolang er niets op is gebouwd (betalingen gekoppeld of een periode aangegeven). */
export async function undoOvername() {
  await db.transaction(async (ex) => {
    const items = await ex.select().from(mbItems).where(dsql`${mbItems.importedAs} is not null`);
    const invoiceIds = items.filter((i) => i.importedAs!.startsWith("invoice:")).map((i) => Number(i.importedAs!.slice(8)));
    const receiptIds = items.filter((i) => i.importedAs!.startsWith("receipt:")).map((i) => Number(i.importedAs!.slice(8)));
    const evidence = items.filter((i) => i.importedAs!.startsWith("evidence:"));
    const evidenceReceiptIds = evidence.map((i) => Number(/receipt:(\d+)/.exec(i.importNote ?? "")?.[1])).filter(Number.isFinite);
    const linked = invoiceIds.length || receiptIds.length
      ? await ex.select({ n: dsql<number>`count(*)` }).from(reconciliations).where(dsql`(${reconciliations.targetType} = 'invoice' and ${reconciliations.targetId} in ${invoiceIds.length ? invoiceIds : [0]}) or (${reconciliations.targetType} = 'receipt' and ${reconciliations.targetId} in ${receiptIds.length ? receiptIds : [0]})`)
      : [{ n: 0 }];
    if (Number(linked[0].n) > 0) throw new LedgerError("Er zijn al betalingen gekoppeld aan overgenomen facturen of bonnen. Ontkoppel die eerst in Bank.");
    const filed = await ex.select().from(periods).where(eq(periods.status, "filed"));
    if (filed.some((p) => (p.totals as { source?: string } | null)?.source !== "moneybird")) throw new LedgerError("Er is al een BTW-periode in FreeBird aangegeven; de overname kan niet meer terug.");
    for (const e of evidence) await ex.update(bankTransactions).set({ evidenceFileId: null }).where(eq(bankTransactions.id, Number(e.importedAs!.slice(9))));
    if (invoiceIds.length) await ex.delete(invoices).where(inArray(invoices.id, invoiceIds));
    if (receiptIds.length || evidenceReceiptIds.length) await ex.delete(receipts).where(inArray(receipts.id, [...receiptIds, ...evidenceReceiptIds]));
    await ex.delete(journalEntries).where(eq(journalEntries.sourceType, "moneybird"));
    await ex.delete(periods).where(dsql`${periods.totals}->>'source' = 'moneybird'`);
    await ex.update(mbItems).set({ importedAs: null, importNote: null }).where(dsql`${mbItems.importedAs} is not null`);
    await audit("moneybird", "overname", "undo", null, { invoices: invoiceIds.length, receipts: receiptIds.length }, ex);
  });
  await setSetting("moneybird", { importedAt: null as unknown as undefined });
}
