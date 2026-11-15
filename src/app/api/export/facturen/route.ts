import { and, asc, eq, ne, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { invoices, contacts } from "@/db/schema";
import { toCsv, centsNl, csvResponse } from "@/lib/csv";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const year = Number(new URL(req.url).searchParams.get("year") ?? new Date().getFullYear());
  const rows = await db.select({ i: invoices, c: contacts }).from(invoices).innerJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(and(ne(invoices.status, "draft"), dsql`extract(year from ${invoices.issueDate}::date) = ${year}`)).orderBy(asc(invoices.number));
  const csv = toCsv([
    ["Nummer", "Datum", "Vervaldatum", "Klant", "Land", "BTW-nummer", "Excl. BTW", "BTW", "Totaal", "Betaald", "Status"],
    ...rows.map(({ i, c }) => [i.number, i.issueDate, i.dueDate, c.name, c.country, c.vatNumber, centsNl(i.subtotalCents), centsNl(i.vatCents), centsNl(i.totalCents), centsNl(i.paidCents), i.status]),
  ]);
  return csvResponse(`facturen-${year}.csv`, csv);
}
