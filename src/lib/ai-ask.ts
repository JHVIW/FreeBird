import { desc, eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { aiResults } from "@/db/schema";
import { aiJson, aiModel } from "./ai";
import { today } from "./dates";
import { getSetting } from "./settings";

export type Answer = { question: string; sql: string | null; columns: string[]; rows: Record<string, unknown>[]; answer: string; at: string; model: string };

/** Wat de AI van de database mag weten: precies de kolommen waar de rol freebird_ai bij kan. */
const SCHEMA = `PostgreSQL. Bedragen zijn bigint in CENTEN. Datums zijn date (YYYY-MM-DD).
accounts(id, code, name, type: asset|liability|equity|revenue|expense, ib_category, default_vat_code)
  Kosten 4xxx/7xxx, omzet 8xxx, 1000 bank, 1100 debiteuren, 1600 crediteuren, 15xx BTW, 0910 privé-stortingen, 0920 privé-onttrekkingen.
journal_entries(id, date, description, source_type: invoice|bank|receipt|memorial|vat_close|depreciation|opening|sale, source_id, reversal_of)
journal_lines(id, entry_id, account_id, amount_cents, contact_id, memo)  -- debet positief, credit negatief; som per entry = 0
  Omzet staat dus negatief op 8xxx: omzet = -sum(amount_cents). Kosten positief op 4xxx/7xxx.
vat_entries(id, entry_id, date, vat_code, rate_bp, base_cents, vat_cents, country, customer_kind, contact_id, vat_number)
vat_codes(code, name, direction: sale|purchase, rate_bp, kind, rubriek)
contacts(id, kind: business|consumer, is_customer, is_supplier, name, country, vat_number, payment_term_days, archived, created_at)
invoices(id, number, contact_id, status: draft|open|paid|credited|uncollectible, issue_date, delivery_date, due_date, currency, language, reference, subtotal_cents, vat_cents, total_cents, paid_cents, credit_of, sent_at, reminders_sent, created_at)
invoice_lines(id, invoice_id, position, description, quantity, unit_price_cents, vat_code, rate_bp, account_code, base_cents, vat_cents)
invoice_events(id, invoice_id, type: finalized|sent|reminder|paid|bounced|credited|payment, at)
bank_accounts(id, name, ledger_account_code, balance_cents, balance_at)
bank_transactions(id, bank_account_id, date, amount_cents, currency, counterparty_name, description, type, status: open|booked|ignored, created_at)  -- negatief = uitgaand
reconciliations(id, bank_transaction_id, target_type: invoice|receipt|entry, target_id, amount_cents, journal_entry_id)
receipts(id, source, status: new|parsed|booked|ignored|error, supplier_contact_id, date, invoice_number, total_cents, paid_cents, created_at)
assets(id, name, purchase_date, cost_cents, residual_cents, months, asset_account_code, disposed_at)
asset_depreciations(id, asset_id, month, amount_cents, journal_entry_id)
time_entries(id, date, minutes, note)
periods(id, year, quarter, status: open|filed, filed_at)
fiscal_params(id, year, key, value jsonb, note)
Gebruik alleen deze tabellen en kolommen (geen SELECT *).`;

/** Alleen één SELECT of WITH-query, zonder puntkomma's ertussen. De database-rol is de echte beveiliging; dit vangt vergissingen af. */
export function cleanQuery(q: string): string {
  const s = q.trim().replace(/;+\s*$/, "").trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error("Alleen SELECT-queries zijn toegestaan");
  if (s.includes(";")) throw new Error("Eén query tegelijk");
  return s;
}

async function runReadOnly(query: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const q = cleanQuery(query);
  const [role] = await sql`select 1 from pg_roles where rolname = 'freebird_ai'`;
  if (!role) throw new Error("De alleen-lezen-rol freebird_ai ontbreekt in de database. Draai de migraties met een gebruiker die rollen mag maken.");
  return sql.begin("read only", async (tx) => {
    await tx`set local role freebird_ai`;
    await tx`set local statement_timeout = '5s'`;
    const res = await tx.unsafe(`select * from (${q}) as antwoord limit 200`);
    const rows = [...res] as Record<string, unknown>[];
    return { columns: res.columns?.map((c) => c.name) ?? Object.keys(rows[0] ?? {}), rows };
  }) as Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
}

/** Beantwoordt een vraag over de administratie: de AI schrijft een query, wij voeren die alleen-lezen uit, de AI vat samen. */
export async function ask(question: string): Promise<Answer> {
  const qText = question.trim().slice(0, 1000);
  if (qText.length < 3) throw new Error("Stel een vraag");
  const general = await getSetting("general");
  const system = `Je beantwoordt vragen over de boekhouding van een Nederlandse eenmanszaak door één PostgreSQL SELECT-query te schrijven.
Vandaag is ${today()}. De administratie begint op ${general.openingDate ?? "onbekend"}.
${SCHEMA}
Tips: "kosten" = journal_lines op accounts.type 'expense'; "omzet" = -sum op accounts.type 'revenue'; kwartaal Q3 = juli t/m september.
Geef kolommen duidelijke Nederlandse namen. Houd het resultaat klein (aggregeer, max ~50 rijen).
Als de vraag niet met deze gegevens te beantwoorden is, geef dan "sql": null en leg het uit in "explanation".
Antwoord met een json-object: {"sql":"select ...","explanation":"korte uitleg wat de query doet"}`;

  let plan = await aiJson<{ sql?: string | null; explanation?: string }>({ system, user: qText, maxTokens: 1500, think: true });
  let result: { columns: string[]; rows: Record<string, unknown>[] } | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && plan.sql; attempt++) {
    try {
      result = await runReadOnly(plan.sql);
      break;
    } catch (e) {
      lastError = (e as Error).message;
      if (attempt === 0) plan = await aiJson({ system, user: `${qText}\n\nJe vorige query gaf een fout:\n${plan.sql}\n\nFout: ${lastError}\n\nSchrijf een verbeterde query.`, maxTokens: 1500, think: true });
    }
  }

  let answer: string;
  if (!plan.sql) answer = String(plan.explanation ?? "Dit kan ik niet uit de administratie halen.");
  else if (!result) answer = `Het lukte niet om dit op te zoeken (${lastError}). Probeer de vraag anders te stellen.`;
  else {
    const res = await aiJson<{ answer?: string }>({
      system: `Je bent de boekhouder van de gebruiker. Beantwoord de vraag kort en concreet in het Nederlands op basis van het queryresultaat.
Bedragen in het resultaat zijn in CENTEN: deel door 100 en schrijf als € 1.234,56. Noem geen SQL. Is het resultaat leeg, zeg dat dan.
Antwoord met een json-object: {"answer":"..."}`,
      user: `Vraag: ${qText}\nWat de query doet: ${plan.explanation ?? ""}\nResultaat (${result.rows.length} rijen):\n${JSON.stringify(result.rows.slice(0, 100))}`,
      maxTokens: 1200, temperature: 0.2,
    });
    answer = String(res.answer ?? "").trim() || "Geen antwoord.";
  }

  const out: Answer = {
    question: qText, sql: plan.sql ?? null, columns: result?.columns ?? [], rows: (result?.rows ?? []).slice(0, 50).map((r) => JSON.parse(JSON.stringify(r)) as Record<string, unknown>),
    answer, at: new Date().toISOString(), model: aiModel(),
  };
  await db.insert(aiResults).values({ kind: "question", input: qText, value: out });
  return out;
}

export async function recentQuestions(limit = 10): Promise<Answer[]> {
  const rows = await db.select().from(aiResults).where(eq(aiResults.kind, "question")).orderBy(desc(aiResults.id)).limit(limit);
  return rows.map((r) => r.value as Answer);
}
