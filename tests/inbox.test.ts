import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { bankAccounts, bankTransactions, receipts } from "@/db/schema";
import { resetDb, makeContact } from "./db";
import { ingestReceipt, guessVatCode, htmlToText, bookReceipt } from "@/lib/receipts";
import { bookDirect } from "@/lib/bank";
import { setSetting } from "@/lib/settings";

/** Nep-DeepSeek die steeds hetzelfde uitgelezen resultaat teruggeeft. */
function fakeOcr(result: object) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 })));
}

let bankId: number;
let seq = 9000;
async function tx(date: string, amountCents: number, name: string) {
  const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: seq++, date, amountCents, counterpartyName: name, description: "" }).returning();
  return t;
}
const mail = (key: string) => ({ source: "mail" as const, sourceKey: key, from: "billing@example.com", subject: "Invoice" });

beforeAll(async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DATA_DIR = "/tmp/freebird-test-data";
  await resetDb();
  await setSetting("mail", { autoBook: true });
  const [b] = await db.insert(bankAccounts).values({ bunqAccountId: 1, iban: "NL32BUNQ2000000003", name: "Bank" }).returning();
  bankId = b.id;
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await sql.end(); });

describe("factuur-inbox", () => {
  it("raadt de BTW-code", () => {
    expect(guessVatCode({ supplierCountry: "DE", vatLines: [] })).toBe("RC_EU");
    expect(guessVatCode({ supplierCountry: "US" })).toBe("RC_NONEU");
    expect(guessVatCode({ supplierCountry: "NL", vatLines: [{ rateBp: 2100, baseCents: 100, vatCents: 21 }] })).toBe("I21");
    expect(guessVatCode({ supplierCountry: "NL", vatLines: [{ rateBp: 900, baseCents: 100, vatCents: 9 }] })).toBe("I9");
    expect(htmlToText("<style>x{}</style><p>Totaal&nbsp;&euro;12,10</p><script>alert(1)</script>")).toBe("Totaal €12,10");
  });

  it("boekt een factuur van een bekende leverancier automatisch en koppelt de open betaling", async () => {
    const hetzner = await makeContact({ name: "Hetzner Online GmbH", country: "DE", isSupplier: true, isCustomer: false });
    // eerdere boeking leert de rekening
    const [old] = await db.insert(receipts).values({ source: "upload", status: "parsed" }).returning();
    await bookReceipt(old.id, { date: "2026-08-01", supplierContactId: hetzner.id, accountCode: "4510", vatCode: "RC_EU", totalCents: 4840 });
    const pay = await tx("2026-09-02", -4840, "Hetzner Online GmbH");
    fakeOcr({ supplierName: "Hetzner Online GmbH", supplierCountry: "DE", invoiceNumber: "R0024418873", date: "2026-09-01", currency: "EUR", totalCents: 4840, vatLines: [], reverseCharge: true, suggestedAccountCode: "4800", isInvoice: true, confidence: 70 });
    const r = await ingestReceipt(Buffer.from("%PDF fake"), "hetzner.pdf", "image/png", mail("m1#0"));
    expect(r.status).toBe("booked");
    expect(r.autoNote).toMatch(/4510 met RC_EU/);
    expect(r.autoNote).toMatch(/betaling.*gekoppeld/);
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, pay.id));
    expect(t.status).toBe("booked");
  });

  it("koppelt alleen als bewijs als de betaling al direct geboekt is", async () => {
    const t = await tx("2026-09-05", -2000, "GitHub, Inc.");
    await bookDirect(t.id, { accountCode: "4520", vatCode: "RC_NONEU" });
    fakeOcr({ supplierName: "GitHub, Inc.", supplierCountry: "US", date: "2026-09-04", currency: "EUR", totalCents: 2000, suggestedAccountCode: "4520", isInvoice: true, confidence: 95 });
    const r = await ingestReceipt(Buffer.from("x"), "gh.png", "image/png", mail("m2#0"));
    expect(r.status).toBe("booked");
    expect(r.autoNote).toMatch(/als bewijs/);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.evidenceFileId).toBe(r.fileId);
    // geen tweede kostenboeking
    expect(r.journalEntryId).not.toBeNull();
  });

  it("boekt niet automatisch bij een onbekende leverancier met weinig zekerheid", async () => {
    fakeOcr({ supplierName: "Vage Winkel", date: "2026-09-10", totalCents: 1234, isInvoice: true, confidence: 60 });
    const r = await ingestReceipt(Buffer.from("x"), "vaag.png", "image/png", mail("m3#0"));
    expect(r.status).toBe("parsed");
    expect(r.autoNote).toMatch(/niet zeker genoeg/);
  });

  it("slaat mails over die geen factuur zijn", async () => {
    fakeOcr({ isInvoice: false });
    const r = await ingestReceipt(Buffer.from("Nieuwsbrief: onze zomeractie is begonnen, bekijk de aanbiedingen"), "news.txt", "text/plain", mail("m4#body"));
    expect(r.status).toBe("ignored");
  });

  it("boekt geen uploads automatisch", async () => {
    fakeOcr({ supplierName: "Hetzner Online GmbH", date: "2026-09-12", totalCents: 999, isInvoice: true, confidence: 99, suggestedAccountCode: "4510" });
    const r = await ingestReceipt(Buffer.from("x"), "upload.png", "image/png", { source: "upload" });
    expect(r.status).toBe("parsed");
  });
});
