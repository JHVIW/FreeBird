import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { bankAccounts, bankTransactions, invoices, receipts, journalLines, vatEntries } from "@/db/schema";
import { resetDb, makeContact } from "./db";
import { saveDraft, finalizeInvoice, createCreditNote } from "@/lib/invoices";
import { runMatching, bookSale, bookDirect, bookToReceipt, unbook } from "@/lib/bank";
import { bookReceipt } from "@/lib/receipts";
import { vatReturn, icpReport, fileVatPeriod, balanceSheet, profitAndLoss, runDepreciation, accountBalance, ossReport } from "@/lib/reports";
import { postEntry, PeriodLockedError } from "@/lib/ledger";
import { buildUbl } from "@/lib/ubl";
import { getInvoice } from "@/lib/invoices";
import { assets } from "@/db/schema";

let bankId: number;
let txSeq = 1000;
async function tx(date: string, amountCents: number, name: string, iban: string | null, description: string) {
  const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: txSeq++, date, amountCents, counterpartyName: name, counterpartyIban: iban, description }).returning();
  return t;
}

beforeAll(async () => {
  await resetDb();
  const [b] = await db.insert(bankAccounts).values({ bunqAccountId: 1, iban: "NL59BUNQ2000000002", name: "Zakelijk" }).returning();
  bankId = b.id;
});
afterAll(async () => { await sql.end(); });

describe("volledige boekhoudflow", () => {
  let nl: Awaited<ReturnType<typeof makeContact>>, de: Awaited<ReturnType<typeof makeContact>>, consumer: Awaited<ReturnType<typeof makeContact>>;
  let invNl: number, invDe: number;

  it("maakt en finaliseert een NL-factuur met doorlopend nummer", async () => {
    nl = await makeContact({ name: "Pixelforge B.V.", country: "NL", vatNumber: "NL859123456B01", ibans: ["NL02ABNA0123456789"] });
    invNl = await saveDraft({ contactId: nl.id, issueDate: "2026-07-15", lines: [{ description: "Maatwerk", quantity: 10, unitPriceCents: 10000, vatCode: "V21", accountCode: "8000" }] });
    const r = await finalizeInvoice(invNl);
    expect(r.number).toBe("2026-0001");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invNl));
    expect(inv.totalCents).toBe(121000);
    expect(inv.dueDate).toBe("2026-08-14");
    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, inv.journalEntryId!));
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
  });

  it("weigert ICP zonder geldige VIES-controle", async () => {
    de = await makeContact({ name: "Nordlicht GmbH", country: "DE", vatNumber: "DE298765431" });
    const id = await saveDraft({ contactId: de.id, issueDate: "2026-08-01", lines: [{ description: "API", quantity: 1, unitPriceCents: 245000, vatCode: "ICP_S", accountCode: "8100" }] });
    await expect(finalizeInvoice(id)).rejects.toThrow(/VIES/);
    await db.update((await import("@/db/schema")).contacts).set({ viesValid: true }).where(eq((await import("@/db/schema")).contacts.id, de.id));
    const r = await finalizeInvoice(id);
    expect(r.number).toBe("2026-0002");
    invDe = id;
  });

  it("koppelt een betaling automatisch op factuurnummer", async () => {
    await tx("2026-07-20", 121000, "Pixelforge B.V.", "NL02ABNA0123456789", "Factuur 2026-0001");
    const res = await runMatching();
    expect(res.applied).toBe(1);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invNl));
    expect(inv.status).toBe("paid");
  });

  it("boekt een webshopverkoop aan een Duitse particulier met NL-BTW onder de drempel", async () => {
    consumer = await makeContact({ name: "M. Schneider", kind: "consumer", country: "DE" });
    const t = await tx("2026-08-10", 5988, "M. Schneider", "DE89370400440532013000", "WEB-ORD-20931");
    await bookSale(t.id, consumer.id);
    const v = await db.select().from(vatEntries).where(eq(vatEntries.contactId, consumer.id));
    expect(v[0]).toMatchObject({ vatCode: "V21", baseCents: 4949, vatCents: 1039, country: "DE" });
    expect(v[0].countryEvidence).toEqual({ customer: "DE", iban: "DE" });
  });

  it("boekt Hetzner met verlegde BTW (4b)", async () => {
    const t = await tx("2026-09-01", -4840, "Hetzner Online GmbH", "DE92760400610123456700", "R0024418873");
    await bookDirect(t.id, { accountCode: "4510", vatCode: "RC_EU" });
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.status).toBe("booked");
  });

  it("boekt een bon en koppelt de betaling", async () => {
    const [r] = await db.insert(receipts).values({ source: "upload", status: "parsed" }).returning();
    await bookReceipt(r.id, { date: "2026-09-22", supplierName: "Filamentwinkel.nl", invoiceNumber: "88214", accountCode: "7000", vatCode: "I21", totalCents: 6497 });
    const t = await tx("2026-09-22", -6497, "Filamentwinkel.nl", "NL21RABO0312445567", "Order 88214");
    await bookToReceipt(t.id, r.id);
    expect(await accountBalance("1600", "2026-09-30")).toBe(0);
  });

  it("berekent de BTW-aangifte Q3", async () => {
    const r = await vatReturn(2026, 3);
    const get = (c: string) => r.rubrieken.find((x) => x.code === c)!;
    expect(get("1a").baseCents).toBe(100000 + 4949);
    expect(get("1a").vatCents).toBe(21000 + 1039);
    expect(get("3b").baseCents).toBe(245000);
    expect(get("4b")).toMatchObject({ baseCents: 4840, vatCents: 1016 });
    // voorbelasting: bon 6497 incl → 1128 BTW, plus verlegd 1016
    expect(get("5b").vatCents).toBe(1128 + 1016);
    expect(get("5a").vatCents).toBe(22039 + 1016);
    expect(get("5g").vat).toBe(Math.floor(22039 / 100) + Math.floor(1016 / 100) - Math.ceil(2144 / 100));
    const icp = await icpReport(2026, 3);
    expect(icp.totalCents).toBe(245000);
  });

  it("maakt UBL met reverse charge", async () => {
    const d = (await getInvoice(invDe))!;
    const xml = buildUbl({
      number: d.inv.number!, issueDate: d.inv.issueDate!, dueDate: d.inv.dueDate!, deliveryDate: null, reference: null, isCredit: false, currency: "EUR",
      snapshot: d.inv.snapshot as never, lines: d.lines.map((l) => ({ description: l.description, quantity: 1, unitPriceCents: l.unitPriceCents, baseCents: l.baseCents, vatCents: l.vatCents, rateBp: l.rateBp, kind: "icp_services" })),
      subtotalCents: d.inv.subtotalCents, vatCents: 0, totalCents: d.inv.totalCents, paidCents: 0,
    });
    expect(xml).toContain("<cbc:ID>AE</cbc:ID>");
    expect(xml).toContain('schemeID="9930">DE298765431');
    expect(xml).toContain("<cbc:PayableAmount currencyID=\"EUR\">2450.00</cbc:PayableAmount>");
  });

  it("vergrendelt Q3 na indienen en blokkeert boekingen", async () => {
    const before = await vatReturn(2026, 3);
    const res = await fileVatPeriod(2026, 3);
    expect(res.payableCents).toBe(before.payableRounded * 100);
    for (const c of ["1500", "1510", "1520", "1530"]) expect(await accountBalance(c, "2026-09-30")).toBe(0);
    expect(await accountBalance("1550", "2026-09-30")).toBe(-res.payableCents);
    await expect(postEntry(db, { date: "2026-08-01", description: "x", sourceType: "memorial", lines: [{ accountCode: "4800", amountCents: 100 }, { accountCode: "1000", amountCents: -100 }] }))
      .rejects.toBeInstanceOf(PeriodLockedError);
    const t = await tx("2026-10-20", -res.payableCents, "Belastingdienst", "NL86INGB0002445588", "1234567890123456");
    await runMatching({ autoApply: false });
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect((row.suggestions as Array<{ kind: string }>)[0].kind).toBe("vat_payment");
  });

  it("creditnota zet origineel op gecrediteerd", async () => {
    const credit = await createCreditNote(invDe);
    const r = await finalizeInvoice(credit);
    expect(r.number).toBe("2026-0003");
    const [orig] = await db.select().from(invoices).where(eq(invoices.id, invDe));
    expect(orig.status).toBe("credited");
    const q4 = await vatReturn(2026, 4);
    expect(q4.rubrieken.find((x) => x.code === "3b")!.baseCents).toBe(-245000);
  });

  it("schakelt over op OSS boven de drempel", async () => {
    const big = await tx("2026-11-02", 1_250_000, "M. Schneider", "DE89370400440532013000", "groot");
    await bookSale(big.id, consumer.id);
    const after = await tx("2026-11-03", 11900, "M. Schneider", "DE89370400440532013000", "na drempel");
    await bookSale(after.id, consumer.id);
    const v = await db.select().from(vatEntries).where(eq(vatEntries.contactId, consumer.id));
    const last = v.sort((a, b) => a.id - b.id).at(-1)!;
    expect(last).toMatchObject({ vatCode: "OSS", rateBp: 1900, baseCents: 10000, vatCents: 1900 });
    // de verkoop die de drempel overschrijdt valt er zelf ook onder
    expect(v.find((x) => x.baseCents > 1_000_000)!.vatCode).toBe("OSS");
    const oss = await ossReport(2026, 4);
    expect(oss.lines[0]).toMatchObject({ country: "DE", rateBp: 1900 });
  });

  it("ontkoppelen draait de boeking terug", async () => {
    const t = await tx("2026-11-10", -1500, "Albert Heijn", null, "pin");
    await bookDirect(t.id, { accountCode: "4720", vatCode: "I9" });
    await unbook(t.id);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.status).toBe("open");
    expect(await accountBalance("4720", "2026-12-31")).toBe(0);
    await bookDirect(t.id, { accountCode: "0920", vatCode: "NONE" });
  });

  it("afschrijvingen en balans sluiten", async () => {
    const [opening] = [await postEntry(db, { date: "2026-01-01", description: "Beginbalans", sourceType: "opening", lines: [{ accountCode: "1000", amountCents: 500000 }, { accountCode: "0900", amountCents: -500000 }] })];
    expect(opening).toBeGreaterThan(0);
    await db.insert(assets).values({ name: "3D-printer", purchaseDate: "2026-10-05", costCents: 119900, residualCents: 0, months: 36 });
    const r = await runDepreciation("2026-12");
    expect(r.booked).toBe(3);
    expect(await accountBalance("4900", "2026-12-31")).toBe(3 * Math.round(119900 / 36));
    const bs = await balanceSheet("2026-12-31");
    expect(bs.check).toBe(0);
    const pnl = await profitAndLoss("2026-01-01", "2026-12-31");
    expect(pnl.revenueCents).toBeGreaterThan(0);
  });
});
