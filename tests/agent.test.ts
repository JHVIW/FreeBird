import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { assets, bankAccounts, bankTransactions, contacts, invoices, journalLines, periods, receipts, vatEntries } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import { resetDb } from "./db";
import { GET as context } from "@/app/api/agent/context/route";
import { GET as list, POST as upload } from "@/app/api/agent/receipts/route";
import { POST as call } from "@/app/api/agent/call/route";
import { POST as runSql } from "@/app/api/agent/sql/route";

const TOKEN = "t".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

function post(content: string, data?: object, headers: Record<string, string> = auth) {
  const fd = new FormData();
  fd.set("file", new File([content], "factuur.pdf", { type: "application/pdf" }));
  if (data) fd.set("data", JSON.stringify(data));
  return upload(new Request("http://x/api/agent/receipts", { method: "POST", body: fd, headers }));
}

function callFn(fn: string, args: unknown[]) {
  return call(new Request("http://x/api/agent/call", { method: "POST", headers: auth, body: JSON.stringify({ fn, args }) }));
}

let bankId: number;
beforeAll(async () => {
  process.env.AGENT_API_TOKEN = TOKEN;
  await resetDb();
  const [b] = await db.insert(bankAccounts).values({ bunqAccountId: 1, iban: "NL32BUNQ2000000003", name: "Bank" }).returning();
  bankId = b.id;
});
afterAll(async () => { await sql.end(); });

describe("agent-API", () => {
  it("weigert zonder geldige token", async () => {
    expect((await context(new Request("http://x/api/agent/context"))).status).toBe(401);
    expect((await post("x", undefined, { authorization: "Bearer fout" })).status).toBe(401);
  });

  it("geeft rekeningen en inkoop-BTW-codes", async () => {
    const j = await (await context(new Request("http://x/api/agent/context", { headers: auth }))).json();
    expect(j.accounts.length).toBeGreaterThan(5);
    expect(j.vatCodes.map((c: { code: string }) => c.code)).toContain("I21");
  });

  it("boekt een factuur met meegestuurde gegevens en koppelt de open betaling", async () => {
    const [pay] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: 1, date: "2026-09-03", amountCents: -12100, counterpartyName: "Coolblue B.V.", description: "" }).returning();
    const res = await post("%PDF coolblue", {
      parsed: { supplierName: "Coolblue B.V.", supplierCountry: "NL", invoiceNumber: "CB-1", date: "2026-09-02", currency: "EUR", totalCents: 12100, vatLines: [{ rateBp: 2100, baseCents: 10000, vatCents: 2100 }] },
      book: { supplierName: "Coolblue B.V.", accountCode: "4800", vatCode: "I21", vatCents: 2100, description: "Toetsenbord" },
    });
    const { receipt } = await res.json();
    expect(res.status).toBe(200);
    expect(receipt.status).toBe("booked");
    expect(receipt.autoNote).toMatch(/via agent-API/);
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, pay.id));
    expect(t.status).toBe("booked");
    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, receipt.journalEntryId));
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
  });

  it("herkent hetzelfde bestand", async () => {
    const j = await (await post("%PDF coolblue", { parsed: { totalCents: 1 } })).json();
    expect(j.duplicate).toBe(true);
    expect((await db.select().from(receipts)).length).toBe(1);
  });

  it("laat een factuur zonder book in Inkoop staan", async () => {
    const { receipt } = await (await post("%PDF los", { parsed: { supplierName: "Iemand", date: "2026-09-05", totalCents: 500 } })).json();
    expect(receipt.status).toBe("parsed");
    const rows = await (await list(new Request("http://x/api/agent/receipts?status=parsed", { headers: auth }))).json();
    expect(rows.map((r: { id: number }) => r.id)).toContain(receipt.id);
  });

  it("corrigeert een directe boeking met rebookDirect en houdt het bewijs", async () => {
    const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: 2, date: "2026-09-03", amountCents: -1753, counterpartyName: "Hetzner Online GmbH", description: "" }).returning();
    await callFn("bookDirect", [t.id, { accountCode: "4510", vatCode: "RC_EU" }]);
    await post("%PDF hetzner", { parsed: { supplierName: "Hetzner Online GmbH", date: "2026-09-02", totalCents: 1753 }, book: { supplierName: "Hetzner Online GmbH", accountCode: "4510", vatCode: "NONE" } });
    const res = await callFn("rebookDirect", [t.id, { accountCode: "4510", vatCode: "I21" }]);
    expect(res.status).toBe(200);
    const { result } = await res.json();
    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, result.entryId));
    expect(lines.find((l) => l.amountCents === 304)).toBeTruthy(); // 21% voorbelasting uit 17,53
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.status).toBe("booked");
    expect(row.evidenceFileId).not.toBeNull();
    const [r] = await db.select().from(receipts).where(eq(receipts.journalEntryId, result.entryId));
    expect(r).toBeTruthy();
  });

  it("kent alleen functies uit de lijst", async () => {
    expect((await callFn("constructor", [])).status).toBe(404);
    expect((await callFn("toString", [])).status).toBe(404);
  });

  it("SQL kan alleen lezen", async () => {
    const q = (query: string) => runSql(new Request("http://x/api/agent/sql", { method: "POST", headers: auth, body: JSON.stringify({ query }) }));
    const ok = await (await q("select count(*)::int as n from receipts")).json();
    expect(ok.rows[0].n).toBeGreaterThan(0);
    expect((await q("delete from receipts")).status).toBe(422);
    expect((await q("select * from settings")).status).toBe(403);
  });

  it("bookDirect gebruikt land en BTW-nummer van de relatie, niet het IBAN-land", async () => {
    const [c] = await db.insert(contacts).values({ name: "CS Virtual Trade Ltd", country: "CY", vatNumber: "CY10389299Q" }).returning();
    const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: 3, date: "2026-08-18", amountCents: 31702, counterpartyName: "PAYPAL", counterpartyIban: "LU89751000135104200E", description: "" }).returning();
    const entryId = await (await callFn("bookDirect", [t.id, { accountCode: "8300", vatCode: "ICP_S", contactId: c.id }])).json().then((j) => j.result);
    const [v] = await db.select().from(vatEntries).where(eq(vatEntries.entryId, entryId));
    expect(v.country).toBe("CY");
    expect(v.vatNumber).toBe("CY10389299Q");
  });

  it("negeert banktransacties van vóór de startdatum en draait hun boekingen terug", async () => {
    const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: 4, date: "2026-03-10", amountCents: 5000, counterpartyName: "Klant", description: "" }).returning();
    await callFn("bookDirect", [t.id, { accountCode: "8300", vatCode: "V21" }]);
    await setSetting("general", { openingDate: "2026-07-01" });
    await db.insert(periods).values({ year: 2026, quarter: 1, status: "filed", filedAt: new Date(), totals: { source: "moneybird" } });
    const dry = (await (await callFn("excludeBeforeOpening", [{}])).json()).result;
    expect(dry).toMatchObject({ dryRun: true, transactions: 1, booked: 1, revenueCents: 4132, temporarilyUnlocks: ["2026-Q1"] });
    expect((await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id)))[0].status).toBe("booked");
    await callFn("excludeBeforeOpening", [{ dryRun: false }]);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.status).toBe("ignored");
    const [s] = await sql<{ s: string }[]>`select coalesce(sum(l.amount_cents),0) s from journal_lines l join journal_entries je on je.id=l.entry_id join accounts a on a.id=l.account_id where a.code='8300' and je.date='2026-03-10'`;
    expect(Number(s.s)).toBe(0);
    const [q1] = await db.select().from(periods).where(eq(periods.quarter, 1));
    expect(q1.status).toBe("filed"); // weer op slot
    await setSetting("general", { openingDate: "2026-01-01" });
  });

  it("staat correcties zonder BTW toe in een door Moneybird vergrendeld kwartaal", async () => {
    await db.insert(periods).values({ year: 2026, quarter: 2, status: "filed", filedAt: new Date(), totals: { source: "moneybird" } }).onConflictDoNothing();
    const ok = await callFn("postMoneybirdCorrection", [{ date: "2026-04-30", description: "Bankkosten", sourceType: "memorial", lines: [{ accountCode: "4530", amountCents: 195 }, { accountCode: "1000", amountCents: -195 }] }]);
    expect(ok.status).toBe(200);
    const vat = await callFn("postMoneybirdCorrection", [{ date: "2026-04-30", description: "x", sourceType: "memorial", lines: [{ accountCode: "1530", amountCents: 10 }, { accountCode: "1000", amountCents: -10 }] }]);
    expect(vat.status).toBe(422);
    await db.update(periods).set({ totals: { source: "freebird" } }).where(eq(periods.quarter, 2));
    const own = await callFn("postMoneybirdCorrection", [{ date: "2026-04-30", description: "x", sourceType: "memorial", lines: [{ accountCode: "4530", amountCents: 10 }, { accountCode: "1000", amountCents: -10 }] }]);
    expect(own.status).toBe(422);
  });

  it("boekt een privé betaalde telefoon als bedrijfsmiddel tegen privé-stortingen", async () => {
    const res = await callFn("bookPrivatePurchase", [{ date: "2026-07-27", supplierName: "World Business S.R.L.", supplierCountry: "IT", invoiceNumber: "6900/2026", description: "Telefoon 50% zakelijk", accountCode: "4620", totalCents: 27700, vatCode: "NONE", asset: { months: 60 } }]);
    expect(res.status).toBe(200);
    const { result } = await res.json();
    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, result.entryId));
    expect(lines.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-27700, 27700]);
    const [a] = await db.select().from(assets).where(eq(assets.receiptId, result.receiptId));
    expect(a.costCents).toBe(27700);
    expect((await callFn("bookPrivatePurchase", [{ date: "2026-07-27", supplierName: "X", description: "x", accountCode: "4620", totalCents: 100, vatCode: "NONE", asset: { months: 36 } }])).status).toBe(422);
  });

  it("boekt privé aankopen met verlegde BTW en zonder BTW in een Moneybird-kwartaal", async () => {
    const rc = await (await callFn("bookPrivatePurchase", [{ date: "2026-08-04", supplierName: "CS2C API", supplierCountry: "CA", description: "API", accountCode: "4520", totalCents: 7129, vatCode: "RC_NONEU" }])).json();
    const [v] = await db.select().from(vatEntries).where(eq(vatEntries.entryId, rc.result.entryId));
    expect(v).toMatchObject({ baseCents: 7129, vatCents: 1497 });
    await db.insert(periods).values({ year: 2026, quarter: 1, status: "filed", filedAt: new Date(), totals: { source: "moneybird" } }).onConflictDoNothing();
    expect((await callFn("bookPrivatePurchase", [{ date: "2026-03-04", supplierName: "Roozen", description: "PC 40%", accountCode: "4620", totalCents: 38000, vatCode: "NONE", asset: { months: 60 } }])).status).toBe(200);
    await callFn("runDepreciation", ["2026-04"]);
    const [dep] = await sql<{ n: string }[]>`select count(*) n from asset_depreciations d join assets a on a.id=d.asset_id where a.name='PC 40%' and d.month='2026-03'`;
    expect(Number(dep.n)).toBe(1);
    expect((await callFn("bookPrivatePurchase", [{ date: "2026-03-26", supplierName: "Odido", description: "abonnement", accountCode: "4600", totalCents: 703, vatCode: "I21" }])).status).toBe(422);
  });

  it("verrekent factuur met creditnota en boekt een restant af", async () => {
    const [c] = await db.insert(contacts).values({ name: "Klant B.V.", country: "NL", address: "Straat 1", postcode: "1000 AA", city: "Stad" }).returning();
    const mk = async (cents: number) => {
      const id = (await (await callFn("saveInvoiceDraft", [{ contactId: c.id, issueDate: "2026-10-01", lines: [{ description: "x", quantity: 1, unitPriceCents: cents, vatCode: "V21", accountCode: "8000" }] }])).json()).result;
      const f = await callFn("finalizeInvoice", [id, {}]);
      expect(f.status, await f.clone().text()).toBe(200);
      return id;
    };
    const a = await mk(10000), b = await mk(-10000), d = await mk(500);
    expect((await (await callFn("settleCreditNote", [a, b])).json()).result.settledCents).toBe(12100);
    const rows = await db.select().from(invoices).where(eq(invoices.contactId, c.id));
    expect(rows.filter((r) => r.id !== d).every((r) => r.status === "paid")).toBe(true);
    expect((await callFn("settleInvoiceOther", [d, { date: "2026-10-01", accountCode: "0920", memo: "Privé ontvangen" }])).status).toBe(200);
    expect((await db.select().from(invoices).where(eq(invoices.id, d)))[0].status).toBe("paid");
  });

  it("telt 20% van representatie niet mee als aftrekbaar in het jaaroverzicht", async () => {
    await callFn("postEntry", [{ date: "2026-08-09", description: "Diner", sourceType: "memorial", lines: [{ accountCode: "4720", amountCents: 37630 }, { accountCode: "0910", amountCents: -37630 }] }]);
    const ib = (await (await callFn("ibOverview", [2026])).json()).result;
    expect(ib.mixedCents).toBe(37630);
    expect(ib.mixedNonDeductibleCents).toBe(7526);
    expect(ib.fiscalProfitCents).toBe(ib.pnl.profitCents + 7526);
  });

  it("weigert een onbekende rekening", async () => {
    const res = await post("%PDF fout", { parsed: { date: "2026-09-05", totalCents: 500 }, book: { accountCode: "9999", vatCode: "I21" } });
    expect(res.status).toBe(400);
  });
});
