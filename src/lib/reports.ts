import { and, between, eq, gte, inArray, lte, sql as dsql, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  vatEntries, accounts, journalLines, journalEntries, periods, bankTransactions, invoices, receipts, contacts, assets, assetDepreciations, timeEntries, fiscalParams,
} from "@/db/schema";
import { quarterRange, quarterDeadline } from "./dates";
import { postEntry, LedgerError, isMoneybirdLocked, type PostLine } from "./ledger";
import { ossStatus, getParam } from "./vat";
import { estimateIncomeTax, type IbRates } from "./ib-tax";
import { audit } from "./audit";

export type Rubriek = { code: string; label: string; baseCents: number | null; vatCents: number | null; base: number | null; vat: number | null };

const LABELS: Record<string, string> = {
  "1a": "Leveringen/diensten belast met hoog tarief",
  "1b": "Leveringen/diensten belast met laag tarief",
  "1c": "Leveringen/diensten belast met overige tarieven, behalve 0%",
  "1d": "Privégebruik",
  "1e": "Leveringen/diensten belast met 0% of niet bij u belast",
  "2a": "Leveringen/diensten waarbij de omzetbelasting naar u is verlegd",
  "3a": "Leveringen naar landen buiten de EU (uitvoer)",
  "3b": "Leveringen naar of diensten in landen binnen de EU",
  "3c": "Installatie/afstandsverkopen binnen de EU",
  "4a": "Leveringen/diensten uit landen buiten de EU",
  "4b": "Leveringen/diensten uit landen binnen de EU",
  "5a": "Verschuldigde omzetbelasting",
  "5b": "Voorbelasting",
  "5c": "Subtotaal",
  "5g": "Totaal te betalen / terug te vragen",
};

/** Afronden in je voordeel: verschuldigd omlaag, voorbelasting omhoog. */
const down = (c: number) => Math.floor(c / 100);
const up = (c: number) => Math.ceil(c / 100);

export async function vatTotalsByCode(from: string, to: string) {
  const rows = await db.select({
    code: vatEntries.vatCode, base: dsql<string>`sum(${vatEntries.baseCents})`, vat: dsql<string>`sum(${vatEntries.vatCents})`,
  }).from(vatEntries).where(between(vatEntries.date, from, to)).groupBy(vatEntries.vatCode);
  const m = new Map<string, { base: number; vat: number }>();
  for (const r of rows) m.set(r.code, { base: Number(r.base), vat: Number(r.vat) });
  return m;
}

export async function vatReturn(year: number, quarter: number) {
  const { from, to } = quarterRange(year, quarter);
  const t = await vatTotalsByCode(from, to);
  const g = (...codes: string[]) => codes.reduce((s, c) => ({ base: s.base + (t.get(c)?.base ?? 0), vat: s.vat + (t.get(c)?.vat ?? 0) }), { base: 0, vat: 0 });

  const r1a = g("V21"), r1b = g("V9"), r1e = g("V0", "VERL_NL", "NONEU_S"), r2a = g("RC_NL"), r3a = g("EXPORT"), r3b = g("ICP_S", "ICP_G");
  const r4a = g("RC_NONEU"), r4b = g("RC_EU"), inkoop = g("I21", "I9");

  const row = (code: string, base: number | null, vat: number | null): Rubriek => ({
    code, label: LABELS[code], baseCents: base, vatCents: vat, base: base == null ? null : down(base), vat: vat == null ? null : down(vat),
  });
  const rubrieken: Rubriek[] = [
    row("1a", r1a.base, r1a.vat), row("1b", r1b.base, r1b.vat), row("1c", 0, 0), row("1d", null, 0), row("1e", r1e.base, null),
    row("2a", r2a.base, r2a.vat), row("3a", r3a.base, null), row("3b", r3b.base, null), row("3c", 0, null),
    row("4a", r4a.base, r4a.vat), row("4b", r4b.base, r4b.vat),
  ];
  const owedExact = r1a.vat + r1b.vat + r2a.vat + r4a.vat + r4b.vat;
  const owedRounded = rubrieken.reduce((s, r) => s + (r.vat ?? 0), 0);
  const inputExact = inkoop.vat + r2a.vat + r4a.vat + r4b.vat;
  const inputRounded = up(inputExact);
  rubrieken.push(
    { code: "5a", label: LABELS["5a"], baseCents: null, vatCents: owedExact, base: null, vat: owedRounded },
    { code: "5b", label: LABELS["5b"], baseCents: null, vatCents: inputExact, base: null, vat: inputRounded },
    { code: "5c", label: LABELS["5c"], baseCents: null, vatCents: owedExact - inputExact, base: null, vat: owedRounded - inputRounded },
    { code: "5g", label: LABELS["5g"], baseCents: null, vatCents: owedExact - inputExact, base: null, vat: owedRounded - inputRounded },
  );
  const [p] = await db.select().from(periods).where(and(eq(periods.year, year), eq(periods.quarter, quarter)));
  return {
    year, quarter, from, to, deadline: quarterDeadline(year, quarter), rubrieken,
    payableExactCents: owedExact - inputExact, payableRounded: owedRounded - inputRounded,
    owedExactCents: owedExact, inputExactCents: inputExact, inputCount: await countPurchases(from, to),
    status: p?.status ?? "open", filedAt: p?.filedAt ?? null,
  };
}

async function countPurchases(from: string, to: string) {
  const [r] = await db.select({ n: dsql<number>`count(*)` }).from(vatEntries)
    .where(and(between(vatEntries.date, from, to), inArray(vatEntries.vatCode, ["I21", "I9", "RC_EU", "RC_NONEU", "RC_NL"])));
  return Number(r.n);
}

export async function icpReport(year: number, quarter: number) {
  const { from, to } = quarterRange(year, quarter);
  const rows = await db.select({
    contactId: vatEntries.contactId, vatNumber: vatEntries.vatNumber, country: vatEntries.country, code: vatEntries.vatCode,
    base: dsql<string>`sum(${vatEntries.baseCents})`, name: contacts.name, viesValid: contacts.viesValid,
  }).from(vatEntries).leftJoin(contacts, eq(contacts.id, vatEntries.contactId))
    .where(and(between(vatEntries.date, from, to), inArray(vatEntries.vatCode, ["ICP_S", "ICP_G"])))
    .groupBy(vatEntries.contactId, vatEntries.vatNumber, vatEntries.country, vatEntries.vatCode, contacts.name, contacts.viesValid);
  const lines = rows.map((r) => ({ ...r, base: Number(r.base), type: r.code === "ICP_G" ? "Leveringen" : "Diensten" }));
  return { lines, totalCents: lines.reduce((s, l) => s + l.base, 0) };
}

export async function ossReport(year: number, quarter: number) {
  const { from, to } = quarterRange(year, quarter);
  const status = await ossStatus(year);
  const oss = await db.select({
    country: vatEntries.country, rate: vatEntries.rateBp, base: dsql<string>`sum(${vatEntries.baseCents})`, vat: dsql<string>`sum(${vatEntries.vatCents})`,
  }).from(vatEntries).where(and(between(vatEntries.date, from, to), eq(vatEntries.vatCode, "OSS")))
    .groupBy(vatEntries.country, vatEntries.rateBp).orderBy(asc(vatEntries.country));
  // B2C EU-omzet per land dit jaar (onder én boven de drempel), voor overzicht en bewijs
  const perCountry = await db.select({
    country: vatEntries.country, base: dsql<string>`sum(${vatEntries.baseCents})`, n: dsql<number>`count(*)`,
    mismatches: dsql<number>`count(*) filter (where ${vatEntries.countryEvidence}->>'iban' is not null and ${vatEntries.countryEvidence}->>'iban' <> ${vatEntries.country})`,
  }).from(vatEntries).where(and(
    between(vatEntries.date, `${year}-01-01`, `${year}-12-31`), eq(vatEntries.customerKind, "consumer"), inArray(vatEntries.vatCode, ["V21", "V9", "OSS"]),
    dsql`${vatEntries.country} <> 'NL'`,
  )).groupBy(vatEntries.country).orderBy(dsql`sum(${vatEntries.baseCents}) desc`);
  const rates = (await getParam<Record<string, number>>(year, "eu_vat_rates_bp")) ?? {};
  return {
    status, deadline: quarterDeadline(year, quarter),
    lines: oss.map((r) => ({ country: r.country, rateBp: r.rate, base: Number(r.base), vat: Number(r.vat) })),
    perCountry: perCountry.map((r) => ({ country: r.country, base: Number(r.base), n: Number(r.n), mismatches: Number(r.mismatches), rateBp: rates[r.country] ?? null })),
  };
}

export async function periodChecklist(year: number, quarter: number) {
  const { from, to } = quarterRange(year, quarter);
  const [openTx] = await db.select({ n: dsql<number>`count(*)` }).from(bankTransactions).where(and(eq(bankTransactions.status, "open"), between(bankTransactions.date, from, to)));
  const [drafts] = await db.select({ n: dsql<number>`count(*)` }).from(invoices).where(and(eq(invoices.status, "draft"), between(invoices.issueDate, from, to)));
  const [unbooked] = await db.select({ n: dsql<number>`count(*)` }).from(receipts).where(and(inArray(receipts.status, ["new", "parsed", "error"]), between(receipts.date, from, to)));
  const icp = await icpReport(year, quarter);
  const invalidVies = icp.lines.filter((l) => l.viesValid !== true).length;
  const ret = await vatReturn(year, quarter);
  const r3b = ret.rubrieken.find((r) => r.code === "3b")!;
  return [
    { ok: Number(openTx.n) === 0, label: Number(openTx.n) === 0 ? "Alle banktransacties verwerkt" : `${openTx.n} banktransactie(s) nog niet verwerkt`, href: "/bank" },
    { ok: Number(drafts.n) === 0, label: Number(drafts.n) === 0 ? "Geen concept-facturen in deze periode" : `${drafts.n} concept-factuur/facturen met datum in deze periode`, href: "/facturen?status=draft" },
    { ok: Number(unbooked.n) === 0, label: Number(unbooked.n) === 0 ? "Alle bonnen geboekt" : `${unbooked.n} bon(nen) nog niet geboekt`, href: "/inkoop" },
    { ok: invalidVies === 0, label: invalidVies === 0 ? "BTW-nummers ICP-afnemers geldig in VIES" : `${invalidVies} ICP-afnemer(s) zonder geldige VIES-controle`, href: "/klanten" },
    { ok: icp.totalCents === (r3b.baseCents ?? 0), label: "ICP-opgaaf sluit aan op rubriek 3b", href: "/btw?tab=icp" },
  ];
}

const VAT_ACCOUNTS = ["1500", "1510", "1520", "1530", "1540"];

/** Vergrendelt een kwartaal na indienen en boekt de BTW-saldi naar 'af te dragen'. */
export async function fileVatPeriod(year: number, quarter: number) {
  const ret = await vatReturn(year, quarter);
  if (ret.status === "filed") throw new LedgerError("Deze periode is al vergrendeld");
  const { from, to } = quarterRange(year, quarter);
  const earlier = await db.selectDistinct({
    y: dsql<number>`extract(year from ${vatEntries.date}::date)::int`, q: dsql<number>`extract(quarter from ${vatEntries.date}::date)::int`,
  }).from(vatEntries).where(dsql`${vatEntries.date} < ${from}`);
  const filed = await db.select().from(periods).where(eq(periods.status, "filed"));
  const filedSet = new Set(filed.map((p) => `${p.year}-${p.quarter}`));
  const missing = earlier.filter((e) => !filedSet.has(`${e.y}-${e.q}`));
  if (missing.length) throw new LedgerError(`Vergrendel eerst Q${missing[0].q} ${missing[0].y}: de aangiftes moeten op volgorde.`);
  return db.transaction(async (ex) => {
    const bal = await ex.select({ code: accounts.code, s: dsql<string>`coalesce(sum(${journalLines.amountCents}),0)` })
      .from(journalLines).innerJoin(accounts, eq(accounts.id, journalLines.accountId)).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(inArray(accounts.code, VAT_ACCOUNTS), lte(journalEntries.date, to))).groupBy(accounts.code);
    const lines: PostLine[] = [];
    let total = 0;
    for (const b of bal) {
      const s = Number(b.s);
      if (s === 0) continue;
      lines.push({ accountCode: b.code, amountCents: -s });
      total += s;
    }
    // total < 0 = te betalen (creditsaldo). Afronding naar hele euro's in je voordeel.
    const payableExact = -total;
    const ossPart = -(Number(bal.find((b) => b.code === "1540")?.s ?? 0));
    const payableRounded = ret.payableRounded * 100 + ossPart;
    const diff = payableExact - payableRounded;
    lines.push({ accountCode: "1550", amountCents: -payableRounded });
    if (diff !== 0) lines.push({ accountCode: "8900", amountCents: -diff, memo: "Afronding BTW-aangifte" });
    let entryId: number | null = null;
    if (lines.length > 1) {
      entryId = await postEntry(ex, { date: to, description: `BTW-aangifte Q${quarter} ${year}`, sourceType: "vat_close", sourceId: `${year}-Q${quarter}`, lines });
    }
    await ex.insert(periods).values({ year, quarter, status: "filed", filedAt: new Date(), closingEntryId: entryId, totals: ret.rubrieken })
      .onConflictDoUpdate({ target: [periods.year, periods.quarter], set: { status: "filed", filedAt: new Date(), closingEntryId: entryId, totals: ret.rubrieken } });
    await audit("periods", `${year}-Q${quarter}`, "file", null, { payableRounded, entryId }, ex);
    return { entryId, payableCents: payableRounded };
  });
}

// ---------- Winst-en-verlies en balans ----------

export async function accountBalances(from: string | null, to: string) {
  const conds = [lte(journalEntries.date, to)];
  if (from) conds.push(gte(journalEntries.date, from));
  const rows = await db.select({
    id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, ib: accounts.ibCategory,
    s: dsql<string>`coalesce(sum(${journalLines.amountCents}),0)`,
  }).from(journalLines).innerJoin(accounts, eq(accounts.id, journalLines.accountId)).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conds)).groupBy(accounts.id).orderBy(asc(accounts.code));
  return rows.map((r) => ({ ...r, cents: Number(r.s) }));
}

export async function profitAndLoss(from: string, to: string) {
  const rows = (await accountBalances(from, to)).filter((r) => r.type === "revenue" || r.type === "expense");
  const revenue = rows.filter((r) => r.type === "revenue").map((r) => ({ ...r, cents: -r.cents }));
  const expenses = rows.filter((r) => r.type === "expense");
  const rev = revenue.reduce((s, r) => s + r.cents, 0);
  const exp = expenses.reduce((s, r) => s + r.cents, 0);
  return { revenue, expenses, revenueCents: rev, expenseCents: exp, profitCents: rev - exp };
}

export async function balanceSheet(on: string) {
  const year = on.slice(0, 4);
  const all = await accountBalances(null, on);
  const prior = await profitAndLoss("1900-01-01", `${Number(year) - 1}-12-31`);
  const current = await profitAndLoss(`${year}-01-01`, on);
  const assetsRows = all.filter((r) => r.type === "asset" && r.cents !== 0);
  const liab = all.filter((r) => r.type === "liability" && r.cents !== 0).map((r) => ({ ...r, cents: -r.cents }));
  const equity = all.filter((r) => r.type === "equity" && r.cents !== 0).map((r) => ({ ...r, cents: -r.cents }));
  const totalAssets = assetsRows.reduce((s, r) => s + r.cents, 0);
  const totalLiab = liab.reduce((s, r) => s + r.cents, 0);
  const equityTotal = equity.reduce((s, r) => s + r.cents, 0) + prior.profitCents + current.profitCents;
  return { assets: assetsRows, liabilities: liab, equity, priorResultCents: prior.profitCents, currentResultCents: current.profitCents, totalAssets, totalLiab, equityTotal, check: totalAssets - totalLiab - equityTotal };
}

/** Groepeert W&V en balans naar de posten van de IB-aangifte (winst uit onderneming). */
export async function ibOverview(year: number) {
  const to = `${year}-12-31`;
  const pnl = await profitAndLoss(`${year}-01-01`, to);
  const bs = await balanceSheet(to);
  const group = (rows: { ib: string | null; cents: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.ib ?? "Overig", (m.get(r.ib ?? "Overig") ?? 0) + r.cents);
    return [...m.entries()].map(([label, cents]) => ({ label, cents }));
  };
  const minutes = await hoursForYear(year);
  const hoursCriterion = (await getParam<number>(year, "hours_criterion")) ?? 1225;
  const zelfstandigenaftrek = (await getParam<number>(year, "self_employed_deduction_cents")) ?? 0;
  const mkbBp = (await getParam<number>(year, "mkb_profit_exemption_bp")) ?? 0;
  const hours = Math.floor(minutes / 60);
  const meetsHours = hours >= hoursCriterion;
  // Gemengde kosten (eten, drinken, representatie, relatiegeschenken): 80% aftrekbaar, of alleen boven de drempel.
  // De gunstigste van de twee; zonder drempel-parameter alleen de 80%-regel.
  const mixedAccounts = (await getParam<string[]>(year, "mixed_cost_accounts")) ?? ["4720"];
  const mixedThreshold = await getParam<number>(year, "mixed_cost_threshold_cents");
  const mixedCents = pnl.expenses.filter((e) => mixedAccounts.includes(e.code)).reduce((s, e) => s + e.cents, 0);
  const mixedNonDeductibleCents = Math.max(0, Math.min(Math.round(mixedCents * 0.2), mixedThreshold != null ? Math.min(mixedCents, mixedThreshold) : Infinity));
  const fiscalProfitCents = pnl.profitCents + mixedNonDeductibleCents;
  const afterZa = Math.max(0, fiscalProfitCents - (meetsHours ? zelfstandigenaftrek : 0));
  const mkb = Math.round((afterZa * mkbBp) / 10000);
  const [inv] = await db.select({ s: dsql<string>`coalesce(sum(${assets.costCents}),0)` }).from(assets).where(between(assets.purchaseDate, `${year}-01-01`, to));
  const kiaMin = (await getParam<number>(year, "kia_min_investment_cents")) ?? 0;
  const ibRates = await getParam<IbRates>(year, "ib_rates");
  const taxable = afterZa - mkb;
  // Ander inkomen geldt alleen voor het jaar zelf, dus geen terugval op een eerder jaar.
  const [oi] = await db.select().from(fiscalParams).where(and(eq(fiscalParams.year, year), eq(fiscalParams.key, "other_income_cents")));
  const otherIncomeCents = oi ? Number(oi.value) : 0;
  const tax = ibRates ? estimateIncomeTax(ibRates, fiscalProfitCents, fiscalProfitCents - taxable, taxable, otherIncomeCents) : null;
  return {
    pnl, bs,
    pnlGroups: { revenue: group(pnl.revenue), expenses: group(pnl.expenses) },
    bsGroups: { assets: group(bs.assets), liabilities: group(bs.liabilities) },
    mixedCents, mixedNonDeductibleCents, fiscalProfitCents,
    hours, hoursCriterion, meetsHours, zelfstandigenaftrekCents: meetsHours ? zelfstandigenaftrek : 0, mkbBp, mkbCents: mkb,
    taxableProfitCents: taxable, investmentsCents: Number(inv.s), kiaMinCents: kiaMin, kiaApplies: Number(inv.s) >= kiaMin && kiaMin > 0,
    tax,
  };
}

// ---------- Activa en afschrijvingen ----------

export function monthlyDepreciation(a: { costCents: number; residualCents: number; months: number }) {
  return Math.round((a.costCents - a.residualCents) / a.months);
}

/** Boekt alle nog niet geboekte maandafschrijvingen t/m de opgegeven maand (YYYY-MM). */
export async function runDepreciation(uptoMonth: string) {
  const list = await db.select().from(assets);
  let booked = 0;
  for (const a of list) {
    if (a.disposedAt) continue;
    const done = await db.select().from(assetDepreciations).where(eq(assetDepreciations.assetId, a.id));
    const doneMonths = new Set(done.map((d) => d.month));
    let cum = done.reduce((s, d) => s + d.amountCents, 0);
    const total = a.costCents - a.residualCents;
    const per = monthlyDepreciation(a);
    let [y, m] = a.purchaseDate.slice(0, 7).split("-").map(Number);
    for (let i = 0; i < a.months; i++) {
      const month = `${y}-${String(m).padStart(2, "0")}`;
      if (month > uptoMonth) break;
      if (!doneMonths.has(month) && cum < total) {
        const amt = i === a.months - 1 ? total - cum : Math.min(per, total - cum);
        const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        try {
          await db.transaction(async (ex) => {
            const entryId = await postEntry(ex, {
              date: last, description: `Afschrijving ${a.name} ${month}`, sourceType: "depreciation", sourceId: a.id,
              // afschrijving heeft geen BTW: mag ook in een kwartaal dat via Moneybird is aangegeven
              allowLockedPeriod: await isMoneybirdLocked(ex, last),
              lines: [{ accountCode: "4900", amountCents: amt }, { accountCode: "0210", amountCents: -amt }],
            });
            await ex.insert(assetDepreciations).values({ assetId: a.id, month, amountCents: amt, journalEntryId: entryId });
          });
          cum += amt; booked++;
        } catch (e) {
          if (!(e instanceof LedgerError)) throw e;
        }
      }
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return { booked };
}

export async function assetOverview() {
  const list = await db.select().from(assets).orderBy(asc(assets.purchaseDate));
  const out = [];
  for (const a of list) {
    const [d] = await db.select({ s: dsql<string>`coalesce(sum(${assetDepreciations.amountCents}),0)` }).from(assetDepreciations).where(eq(assetDepreciations.assetId, a.id));
    out.push({ ...a, depreciatedCents: Number(d.s), bookValueCents: a.costCents - Number(d.s), perMonthCents: monthlyDepreciation(a) });
  }
  return out;
}

export async function hoursForYear(year: number) {
  const [r] = await db.select({ s: dsql<string>`coalesce(sum(${timeEntries.minutes}),0)` }).from(timeEntries).where(between(timeEntries.date, `${year}-01-01`, `${year}-12-31`));
  return Number(r.s);
}

export async function monthlyResults(year: number) {
  const rows = await db.select({
    m: dsql<number>`extract(month from ${journalEntries.date}::date)`, type: accounts.type, s: dsql<string>`sum(${journalLines.amountCents})`,
  }).from(journalLines).innerJoin(accounts, eq(accounts.id, journalLines.accountId)).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(between(journalEntries.date, `${year}-01-01`, `${year}-12-31`), inArray(accounts.type, ["revenue", "expense"])))
    .groupBy(dsql`1`, accounts.type);
  const out = Array.from({ length: 12 }, () => ({ revenue: 0, expense: 0 }));
  for (const r of rows) {
    const i = Number(r.m) - 1;
    if (r.type === "revenue") out[i].revenue = -Number(r.s); else out[i].expense = Number(r.s);
  }
  return out;
}

/** Saldo van een grootboekrekening op een datum. */
export async function accountBalance(code: string, on: string) {
  const [r] = await db.select({ s: dsql<string>`coalesce(sum(${journalLines.amountCents}),0)` }).from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId)).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(accounts.code, code), lte(journalEntries.date, on)));
  return Number(r.s);
}
