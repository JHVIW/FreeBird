import { asc, between, eq } from "drizzle-orm";
import { db } from "@/db";
import { journalEntries, journalLines, accounts, contacts } from "@/db/schema";
import { toCsv, centsNl, csvResponse } from "@/lib/csv";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const year = Number(new URL(req.url).searchParams.get("year") ?? new Date().getFullYear());
  const rows = await db.select({ e: journalEntries, l: journalLines, a: accounts, c: contacts.name }).from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId)).innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(contacts, eq(contacts.id, journalLines.contactId))
    .where(between(journalEntries.date, `${year}-01-01`, `${year}-12-31`)).orderBy(asc(journalEntries.date), asc(journalEntries.id), asc(journalLines.id));
  const csv = toCsv([
    ["Boeking", "Datum", "Omschrijving", "Bron", "Rekening", "Rekeningnaam", "Debet", "Credit", "Relatie", "Memo"],
    ...rows.map(({ e, l, a, c }) => [e.id, e.date, e.description, `${e.sourceType}${e.sourceId ? ` ${e.sourceId}` : ""}`, a.code, a.name, l.amountCents > 0 ? centsNl(l.amountCents) : "", l.amountCents < 0 ? centsNl(-l.amountCents) : "", c, l.memo]),
  ]);
  return csvResponse(`journaal-${year}.csv`, csv);
}
