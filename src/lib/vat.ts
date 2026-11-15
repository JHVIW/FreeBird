import { and, eq, gte, lte, inArray, ne, sql as dsql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { vatCodes, vatEntries, fiscalParams } from "@/db/schema";
import type { PostLine, PostVat } from "./ledger";
import { vatOf, splitGross } from "./money";

export type VatCodeRow = typeof vatCodes.$inferSelect;

let cache: Map<string, VatCodeRow> | null = null;
export async function getVatCodes(ex: Executor = db): Promise<Map<string, VatCodeRow>> {
  if (cache && ex === db) return cache;
  const rows = await ex.select().from(vatCodes);
  const m = new Map(rows.map((r) => [r.code, r]));
  if (ex === db) cache = m;
  return m;
}
export function clearVatCache() { cache = null; }

export async function getParam<T>(year: number, key: string, ex: Executor = db): Promise<T | null> {
  const [row] = await ex.select().from(fiscalParams).where(and(eq(fiscalParams.year, year), eq(fiscalParams.key, key)));
  if (row) return row.value as T;
  // val terug op het meest recente jaar ervoor
  const rows = await ex.select().from(fiscalParams).where(and(eq(fiscalParams.key, key), lte(fiscalParams.year, year)))
    .orderBy(dsql`${fiscalParams.year} desc`).limit(1);
  return (rows[0]?.value as T) ?? null;
}

export async function euRate(year: number, country: string, ex: Executor = db): Promise<number> {
  const rates = await getParam<Record<string, number>>(year, "eu_vat_rates_bp", ex);
  const r = rates?.[country.toUpperCase()];
  if (r == null) throw new Error(`Geen BTW-tarief bekend voor ${country} in ${year}. Vul het aan bij Instellingen › Fiscale parameters.`);
  return r;
}

/** Grootboekregels voor de BTW-component van een boeking. Teken: verkoop = credit (negatief). */
export function vatPostingLines(code: VatCodeRow, vatCents: number, contactId?: number | null): PostLine[] {
  if (vatCents === 0) return [];
  if (code.direction === "sale") {
    if (code.kind === "oss") return [{ accountCode: "1540", amountCents: -vatCents, contactId }];
    if (code.kind === "standard") return [{ accountCode: code.rateBp === 900 ? "1510" : "1500", amountCents: -vatCents, contactId }];
    return [];
  }
  if (code.kind === "standard") return [{ accountCode: "1530", amountCents: vatCents, contactId }];
  if (code.kind === "rc_eu" || code.kind === "rc_nonEu" || code.kind === "rc_nl") {
    return [
      { accountCode: "1530", amountCents: vatCents, contactId },
      { accountCode: "1520", amountCents: -vatCents, contactId },
    ];
  }
  return [];
}

/** Is de BTW onderdeel van wat je betaalt/ontvangt? Bij verlegging niet. */
export function vatIsCharged(code: VatCodeRow): boolean {
  return code.kind === "standard" || code.kind === "oss";
}

/** Berekent basis en BTW voor een inkoop vanuit het betaalde bedrag. */
export function purchaseAmounts(code: VatCodeRow, paidCents: number): { base: number; vat: number } {
  const rate = code.rateBp ?? 0;
  if (code.kind === "standard") return splitGross(paidCents, rate);
  if (code.kind.startsWith("rc_")) return { base: paidCents, vat: vatOf(paidCents, rate) };
  return { base: paidCents, vat: 0 };
}

export { determineSaleVat, type Customer, type SupplyType } from "./vat-rules";

/** Grensoverschrijdende B2C-omzet binnen de EU (excl. NL) voor de OSS-drempel. */
export async function ossTurnover(year: number, ex: Executor = db): Promise<number> {
  const [r] = await ex.select({ s: dsql<string>`coalesce(sum(${vatEntries.baseCents}),0)` }).from(vatEntries).where(and(
    gte(vatEntries.date, `${year}-01-01`), lte(vatEntries.date, `${year}-12-31`),
    eq(vatEntries.customerKind, "consumer"), ne(vatEntries.country, "NL"),
    inArray(vatEntries.vatCode, ["V21", "V9", "OSS"]),
  ));
  return Number(r.s);
}

export type OssStatus = { year: number; threshold: number; previousYear: number; currentYear: number; activeAllYear: boolean };

export async function ossStatus(year: number, ex: Executor = db): Promise<OssStatus> {
  const threshold = (await getParam<number>(year, "oss_threshold_cents", ex)) ?? 1_000_000;
  const previousYear = await ossTurnover(year - 1, ex);
  const currentYear = await ossTurnover(year, ex);
  return { year, threshold, previousYear, currentYear, activeAllYear: previousYear > threshold };
}

/** Geldt OSS voor een nieuwe B2C-verkoop met deze basis? Ook de verkoop die de drempel overschrijdt valt eronder. */
export function ossAppliesTo(status: OssStatus, baseCents: number): boolean {
  return status.activeAllYear || status.currentYear > status.threshold || status.currentYear + baseCents > status.threshold;
}

/** Bouwt de BTW-regel voor vat_entries. */
export function vatEntry(code: VatCodeRow, rateBp: number, base: number, vat: number, x: Omit<PostVat, "vatCode" | "rateBp" | "baseCents" | "vatCents">): PostVat {
  return { vatCode: code.code, rateBp, baseCents: base, vatCents: vat, ...x };
}
