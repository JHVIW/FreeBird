/**
 * Vult een LEGE database met voorbeelddata om FreeBird te bekijken. Niet op je echte administratie draaien.
 * Gebruik: DATABASE_URL=... npx tsx scripts/demo-data.ts
 */
import { sql as dsql } from "drizzle-orm";
import { db, sql } from "../src/db";
import { contacts, bankAccounts, bankTransactions, receipts, rules, timeEntries, assets } from "../src/db/schema";
import { setSetting } from "../src/lib/settings";
import { saveDraft, finalizeInvoice } from "../src/lib/invoices";
import { runMatching, bookSale, bookDirect } from "../src/lib/bank";
import { bookReceipt } from "../src/lib/receipts";
import { postEntry } from "../src/lib/ledger";
import { runDepreciation } from "../src/lib/reports";

async function main() {
  const [{ n }] = (await db.execute(dsql`select count(*)::int as n from journal_entries`)) as unknown as Array<{ n: number }>;
  if (n > 0) throw new Error("Database is niet leeg; demo-data alleen op een lege database");

  await setSetting("company", { name: "Studio Zwaluw", address: "Voorbeeldstraat 1", postcode: "3511 AA", city: "Utrecht", country: "NL", kvk: "00000000", vatNumber: "NL000000000B01", iban: "NL86BUNQ2000000001", email: "hallo@studiozwaluw.example" });
  await setSetting("general", { openingDate: "2026-01-01" });
  await postEntry(db, { date: "2026-01-01", description: "Beginbalans", sourceType: "opening", lines: [{ accountCode: "1000", amountCents: 420000 }, { accountCode: "0900", amountCents: -420000 }] });

  const [pix] = await db.insert(contacts).values({ name: "Pixelforge B.V.", country: "NL", address: "Havenweg 4", postcode: "3011 AA", city: "Rotterdam", vatNumber: "NL859123456B01", viesValid: true, viesCheckedAt: new Date(), email: "finance@pixelforge.example", ibans: ["NL02ABNA0123456789"] }).returning();
  const [nord] = await db.insert(contacts).values({ name: "Nordlicht GmbH", country: "DE", address: "Speicherstadt 12", postcode: "20457", city: "Hamburg", vatNumber: "DE298765431", viesValid: true, viesCheckedAt: new Date(), email: "buchhaltung@nordlicht.example", defaultVatCode: "ICP_S", defaultAccountCode: "8100" }).returning();
  const [ver] = await db.insert(contacts).values({ name: "Studio Verhoef", country: "NL", address: "Markt 9", postcode: "5611 AA", city: "Eindhoven", vatNumber: "NL004433221B02", viesValid: true, email: "hallo@verhoef.example" }).returning();
  const [hollow] = await db.insert(contacts).values({ name: "Hollow Tree Games", country: "US", address: "1 Main St", postcode: "97201", city: "Portland", email: "ap@hollowtree.example", defaultVatCode: "NONEU_S", defaultAccountCode: "8200" }).returning();
  const consumers = await db.insert(contacts).values([
    { name: "M. Schneider", kind: "consumer", country: "DE", ibans: ["DE89370400440532013000"] },
    { name: "L. Dubois", kind: "consumer", country: "FR", ibans: ["FR1420041010050500013M02606"] },
    { name: "J. de Vries", kind: "consumer", country: "NL", ibans: ["NL91ABNA0417164300"] },
    { name: "K. Nowak", kind: "consumer", country: "PL", ibans: ["PL61109010140000071219812874"] },
  ]).returning();
  await db.insert(contacts).values([{ name: "Hetzner Online GmbH", isCustomer: false, isSupplier: true, country: "DE", vatNumber: "DE812871812" }, { name: "Drukkerij Print & Co", isCustomer: false, isSupplier: true, country: "NL" }]);

  const inv = async (contactId: number, date: string, lines: { d: string; q: number; p: number; vat: string; acc: string }[]) => {
    const id = await saveDraft({ contactId, issueDate: date, lines: lines.map((l) => ({ description: l.d, quantity: l.q, unitPriceCents: l.p, vatCode: l.vat, accountCode: l.acc })) });
    await finalizeInvoice(id);
    return id;
  };
  await inv(pix.id, "2026-07-04", [{ d: "Maatwerk dashboard, juli", q: 10, p: 10000, vat: "V21", acc: "8000" }]);
  await inv(hollow.id, "2026-07-28", [{ d: "Mobile app MVP, sprint 3", q: 1, p: 112000, vat: "NONEU_S", acc: "8200" }]);
  await inv(nord.id, "2026-08-14", [{ d: "API-integratie Q3", q: 1, p: 140000, vat: "ICP_S", acc: "8100" }]);
  await inv(pix.id, "2026-08-19", [{ d: "Maatwerk dashboard, augustus", q: 15, p: 10000, vat: "V21", acc: "8000" }]);
  await inv(nord.id, "2026-09-11", [{ d: "Webshop-koppeling, september", q: 1, p: 160000, vat: "ICP_S", acc: "8100" }, { d: "Hosting en onderhoud", q: 1, p: 85000, vat: "ICP_S", acc: "8100" }]);
  await inv(ver.id, "2026-09-15", [{ d: "Productfotografie (12 producten)", q: 12, p: 4167, vat: "V21", acc: "8400" }]);
  await db.insert(contacts).values({ name: "Bloemenzaak De Linde", country: "NL", email: "info@delinde.example" });

  const [bank] = await db.insert(bankAccounts).values({ bunqAccountId: 999001, iban: "NL86BUNQ2000000001", name: "Zakelijk" }).returning();
  let pid = 1;
  const tx = (date: string, amountCents: number, counterpartyName: string, counterpartyIban: string | null, description: string) =>
    db.insert(bankTransactions).values({ bankAccountId: bank.id, bunqPaymentId: pid++, date, amountCents, counterpartyName, counterpartyIban, description }).returning().then((r) => r[0]);

  await tx("2026-07-20", 121000, "Pixelforge B.V.", "NL02ABNA0123456789", "Factuur 2026-0001");
  await tx("2026-08-20", 112000, "Hollow Tree Games", "US00HOLLOW", "INV 2026-0002");
  await tx("2026-09-03", 140000, "Nordlicht GmbH", "DE44500105175407324931", "Rechnung 2026-0003");
  await tx("2026-09-27", 245000, "Nordlicht GmbH", "DE44500105175407324931", "Inv 2026-0005 Nordlicht");
  await runMatching();

  const sales: [string, number, number][] = [["2026-07-02", 0, 5988], ["2026-07-15", 1, 5988], ["2026-08-03", 2, 999], ["2026-08-21", 3, 5988], ["2026-09-05", 0, 999], ["2026-09-18", 1, 5988], ["2026-09-25", 2, 5988]];
  for (const [d, ci, amt] of sales) {
    const c = consumers[ci];
    const t = await tx(d, amt, c.name, c.ibans[0], `WEB-ORD-${20000 + pid}`);
    await bookSale(t.id, c.id);
  }
  for (const m of ["07", "08", "09"]) {
    const t = await tx(`2026-${m}-01`, -4840, "Hetzner Online GmbH", "DE92760400610123456700", `Rechnung R00244${m}`);
    await bookDirect(t.id, { accountCode: "4510", vatCode: "RC_EU" });
    const k = await tx(`2026-${m}-15`, -3500, "KPN B.V.", "NL23INGB0000012345", "Mobiel abonnement");
    await bookDirect(k.id, { accountCode: "4600", vatCode: "I21" });
  }
  const a = await tx("2026-09-16", -8612, "Anthropic, PBC", null, "Claude API usage");
  await bookDirect(a.id, { accountCode: "4520", vatCode: "RC_NONEU" });
  await tx("2026-09-25", -2385, "Albert Heijn 1712", null, "Pinautomaat Utrecht");
  await tx("2026-09-28", -4840, "Hetzner Online GmbH", "DE92760400610123456700", "Rechnung R0024418873");
  await tx("2026-09-22", -6497, "Drukkerij Print & Co", "NL21RABO0312445567", "Order 88214");
  await tx("2026-09-29", 5988, "M. Schneider", "DE89370400440532013000", "WEB-ORD-20931");

  await db.insert(rules).values([
    { name: "Hetzner → Hosting", match: { counterpartyContains: "hetzner", direction: "out" }, action: { kind: "book", accountCode: "4510", vatCode: "RC_EU" }, autoApply: false, hits: 14 },
    { name: "KPN → Telefoon", match: { counterpartyContains: "kpn", direction: "out" }, action: { kind: "book", accountCode: "4600", vatCode: "I21" }, autoApply: true, hits: 9 },
    { name: "Webshop-verkopen", match: { descriptionContains: "WEB-ORD", direction: "in" }, action: { kind: "sale", accountCode: "8300" }, autoApply: false, hits: 38 },
  ]);

  const [r1] = await db.insert(receipts).values({ source: "mail", fromAddress: "orders@printenco.example", subject: "Je factuur 88214", status: "parsed", date: "2026-09-22", invoiceNumber: "88214", totalCents: 6497, parsed: { supplierName: "Drukkerij Print & Co", supplierCountry: "NL", invoiceNumber: "88214", date: "2026-09-22", totalCents: 6497, vatLines: [{ rateBp: 2100, baseCents: 5369, vatCents: 1128 }], description: "Visitekaartjes en flyers", suggestedAccountCode: "7000" } }).returning();
  void r1;
  const [r2] = await db.insert(receipts).values({ source: "upload", status: "parsed" }).returning();
  await bookReceipt(r2.id, { date: "2026-08-12", supplierName: "Coolblue", invoiceNumber: "CB-55120", accountCode: "0200", vatCode: "I21", totalCents: 145079, description: "MacBook Pro", asset: { months: 36, residualCents: 0 } });
  const p = await tx("2026-08-12", -145079, "Coolblue B.V.", null, "CB-55120");
  await runMatching({ autoApply: false });
  void p;
  await db.insert(receipts).values({ source: "mail", fromAddress: "noreply@bol.example", subject: "Factuur 4420019", status: "parsed", date: "2026-09-20", invoiceNumber: "4420019", totalCents: 3999, parsed: { supplierName: "Bol.com", supplierCountry: "NL", invoiceNumber: "4420019", date: "2026-09-20", totalCents: 3999, vatLines: [{ rateBp: 2100, baseCents: 3305, vatCents: 694 }], description: "USB-hub", suggestedAccountCode: "4620" } });

  for (const [d, h] of [["2026-07-06", 8], ["2026-07-13", 9.5], ["2026-08-10", 12], ["2026-09-07", 10], ["2026-09-21", 11]] as const) {
    await db.insert(timeEntries).values({ date: d, minutes: Math.round(h * 60), note: "Week" });
  }
  void assets;
  await runDepreciation("2026-09");
  await runMatching();
  console.log("Demo-data geladen");
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
