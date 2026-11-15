import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { bankAccounts, bankTransactions, invoices, invoiceLines, settings } from "@/db/schema";
import { resetDb, makeContact } from "./db";
import { aiJson, parseJsonObject, clampPct } from "@/lib/ai";
import { suggestForTransactions, validateSuggestion, proposeRules, bookingHistory, missingReceipts, pickExamples, startBulkSuggest, bulkStatus, type AiSuggestion } from "@/lib/ai-bank";
import { vatFindings } from "@/lib/ai-review";
import { cleanQuery, ask } from "@/lib/ai-ask";
import { parseAiInvoice, draftInvoiceFromText } from "@/lib/ai-invoice";
import { cleanParsedReceipt, pdfText } from "@/lib/receipts";
import { bookDirect } from "@/lib/bank";

/** Nep-DeepSeek: elke aanroep krijgt het volgende antwoord uit de lijst. Bewaart de verzoeken. */
function fakeDeepSeek(...answers: (object | string | { status: number })[]) {
  const calls: { body: { model: string; messages: { role: string; content: unknown }[]; response_format: unknown } }[] = [];
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a && typeof a === "object" && "status" in a) return new Response("fout", { status: (a as { status: number }).status });
    const content = typeof a === "string" ? a : JSON.stringify(a);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

let bankId: number;
let seq = 5000;
async function tx(date: string, amountCents: number, name: string, iban: string | null, description: string) {
  const [t] = await db.insert(bankTransactions).values({ bankAccountId: bankId, bunqPaymentId: seq++, date, amountCents, counterpartyName: name, counterpartyIban: iban, description }).returning();
  return t;
}

beforeAll(async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  await resetDb();
  const [b] = await db.insert(bankAccounts).values({ bunqAccountId: 1, iban: "NL32BUNQ2000000003", name: "Bankrekening" }).returning();
  bankId = b.id;
  await db.insert(bankAccounts).values({ bunqAccountId: 2, iban: "NL05BUNQ2000000004", name: "Spaarrekening", ledgerAccountCode: "1000" });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await sql.end(); });

describe("DeepSeek-client", () => {
  it("leest JSON, ook met codeblok eromheen", () => {
    expect(parseJsonObject<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(clampPct(140)).toBe(100);
    expect(clampPct("x")).toBe(0);
  });

  it("vraagt JSON-modus aan en probeert opnieuw bij een leeg antwoord", async () => {
    const calls = fakeDeepSeek("", { ok: true });
    await expect(aiJson({ system: "json", user: "x" })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    expect(calls[0].body.model).toBe("deepseek-flash");
    // nadenken staat uit: dat maakt classificeren alleen trager
    expect((calls[0].body as unknown as { thinking: unknown }).thinking).toEqual({ type: "disabled" });
  });

  it("zet nadenken alleen aan als erom gevraagd wordt", async () => {
    const calls = fakeDeepSeek({ ok: 1 });
    await aiJson({ system: "json", user: "x", think: true });
    expect(calls[0].body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
  });

  it("stuurt afbeeldingen als data-URL in het gebruikersbericht", async () => {
    const calls = fakeDeepSeek({ ok: 1 });
    await aiJson({ system: "json", user: "lees", images: [{ mime: "image/png", data: Buffer.from("png") }] });
    const content = calls[0].body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(content[0].image_url?.url).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
  });

  it("geeft een duidelijke fout bij een ongeldige key", async () => {
    fakeDeepSeek({ status: 401 });
    await expect(aiJson({ system: "json", user: "x" })).rejects.toThrow(/wijst de API key af/);
  });
});

describe("boekvoorstellen voor banktransacties", () => {
  it("herkent een overboeking naar de eigen spaarrekening zonder AI", async () => {
    const calls = fakeDeepSeek();
    const t = await tx("2026-07-02", -50000, "J. Jansen", "NL05BUNQ2000000004", "Sparen");
    await suggestForTransactions([t.id]);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.aiSuggestion).toMatchObject({ accountCode: "1000", vatCode: "NONE", source: "own_transfer" });
    expect(calls).toHaveLength(0);
    // en hij is ook echt te boeken
    await bookDirect(t.id, { accountCode: "1000", vatCode: "NONE" });
  });

  it("slaat een geldig AI-voorstel op en stuurt eerdere boekingen van dezelfde tegenpartij mee", async () => {
    for (const d of ["2026-07-03", "2026-08-03", "2026-09-03"]) {
      const t = await tx(d, -2000, "GitHub, Inc.", "US00GITH0000000001", "GitHub Copilot");
      await bookDirect(t.id, { accountCode: "4520", vatCode: "RC_NONEU" });
    }
    const open = await tx("2026-09-20", -2000, "GitHub, Inc.", "US00GITH0000000001", "GitHub Copilot");
    const calls = fakeDeepSeek({ suggestions: [{ id: open.id, accountCode: "4520", vatCode: "RC_NONEU", contactId: null, confidence: 96, reason: "Zelfde als eerder" }] });
    const r = await suggestForTransactions([open.id]);
    expect(r).toEqual({ suggested: 1, failed: 0 });
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, open.id));
    expect(row.aiSuggestion).toMatchObject({ accountCode: "4520", vatCode: "RC_NONEU", confidence: 96, source: "ai" });
    const prompt = String(calls[0].body.messages[1].content);
    expect(prompt).toContain("GitHub Copilot");
    expect(prompt).toContain("RC_NONEU");
    // geen volledige IBAN naar DeepSeek, alleen het land
    expect(prompt).not.toContain("US00GITH0000000001");
  });

  it("verwerkt veel transacties in parallelle batches en meldt voortgang", async () => {
    const ts: (typeof bankTransactions.$inferSelect)[] = [];
    for (let i = 0; i < 25; i++) ts.push(await tx("2026-08-20", -(1000 + i), `Winkel ${i}`, null, "aankoop"));
    let inFlight = 0, maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const user = JSON.parse(init.body).messages[1].content as string;
      const ids = [...user.matchAll(/"id":(\d+),"datum"/g)].map((m) => Number(m[1])).filter((id) => ts.some((t) => t.id === id));
      const content = JSON.stringify({ suggestions: ids.map((id) => ({ id, accountCode: "4800", vatCode: "I21", confidence: 70, reason: "x" })) });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
    const progress: number[] = [];
    const r = await suggestForTransactions(ts.map((t) => t.id), { onProgress: (d) => { progress.push(d); } });
    expect(r).toEqual({ suggested: 25, failed: 0 });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(25);
  });

  it("draait de bulk op de achtergrond en meldt wanneer hij klaar is", async () => {
    const t = await tx("2026-08-22", -777, "Achtergrond BV", null, "test");
    fakeDeepSeek({ suggestions: [{ id: t.id, accountCode: "4800", vatCode: "I21", confidence: 60, reason: "x" }] });
    const r = await startBulkSuggest();
    expect(r.started).toBe(true);
    for (let i = 0; i < 50 && (await bulkStatus()).running; i++) await new Promise((res) => setTimeout(res, 50));
    expect(await bulkStatus()).toMatchObject({ running: false, status: "ok" });
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, t.id));
    expect(row.aiSuggestion).toMatchObject({ accountCode: "4800" });
  });

  it("wijst voorstellen af met verkeerde codes of richting", () => {
    const ctx = {
      accounts: [{ code: "4520", name: "Software", type: "expense", defaultVatCode: "I21" }, { code: "1600", name: "Crediteuren", type: "liability", defaultVatCode: null }],
      vatCodes: [{ code: "I21", name: "Inkoop 21%", direction: "purchase", kind: "standard" }, { code: "V21", name: "Verkoop 21%", direction: "sale", kind: "standard" }, { code: "OSS", name: "OSS", direction: "sale", kind: "oss" }],
      contacts: [{ id: 7, name: "X", country: "NL", kind: "business" }],
    };
    expect(validateSuggestion({ accountCode: "4520", vatCode: "I21", contactId: 7, confidence: 80 }, { amountCents: -100 }, ctx)).toMatchObject({ contactId: 7 });
    expect(validateSuggestion({ accountCode: "4520", vatCode: "V21" }, { amountCents: -100 }, ctx)).toBeNull();
    expect(validateSuggestion({ accountCode: "1600", vatCode: "I21" }, { amountCents: -100 }, ctx)).toBeNull();
    expect(validateSuggestion({ accountCode: "9999", vatCode: "I21" }, { amountCents: -100 }, ctx)).toBeNull();
    expect(validateSuggestion({ accountCode: "4520", vatCode: "OSS" }, { amountCents: 100 }, ctx)).toBeNull();
    expect(validateSuggestion({ accountCode: "4520", vatCode: "I21", contactId: 999 }, { amountCents: -100 }, ctx)).toMatchObject({ contactId: null });
  });

  it("telt een mislukte batch als mislukt zonder te crashen", async () => {
    const t = await tx("2026-09-21", -999, "Onbekend BV", null, "iets");
    fakeDeepSeek({ suggestions: [{ id: t.id, accountCode: "BESTAATNIET", vatCode: "I21", confidence: 50 }] });
    expect(await suggestForTransactions([t.id])).toEqual({ suggested: 0, failed: 1 });
  });

  it("stelt een regel voor na drie gelijke boekingen", async () => {
    const history = await bookingHistory();
    const github = history.filter((h) => h.counterpartyName === "GitHub, Inc.");
    expect(github).toHaveLength(3);
    const proposals = proposeRules(history, []);
    expect(proposals.find((p) => p.name.startsWith("GitHub"))).toMatchObject({ accountCode: "4520", vatCode: "RC_NONEU", count: 3, match: { iban: "US00GITH0000000001", direction: "out" } });
    // bestaat er al een regel, dan geen voorstel
    const rule = { id: 1, name: "gh", match: { iban: "US00GITH0000000001", direction: "out" as const }, action: { kind: "book" as const, accountCode: "4520", vatCode: "RC_NONEU" }, autoApply: true, active: true };
    expect(proposeRules(history, [rule]).find((p) => p.name.startsWith("GitHub"))).toBeUndefined();
    // voorbeelden: eerst dezelfde tegenpartij
    expect(pickExamples(history, [{ counterpartyIban: "US00GITH0000000001", counterpartyName: null }], 2, 0)).toHaveLength(2);
  });

  it("vindt uitgaven zonder bon en laat ze los zodra er bewijs is", async () => {
    const missing = await missingReceipts("2026-07-01", "2026-09-30");
    const gh = missing.filter((m) => m.counterparty_name === "GitHub, Inc.");
    expect(gh).toHaveLength(3);
    expect(missing.some((m) => m.counterparty_name === "J. Jansen")).toBe(false); // eigen overboeking is geen kostenpost
    const [f] = await db.execute<{ id: string }>(
      (await import("drizzle-orm")).sql`insert into files (path, filename, mime, size, sha256) values ('x', 'bon.pdf', 'application/pdf', 1, 'x') returning id`,
    );
    await db.update(bankTransactions).set({ evidenceFileId: f.id }).where(eq(bankTransactions.id, gh[0].id));
    expect((await missingReceipts("2026-07-01", "2026-09-30")).filter((m) => m.counterparty_name === "GitHub, Inc.")).toHaveLength(2);
  });
});

describe("BTW-controle", () => {
  it("signaleert Nederlandse BTW bij een buitenlandse leverancier en voorbelasting zonder factuur", async () => {
    const t = await tx("2026-08-12", -12100, "Some GmbH", "DE89370400440532013000", "Lizenz");
    await bookDirect(t.id, { accountCode: "4520", vatCode: "I21" });
    const f = await vatFindings(2026, 3);
    expect(f.find((x) => /buitenlandse leverancier/.test(x.title))).toMatchObject({ severity: "hoog" });
    expect(f.find((x) => /zonder bon of factuur/.test(x.title))).toBeTruthy();
  });
});

describe("vragen aan je boekhouding", () => {
  it("staat alleen één SELECT toe", () => {
    expect(cleanQuery("select 1;")).toBe("select 1");
    expect(() => cleanQuery("delete from accounts")).toThrow();
    expect(() => cleanQuery("select 1; drop table accounts")).toThrow();
  });

  it("voert de query alleen-lezen uit en vat het antwoord samen", async () => {
    const calls = fakeDeepSeek(
      { sql: "select count(*) as aantal from bank_transactions where amount_cents < 0", explanation: "telt uitgaven" },
      { answer: "Je hebt 7 uitgaven." },
    );
    const a = await ask("Hoeveel uitgaven heb ik?");
    expect(a.answer).toBe("Je hebt 7 uitgaven.");
    expect(a.rows[0]).toHaveProperty("aantal");
    expect(String(calls[1].body.messages[1].content)).toContain("aantal");
  });

  it("kan niet bij instellingen en niet schrijven, ook niet als de AI dat probeert", async () => {
    fakeDeepSeek(
      { sql: "select value from settings", explanation: "x" },
      { sql: "with d as (delete from accounts returning 1) select * from d", explanation: "x" },
    );
    const a = await ask("Wat is mijn API key?");
    expect(a.rows).toHaveLength(0);
    expect(a.answer).toMatch(/lukte niet/);
    expect((await db.select().from(settings)).length).toBeGreaterThan(0);
    // en ook IBAN's van tegenpartijen zijn niet leesbaar
    await expect(sql.begin("read only", async (t) => { await t`set local role freebird_ai`; return t`select counterparty_iban from bank_transactions`; })).rejects.toThrow(/permission denied/);
  });
});

describe("factuur uit een zin", () => {
  it("valideert het AI-antwoord", () => {
    expect(() => parseAiInvoice({ unknownCustomer: "Jansen" }, new Set([1]))).toThrow(/Jansen/);
    expect(() => parseAiInvoice({ contactId: 1, lines: [] }, new Set([1]))).toThrow(/regels/);
    expect(parseAiInvoice({ contactId: 1, lines: [{ description: "Uren", quantity: 12, unitPriceCents: 8500 }] }, new Set([1])).lines[0]).toEqual({ description: "Uren", quantity: 12, unitPriceCents: 8500 });
  });

  it("maakt een concept met de BTW-code van de klant", async () => {
    const c = await makeContact({ name: "Bakkerij Jansen", country: "NL" });
    fakeDeepSeek({ contactId: c.id, lines: [{ description: "Website onderhoud september", quantity: 12, unitPriceCents: 8500 }], reference: "Onderhoud" });
    const id = await draftInvoiceFromText("12 uur à €85 voor Bakkerij Jansen, website onderhoud september");
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    expect(inv).toMatchObject({ status: "draft", contactId: c.id, subtotalCents: 102000, vatCents: 21420, reference: "Onderhoud" });
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    expect(line).toMatchObject({ vatCode: "V21", accountCode: "8000" });
  });
});

describe("bonnen uitlezen", () => {
  it("schoont het AI-antwoord op", () => {
    const p = cleanParsedReceipt({ supplierName: " Hetzner ", totalCents: "4840" as unknown as number, date: "1 sept", suggestedAccountCode: "9999", supplierCountry: "de" }, new Set(["4510"]));
    expect(p).toMatchObject({ supplierName: "Hetzner", totalCents: 4840, supplierCountry: "DE" });
    expect(p.date).toBeUndefined();
    expect(p.suggestedAccountCode).toBeUndefined();
  });

  it("haalt tekst uit een PDF", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (Hetzner 48,40) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    expect(await pdfText(pdf)).toContain("Hetzner 48,40");
  });
});

// type-check dat het opgeslagen voorstel de verwachte vorm heeft
export type _Check = AiSuggestion;
