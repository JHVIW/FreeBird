import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { accounts, journalEntries, journalLines, vatEntries, periods } from "@/db/schema";
import { quarterOf } from "./dates";

export class LedgerError extends Error {}
export class PeriodLockedError extends LedgerError {}

export type PostLine = { accountCode: string; amountCents: number; contactId?: number | null; memo?: string | null };
export type PostVat = {
  vatCode: string; rateBp: number; baseCents: number; vatCents: number; country: string;
  customerKind?: "business" | "consumer" | null; contactId?: number | null; vatNumber?: string | null; countryEvidence?: unknown;
};
export type PostEntry = {
  date: string; description: string; sourceType: string; sourceId?: string | number | null;
  lines: PostLine[]; vat?: PostVat[]; reversalOf?: number | null;
  /** Alleen voor de BTW-afsluitboeking van een periode die op dat moment wordt vergrendeld. */
  allowLockedPeriod?: boolean;
};

export async function assertPeriodOpen(ex: Executor, date: string) {
  const { year, quarter } = quarterOf(date);
  const [p] = await ex.select().from(periods).where(and(eq(periods.year, year), eq(periods.quarter, quarter)));
  if (p?.status === "filed") throw new PeriodLockedError(`Q${quarter} ${year} is aangegeven en vergrendeld. Boek de correctie in een open periode.`);
}

/** Kwartaal dat de Moneybird-overname vergrendelde: de aangifte staat in Moneybird, boekingen zonder BTW veranderen die niet. */
export async function isMoneybirdLocked(ex: Executor, date: string) {
  const { year, quarter } = quarterOf(date);
  const [p] = await ex.select().from(periods).where(and(eq(periods.year, year), eq(periods.quarter, quarter)));
  return p?.status === "filed" && (p.totals as { source?: string } | null)?.source === "moneybird";
}

/** Boekt een journaalpost. Moet binnen een transactie worden aangeroepen als er meer gebeurt. */
export async function postEntry(ex: Executor, e: PostEntry): Promise<number> {
  const lines = e.lines.filter((l) => l.amountCents !== 0);
  if (lines.length < 2) throw new LedgerError("Een boeking heeft minstens twee regels nodig");
  for (const l of lines) if (!Number.isInteger(l.amountCents)) throw new LedgerError("Bedragen moeten hele centen zijn");
  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== 0) throw new LedgerError(`Boeking is niet in balans (verschil ${sum} cent)`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new LedgerError("Ongeldige datum");
  if (!e.allowLockedPeriod) await assertPeriodOpen(ex, e.date);

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accs = await ex.select().from(accounts).where(inArray(accounts.code, codes));
  const byCode = new Map(accs.map((a) => [a.code, a]));
  for (const c of codes) if (!byCode.has(c)) throw new LedgerError(`Onbekende grootboekrekening ${c}`);

  const [entry] = await ex.insert(journalEntries).values({
    date: e.date, description: e.description, sourceType: e.sourceType,
    sourceId: e.sourceId == null ? null : String(e.sourceId), reversalOf: e.reversalOf ?? null,
  }).returning({ id: journalEntries.id });

  await ex.insert(journalLines).values(lines.map((l) => ({
    entryId: entry.id, accountId: byCode.get(l.accountCode)!.id, amountCents: l.amountCents, contactId: l.contactId ?? null, memo: l.memo ?? null,
  })));

  const vats = (e.vat ?? []).filter((v) => v.baseCents !== 0 || v.vatCents !== 0);
  if (vats.length) {
    await ex.insert(vatEntries).values(vats.map((v) => ({
      entryId: entry.id, date: e.date, vatCode: v.vatCode, rateBp: v.rateBp, baseCents: v.baseCents, vatCents: v.vatCents,
      country: v.country, customerKind: v.customerKind ?? null, contactId: v.contactId ?? null, vatNumber: v.vatNumber ?? null,
      countryEvidence: v.countryEvidence ?? null,
    })));
  }
  return entry.id;
}

/** Tegenboeking op een (open) datum. Kopieert ook de BTW-regels met omgekeerd teken. */
export async function reverseEntry(ex: Executor, entryId: number, date: string, description?: string): Promise<number> {
  const [orig] = await ex.select().from(journalEntries).where(eq(journalEntries.id, entryId));
  if (!orig) throw new LedgerError("Boeking niet gevonden");
  const ls = await ex.select({ l: journalLines, code: accounts.code }).from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId)).where(eq(journalLines.entryId, entryId));
  const vs = await ex.select().from(vatEntries).where(eq(vatEntries.entryId, entryId));
  return postEntry(ex, {
    date, description: description ?? `Tegenboeking: ${orig.description}`, sourceType: orig.sourceType, sourceId: orig.sourceId,
    reversalOf: entryId,
    lines: ls.map(({ l, code }) => ({ accountCode: code, amountCents: -l.amountCents, contactId: l.contactId, memo: l.memo })),
    vat: vs.map((v) => ({
      vatCode: v.vatCode, rateBp: v.rateBp, baseCents: -v.baseCents, vatCents: -v.vatCents, country: v.country,
      customerKind: v.customerKind, contactId: v.contactId, vatNumber: v.vatNumber, countryEvidence: v.countryEvidence,
    })),
  });
}
