import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/db";
import { accounts, bankAccounts, bankTransactions, invoices, journalEntries, journalLines, mbItems, numberSequences, periods, receipts, vatEntries } from "@/db/schema";
import { resetDb } from "./db";
import { setSetting, getSetting } from "@/lib/settings";
import { runFetch, fetchStatus, type MbFile } from "@/lib/moneybird-fetch";
import { buildPlan, runOvername, undoOvername, saveMapping, suggestMapping, signedBalances } from "@/lib/moneybird-overname";
import { bookDirect } from "@/lib/bank";
import { mbGet, setMoneybirdSleep } from "@/lib/moneybird";

const ADM = "123";
const gl = (start: [string, string][], debit: [string, string][], credit: [string, string][]) => ({
  start_balance: { ledger_accounts: start.map(([ledger_account_id, value]) => ({ ledger_account_id, value })) },
  debit_sums: { ledger_accounts: debit.map(([ledger_account_id, value]) => ({ ledger_account_id, value })) },
  credit_sums: { ledger_accounts: credit.map(([ledger_account_id, value]) => ({ ledger_account_id, value })) },
  final_balance: { ledger_accounts: [] },
});
const klant = { id: "c1", company_name: "Klant BV", firstname: null, lastname: null, address1: "Straat 1", zipcode: "1000 AA", city: "Amsterdam", country: "NL", email: "k@klant.nl", send_invoices_to_email: null, tax_number: null, chamber_of_commerce: null };
const hetzner = { ...klant, id: "c2", company_name: "Hetzner Online GmbH", country: "DE", tax_number: "DE812871812" };
const kpn = { ...klant, id: "c3", company_name: "KPN B.V." };
const github = { ...klant, id: "c4", company_name: "GitHub, Inc.", country: "US" };

const API: Record<string, unknown> = {
  "ledger_accounts.json": [
    { id: "1", name: "Bank", account_type: "current_assets" }, { id: "2", name: "Debiteuren", account_type: "current_assets" },
    { id: "3", name: "Crediteuren", account_type: "current_liabilities" }, { id: "4", name: "Omzet", account_type: "revenue" },
    { id: "5", name: "Hosting", account_type: "expenses" }, { id: "6", name: "Eigen vermogen", account_type: "equity" },
    { id: "7", name: "Te betalen btw", account_type: "current_liabilities" }, { id: "9", name: "Telefoon en internet abonnement", account_type: "expenses" },
  ],
  "tax_rates.json": [
    { id: "t1", name: "21% btw", percentage: "21.0", tax_rate_type: "sales_invoice" },
    { id: "t2", name: "21% btw inkoop", percentage: "21.0", tax_rate_type: "purchase_invoice" },
    { id: "t3", name: "Btw verlegd", percentage: "0.0", tax_rate_type: "purchase_invoice" },
  ],
  "financial_accounts.json": [{ id: "f1", name: "bunq", type: "FinancialAccount" }],
  "contacts.json": [klant, hetzner, kpn, github],
  "sales_invoices.json": [
    { id: "s1", invoice_id: "2026-0005", state: "open", invoice_date: "2026-03-10", due_date: "2026-04-09", currency: "EUR", contact_id: "c1", contact: klant, details: [], payments: [{ price: "21.00", payment_date: "2026-04-01" }], total_price_incl_tax: "121.0", total_price_excl_tax: "100.0", attachments: [] },
    { id: "s2", invoice_id: "2026-0009", state: "open", invoice_date: "2026-07-15", due_date: "2026-08-14", currency: "EUR", contact_id: "c1", contact: klant,
      details: [{ ledger_account_id: "4", tax_rate_id: "t1", total_price_excl_tax_with_discount: "200.0", description: "Website", amount: "2", price: "100.0" }],
      tax_totals: [{ tax_rate_id: "t1", taxable_amount: "200.0", tax_amount: "42.0" }], payments: [], total_price_incl_tax: "242.0", total_price_excl_tax: "200.0", attachments: [] },
    { id: "s3", invoice_id: null, state: "draft", invoice_date: null, due_date: "2026-09-01", currency: "EUR", contact_id: "c1", contact: klant, details: [], total_price_incl_tax: "10.0", total_price_excl_tax: "10.0", attachments: [] },
  ],
  "documents/purchase_invoices.json": [
    { id: "p1", reference: "R0024418873", date: "2026-07-20", state: "open", currency: "EUR", contact_id: "c2", contact: hetzner,
      details: [{ ledger_account_id: "5", tax_rate_id: "t3", total_price_excl_tax_with_discount: "48.4", description: "Server", price: "48.4" }],
      payments: [], total_price_incl_tax: "48.4", total_price_excl_tax: "48.4", attachments: [{ id: "a1", filename: "hetzner.pdf", content_type: "application/pdf" }] },
    { id: "p2", reference: "KPN-08", date: "2026-08-01", state: "open", currency: "EUR", contact_id: "c3", contact: kpn,
      details: [{ ledger_account_id: "9", tax_rate_id: "t2", total_price_excl_tax_with_discount: "30.0", description: "Abonnement", price: "30.0" }],
      payments: [], total_price_incl_tax: "36.3", total_price_excl_tax: "30.0", attachments: [] },
  ],
  "documents/receipts.json": [
    { id: "r1", reference: "GH-1", date: "2026-08-05", state: "paid", currency: "EUR", contact_id: "c4", contact: github,
      details: [{ ledger_account_id: "5", tax_rate_id: "t3", total_price_excl_tax_with_discount: "12.1", description: "Copilot", price: "12.1" }],
      payments: [], total_price_incl_tax: "12.1", total_price_excl_tax: "12.1", attachments: [{ id: "a2", filename: "github.pdf", content_type: "application/pdf" }] },
  ],
  "documents/general_journal_documents.json": [],
  "documents/general_documents.json": [],
  "documents/typeless_documents.json": [],
  "external_sales_invoices.json": [],
};
// januari: beginsaldo bank 1000 tegen eigen vermogen, factuur 2026-0005 (121) en betaling 21; latere maanden leeg
const REPORTS: Record<string, unknown> = {
  "202601": gl([["1", "1000.0"], ["6", "-1000.0"]], [["2", "121.0"], ["1", "21.0"]], [["4", "100.0"], ["7", "21.0"], ["2", "21.0"]]),
};

let requests: string[] = [];
function fakeMoneybird() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const u = new URL(url);
    if (u.host === "files.example") return new Response(new Uint8Array(Buffer.from(`%PDF ${u.pathname}`)), { headers: { "content-type": "application/pdf" } });
    expect(init?.headers?.Authorization).toBe("Bearer mb-token");
    const path = u.pathname.replace(`/api/v2/${ADM}/`, "");
    requests.push(path);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (path === "reports/general_ledger.json") return json(REPORTS[u.searchParams.get("period")!.split("..")[0]] ?? gl([], [], []));
    if (/download(_pdf)?\.json$/.test(path)) return new Response(null, { status: 302, headers: { location: `https://files.example/${path}` } });
    if (path in API) return json(Number(u.searchParams.get("page") ?? 1) > 1 ? [] : API[path]);
    return new Response("not found", { status: 404 });
  }));
}

let bankId: number;
beforeAll(async () => {
  await resetDb();
  await setSetting("general", { openingDate: "2026-07-01", moneybirdToken: "mb-token", moneybirdAdministrationId: ADM });
  const [b] = await db.insert(bankAccounts).values({ bunqAccountId: 1, iban: "NL32BUNQ2000000003", name: "Bank" }).returning();
  bankId = b.id;
  // de GitHub-betaling is in FreeBird al direct via de bank geboekt
  const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: 1, date: "2026-08-06", amountCents: -1210, counterpartyName: "GitHub, Inc.", description: "Copilot" }).returning();
  await bookDirect(t.id, { accountCode: "4520", vatCode: "RC_NONEU" });
});
afterAll(async () => { vi.unstubAllGlobals(); await sql.end(); });

const balance = async () => Number((await db.select({ s: dsql<string>`coalesce(sum(${journalLines.amountCents}),0)` }).from(journalLines))[0].s);
const acc = async (code: string) => Number((await db.select({ s: dsql<string>`coalesce(sum(${journalLines.amountCents}),0)` }).from(journalLines).innerJoin(accounts, eq(accounts.id, journalLines.accountId)).where(eq(accounts.code, code)))[0].s);

describe("Moneybird", () => {
  it("leidt het teken van saldi af", () => {
    const types = new Map([["1", { account_type: "current_assets" }], ["6", { account_type: "equity" }]]);
    expect([...signedBalances({ ledger_accounts: [{ ledger_account_id: "1", value: "10.0" }, { ledger_account_id: "6", value: "-10.0" }] }, types)]).toEqual([["1", 1000], ["6", -1000]]);
    expect([...signedBalances({ ledger_accounts: [{ ledger_account_id: "1", value: "-10.0" }, { ledger_account_id: "6", value: "10.0" }] }, types)]).toEqual([["1", 1000], ["6", -1000]]);
    expect([...signedBalances({ ledger_accounts: [{ ledger_account_id: "1", value: "10.0" }, { ledger_account_id: "6", value: "10.0" }] }, types)]).toEqual([["1", 1000], ["6", -1000]]);
  });

  it("wacht bij een 429 van Moneybird en probeert opnieuw", async () => {
    const waits: number[] = [];
    setMoneybirdSleep(async (ms) => { waits.push(ms); });
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } }) : new Response("[]"))));
    await expect(mbGet("contacts.json")).resolves.toEqual([]);
    expect(waits).toEqual([7000]);
    setMoneybirdSleep((ms) => new Promise((r) => setTimeout(r, ms)));
  });

  it("haalt alles op, inclusief PDF's en bijlagen via de redirect", async () => {
    fakeMoneybird();
    await runFetch();
    const st = await fetchStatus();
    expect(st.status, st.message ?? "").toBe("ok");
    const items = await db.select().from(mbItems);
    expect(items.filter((i) => i.kind === "sales_invoice")).toHaveLength(3);
    const s2 = items.find((i) => i.mbId === "s2")!;
    expect(s2).toMatchObject({ number: "2026-0009", date: "2026-07-15", totalCents: 24200, contactName: "Klant BV" });
    expect((s2.files as MbFile[])[0]).toMatchObject({ kind: "pdf", name: "2026-0009.pdf" });
    expect((s2.files as MbFile[])[0].fileId).toBeTruthy();
    expect((items.find((i) => i.mbId === "s3")!.files as MbFile[])).toHaveLength(0); // concept heeft geen PDF
    expect((items.find((i) => i.mbId === "p1")!.files as MbFile[])[0].fileId).toBeTruthy();
    expect(items.filter((i) => i.kind === "report").length).toBeGreaterThanOrEqual(9);
    expect(requests).toContain("documents/purchase_invoices/p1/attachments/a1/download.json");
  });

  it("tweede keer ophalen downloadt niets opnieuw", async () => {
    requests = [];
    fakeMoneybird();
    await runFetch();
    expect(requests.filter((r) => r.includes("download"))).toHaveLength(0);
  });

  it("toont wat gekoppeld moet worden en laat de AI alleen geldige koppelingen maken", async () => {
    const plan = await buildPlan();
    expect(plan.neededLedger.map((l) => l.id).sort()).toEqual(["1", "2", "4", "5", "6", "7", "9"]);
    expect(plan.neededTax.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(plan).toMatchObject({ canTakeYear: true, openSales: 1, salesFromStart: 1, purchasesFromStart: 3, quartersBefore: ["2026-1", "2026-2"] });
    process.env.DEEPSEEK_API_KEY = "x";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      ledger: { "1": "1000", "2": "1100", "4": "8000", "5": "4510", "6": "0900", "7": "9999", "9": "new" },
      tax: { t1: "I21", t2: "I21", t3: "RC_EU" }, // t1 is een verkooptarief: I21 is fout
    }) } }] }))));
    await suggestMapping();
    const st = await getSetting("moneybird");
    expect(st.ledgerMap).toMatchObject({ "1": "1000", "2": "1100", "4": "8000", "5": "4510", "9": "new" });
    expect(st.ledgerMap?.["7"]).toBeUndefined();
    expect(st.taxMap).toEqual({ t2: "I21", t3: "RC_EU" });
    await expect(runOvername({ takeYear: true, fileQuarters: [] })).rejects.toThrow(/Koppel eerst/);
    await saveMapping({ "7": "1550" }, { t1: "V21" });
  });

  it("neemt het jaar, de open posten en alles vanaf de startdatum over", async () => {
    const r = await runOvername({ takeYear: true, fileQuarters: ["2026-1", "2026-2"] });
    expect(r).toMatchObject({ invoices: 2, receipts: 2, evidence: 1, quarters: 2 });
    expect(await balance()).toBe(0);
    // beginsaldo en januari
    const [opening] = await db.select().from(journalEntries).where(eq(journalEntries.sourceId, "opening:2026-01"));
    expect(opening.date).toBe("2026-01-01");
    expect(await acc("0900")).toBe(-100000);
    expect(await acc("1550")).toBe(-2100);
    // oude factuur: open voor 100 euro, geen nieuwe boeking
    const [old] = await db.select().from(invoices).where(eq(invoices.number, "2026-0005"));
    expect(old).toMatchObject({ status: "open", totalCents: 12100, paidCents: 2100, journalEntryId: null, sentAt: null });
    // nieuwe factuur: echte boeking met BTW-administratie en de Moneybird-PDF
    const [inv] = await db.select().from(invoices).where(eq(invoices.number, "2026-0009"));
    expect(inv.journalEntryId).not.toBeNull();
    expect(inv.pdfFileId).not.toBeNull();
    expect(await db.select().from(vatEntries).where(eq(vatEntries.entryId, inv.journalEntryId!))).toMatchObject([{ vatCode: "V21", baseCents: 20000, vatCents: 4200 }]);
    // nummering gaat verder na 2026-0009
    expect((await db.select().from(numberSequences).where(eq(numberSequences.key, "invoice-2026")))[0].next).toBe(10);
    // Hetzner verlegd, KPN met voorbelasting op een nieuwe rekening
    const vat = await db.select().from(vatEntries).where(and(dsql`${vatEntries.date} >= '2026-07-01'`, dsql`${vatEntries.vatCode} in ('RC_EU','I21')`));
    expect(vat.find((v) => v.vatCode === "RC_EU")).toMatchObject({ baseCents: 4840, vatCents: 1016 });
    expect(vat.find((v) => v.vatCode === "I21")).toMatchObject({ baseCents: 3000, vatCents: 630 });
    const [tel] = await db.select().from(accounts).where(eq(accounts.name, "Telefoon en internet abonnement"));
    expect(tel.code).toMatch(/^4\d{3}$/);
    // GitHub stond al geboekt: alleen bewijs, geen tweede kostenpost
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.counterpartyName, "GitHub, Inc."));
    expect(t.evidenceFileId).not.toBeNull();
    expect(await db.select().from(periods)).toHaveLength(2);
    await expect(runOvername({ takeYear: true, fileQuarters: [] })).rejects.toThrow(/al gedaan/);
  });

  it("kan ongedaan worden gemaakt en opnieuw, zonder dubbele rekeningen", async () => {
    await undoOvername();
    expect(await db.select().from(journalEntries).where(eq(journalEntries.sourceType, "moneybird"))).toHaveLength(0);
    expect(await db.select().from(invoices)).toHaveLength(0);
    expect(await db.select().from(receipts)).toHaveLength(0);
    expect(await db.select().from(periods)).toHaveLength(0);
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.counterpartyName, "GitHub, Inc."));
    expect(t.evidenceFileId).toBeNull();
    const accountsBefore = (await db.select().from(accounts)).length;
    await runOvername({ takeYear: true, fileQuarters: [] });
    expect((await db.select().from(accounts)).length).toBe(accountsBefore);
    expect(await balance()).toBe(0);
  });

  it("weigert een BTW-koppeling die de boeking niet laat sluiten", async () => {
    await undoOvername();
    await saveMapping({}, { t2: "NONE" }); // KPN rekent 21% maar gekoppeld aan geen BTW
    await expect(runOvername({ takeYear: true, fileQuarters: [] })).rejects.toThrow(/sluit niet/);
    expect(await db.select().from(journalEntries).where(eq(journalEntries.sourceType, "moneybird"))).toHaveLength(0);
  });
});
