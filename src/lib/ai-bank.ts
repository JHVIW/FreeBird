import { and, desc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/db";
import { accounts, bankAccounts, bankTransactions, contacts, jobRuns, rules, vatCodes } from "@/db/schema";
import { aiJson, aiModel, clampPct } from "./ai";
import { ibanCountry, normalizeIban } from "./eu";
import { ruleMatches, type RuleLike, type RuleMatch, type Suggestion } from "./matching";
import { formatEur } from "./money";

/** Boekvoorstel voor een banktransactie, opgeslagen in bank_transactions.ai_suggestion. */
export type AiSuggestion = {
  accountCode: string; vatCode: string; contactId: number | null; confidence: number; reason: string;
  source: "ai" | "own_transfer"; model?: string; at: string;
};

/** Een eerdere directe boeking van een banktransactie: het voorbeeldmateriaal voor de AI. */
export type PastBooking = {
  txId: number; date: string; amountCents: number; counterpartyName: string | null; counterpartyIban: string | null;
  description: string; accountCode: string; vatCode: string; contactId: number | null;
};

type TxRow = typeof bankTransactions.$inferSelect;

/** Rekeningen waar je een banktransactie niet rechtstreeks op boekt (die lopen via facturen, bonnen of de aangifte). */
const NOT_BOOKABLE = new Set(["1100", "1600", "1500", "1510", "1520", "1530", "1540"]);

/** Directe boekingen van banktransacties, nieuwste eerst. */
export async function bookingHistory(limit = 500): Promise<PastBooking[]> {
  const rows = await sql<{ tx_id: number; date: string; amount_cents: string; counterparty_name: string | null; counterparty_iban: string | null; description: string; account_code: string; vat_code: string; contact_id: number | null }[]>`
    select t.id as tx_id, t.date::text as date, t.amount_cents, t.counterparty_name, t.counterparty_iban, t.description,
      coalesce((
        select a.code from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = je.id and a.code <> ba.ledger_account_code and a.code not like '15%'
        order by abs(l.amount_cents) desc limit 1
      ), ba.ledger_account_code) as account_code,
      coalesce((select v.vat_code from vat_entries v where v.entry_id = je.id order by v.id limit 1), 'NONE') as vat_code,
      (select l.contact_id from journal_lines l where l.entry_id = je.id and l.contact_id is not null limit 1) as contact_id
    from reconciliations r
    join bank_transactions t on t.id = r.bank_transaction_id
    join bank_accounts ba on ba.id = t.bank_account_id
    join journal_entries je on je.id = r.journal_entry_id
    where r.target_type = 'entry' and je.source_type = 'bank'
    order by t.date desc, t.id desc
    limit ${limit}`;
  return rows.map((r) => ({
    txId: r.tx_id, date: r.date, amountCents: Number(r.amount_cents), counterpartyName: r.counterparty_name, counterpartyIban: r.counterparty_iban,
    description: r.description, accountCode: r.account_code, vatCode: r.vat_code, contactId: r.contact_id,
  }));
}

/** Sleutel om boekingen van dezelfde tegenpartij te groeperen: IBAN, anders naam. */
export function counterpartyKey(t: { counterpartyIban: string | null; counterpartyName: string | null }): string | null {
  if (t.counterpartyIban) return `iban:${normalizeIban(t.counterpartyIban)}`;
  const n = t.counterpartyName?.trim().toLowerCase();
  return n ? `name:${n}` : null;
}

/** Kiest voorbeelden: eerst dezelfde tegenpartij, dan de meest recente andere boekingen. */
export function pickExamples(history: PastBooking[], txs: Pick<TxRow, "counterpartyIban" | "counterpartyName">[], perCounterparty = 5, recent = 25): PastBooking[] {
  const keys = new Set(txs.map(counterpartyKey).filter(Boolean));
  const out = new Map<number, PastBooking>();
  const perKey = new Map<string, number>();
  for (const h of history) {
    const k = counterpartyKey(h);
    if (!k || !keys.has(k)) continue;
    const n = perKey.get(k) ?? 0;
    if (n >= perCounterparty) continue;
    perKey.set(k, n + 1);
    out.set(h.txId, h);
  }
  for (const h of history.slice(0, recent)) out.set(h.txId, h);
  return [...out.values()];
}

type Ctx = {
  accounts: { code: string; name: string; type: string; defaultVatCode: string | null }[];
  vatCodes: { code: string; name: string; direction: string; kind: string }[];
  contacts: { id: number; name: string; country: string; kind: string }[];
  ownIbans: Map<string, string>; // iban → grootboekrekening
};

/** Controleert een voorstel van de AI tegen de echte rekeningen, BTW-codes en relaties. */
export function validateSuggestion(
  raw: { accountCode?: unknown; vatCode?: unknown; contactId?: unknown; confidence?: unknown; reason?: unknown },
  tx: Pick<TxRow, "amountCents">, ctx: Pick<Ctx, "accounts" | "vatCodes" | "contacts">,
): Omit<AiSuggestion, "source" | "at" | "model"> | null {
  const accountCode = String(raw.accountCode ?? "");
  const vatCode = String(raw.vatCode ?? "");
  const acc = ctx.accounts.find((a) => a.code === accountCode);
  const code = ctx.vatCodes.find((c) => c.code === vatCode);
  if (!acc || NOT_BOOKABLE.has(acc.code) || !code || code.kind === "oss") return null;
  // uitgaand geld: alleen inkoopcodes (NONE is ook een inkoopcode); inkomend mag alles behalve OSS
  if (tx.amountCents < 0 && code.direction !== "purchase") return null;
  const cid = raw.contactId == null || raw.contactId === "" ? null : Number(raw.contactId);
  const contactId = cid != null && ctx.contacts.some((c) => c.id === cid) ? cid : null;
  return { accountCode, vatCode, contactId, confidence: clampPct(raw.confidence), reason: String(raw.reason ?? "").slice(0, 300) };
}

async function loadCtx(): Promise<Ctx> {
  const [accs, codes, cs, banks] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.active, true)),
    db.select().from(vatCodes).where(eq(vatCodes.active, true)),
    db.select().from(contacts).where(eq(contacts.archived, false)),
    db.select().from(bankAccounts),
  ]);
  return {
    accounts: accs.map((a) => ({ code: a.code, name: a.name, type: a.type, defaultVatCode: a.defaultVatCode })),
    vatCodes: codes.map((c) => ({ code: c.code, name: c.name, direction: c.direction, kind: c.kind })),
    contacts: cs.map((c) => ({ id: c.id, name: c.name, country: c.country, kind: c.kind })),
    ownIbans: new Map(banks.map((b) => [normalizeIban(b.iban), b.ledgerAccountCode])),
  };
}

const SYSTEM = `Je bent de boekhouder van een Nederlandse eenmanszaak of kleine onderneming.
Je stelt voor elke banktransactie een directe boeking voor: grootboekrekening, BTW-code en eventueel relatie.

Regels:
- Uitgaand geld (negatief bedrag) krijgt altijd een inkoopcode of NONE.
- Nederlandse leverancier met BTW op de factuur: I21 (of I9 voor boeken, eten en drinken).
- Dienst van een leverancier uit een ander EU-land (bijv. Hetzner, DE): RC_EU, BTW verlegd.
- Dienst van een leverancier buiten de EU (bijv. Anthropic, OpenAI, GitHub, Google, AWS, Apple, Vercel; vaak US of IE via kaart): RC_NONEU. Let op: Ierse vestigingen (Google Ireland, Apple Distribution International) zijn EU, dus RC_EU.
- Bankkosten, verzekeringen, gemeente, belastingen en boetes: NONE.
- Privé-uitgave (supermarkt, kleding, huur, persoonlijke overboekingen naar de eigenaar): 0920 Privé-onttrekkingen met NONE.
- Inkomend geld van de eigenaar zelf of een privérekening: 0910 Privé-stortingen met NONE.
- Inkomend geld van klanten zonder factuur: omzetrekening met een verkoopcode (V21 voor Nederlandse klanten).
- Betaling aan de Belastingdienst voor BTW: 1550 met NONE.
- Kijk vooral naar eerdere boekingen van dezelfde tegenpartij: als die consequent zijn, volg ze en geef een hoge zekerheid.
- Twijfel je, geef dan een lage zekerheid (onder 60) en leg in de reden uit wat je niet weet.
- Gebruik alleen rekeningcodes, BTW-codes en relatie-id's uit de lijsten.

Antwoord met een json-object:
{"suggestions":[{"id":<transactie-id>,"accountCode":"4520","vatCode":"I21","contactId":<id of null>,"confidence":<0-100>,"reason":"korte uitleg in het Nederlands, max 15 woorden"}]}
Geef voor elke transactie precies één suggestie.`;

function describeTx(t: Pick<TxRow, "id" | "date" | "amountCents" | "counterpartyName" | "counterpartyIban" | "description">) {
  return { id: t.id, datum: t.date, bedrag: formatEur(t.amountCents, { sign: true }), tegenpartij: t.counterpartyName ?? "onbekend", ibanLand: ibanCountry(t.counterpartyIban), omschrijving: t.description.slice(0, 200) };
}

/** Maakt voorstellen voor deze transacties en slaat ze op. Eigen overboekingen worden zonder AI herkend. */
/** Voert taken uit met maximaal `n` tegelijk. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const BATCH = 10;
const PARALLEL = 5;

export async function suggestForTransactions(txIds: number[], opts: { onProgress?: (done: number, total: number) => Promise<void> | void } = {}): Promise<{ suggested: number; failed: number }> {
  if (!txIds.length) return { suggested: 0, failed: 0 };
  const txs = await db.select().from(bankTransactions).where(inArray(bankTransactions.id, txIds));
  const ctx = await loadCtx();
  const now = new Date().toISOString();
  let suggested = 0, failed = 0;

  const forAi: TxRow[] = [];
  for (const t of txs) {
    const own = t.counterpartyIban ? ctx.ownIbans.get(normalizeIban(t.counterpartyIban)) : undefined;
    if (own) {
      const s: AiSuggestion = { accountCode: own, vatCode: "NONE", contactId: null, confidence: 99, reason: "Overboeking tussen eigen rekeningen", source: "own_transfer", at: now };
      await db.update(bankTransactions).set({ aiSuggestion: s }).where(eq(bankTransactions.id, t.id));
      suggested++;
    } else forAi.push(t);
  }
  if (!forAi.length) return { suggested, failed };

  const history = await bookingHistory();
  const bookable = ctx.accounts.filter((a) => !NOT_BOOKABLE.has(a.code) && a.code !== "1000");
  const lists = [
    "Grootboekrekeningen (code naam [standaard BTW-code]):",
    ...bookable.map((a) => `${a.code} ${a.name}${a.defaultVatCode ? ` [${a.defaultVatCode}]` : ""}`),
    "", "BTW-codes:", ...ctx.vatCodes.filter((c) => c.kind !== "oss").map((c) => `${c.code}: ${c.name}`),
    "", "Relaties (id naam land):", ...ctx.contacts.slice(0, 300).map((c) => `${c.id} ${c.name} ${c.country}${c.kind === "consumer" ? " particulier" : ""}`),
  ].join("\n");

  // vaste lijsten vooraan in de systeemprompt: dan hergebruikt DeepSeek ze uit zijn cache bij elke batch
  const system = `${SYSTEM}\n\n${lists}`;
  const batches: TxRow[][] = [];
  for (let i = 0; i < forAi.length; i += BATCH) batches.push(forAi.slice(i, i + BATCH));
  let done = txs.length - forAi.length;
  let fatal: Error | null = null;

  await pool(batches, PARALLEL, async (batch) => {
    if (fatal) return;
    const examples = pickExamples(history, batch).map((h) => ({ ...describeTx({ ...h, id: h.txId }), geboektOp: h.accountCode, btw: h.vatCode, relatie: h.contactId }));
    try {
      const res = await aiJson<{ suggestions?: ({ id?: unknown } & Parameters<typeof validateSuggestion>[0])[] }>({
        system,
        user: `Eerdere boekingen (voorbeelden):\n${JSON.stringify(examples)}\n\nTe boeken transacties:\n${JSON.stringify(batch.map(describeTx))}`,
        maxTokens: 1500,
      });
      for (const t of batch) {
        const raw = res.suggestions?.find((s) => Number(s.id) === t.id);
        const v = raw ? validateSuggestion(raw, t, ctx) : null;
        if (!v) { failed++; continue; }
        const s: AiSuggestion = { ...v, source: "ai", model: aiModel(), at: now };
        await db.update(bankTransactions).set({ aiSuggestion: s }).where(eq(bankTransactions.id, t.id));
        suggested++;
      }
    } catch (e) {
      // één mislukte batch mag de rest niet tegenhouden; bij een configuratiefout stoppen we wel
      failed += batch.length;
      console.warn("AI-voorstel mislukt:", (e as Error).message);
      if (/key|tegoed/i.test((e as Error).message)) fatal = e as Error;
    }
    done += batch.length;
    await opts.onProgress?.(done, txs.length);
  });
  if (fatal) throw fatal;
  return { suggested, failed };
}

/** Open transacties die nog geen voorstel hebben en waarvoor de matching-engine niets sterks weet. */
export async function openWithoutAiSuggestion(limit: number): Promise<number[]> {
  const rows = await db.select({ id: bankTransactions.id, suggestions: bankTransactions.suggestions }).from(bankTransactions)
    .where(and(eq(bankTransactions.status, "open"), isNull(bankTransactions.aiSuggestion)))
    .orderBy(desc(bankTransactions.date)).limit(limit * 3);
  return rows.filter((r) => ((r.suggestions as Suggestion[] | null)?.[0]?.confidence ?? 0) < 85).slice(0, limit).map((r) => r.id);
}

export async function suggestOpen(limit = 500) {
  return suggestForTransactions(await openWithoutAiSuggestion(limit));
}

const BULK_JOB = "ai-bulk";

async function recordBulk(status: string, message: string) {
  await db.insert(jobRuns).values({ name: BULK_JOB, lastRunAt: new Date(), lastStatus: status, lastMessage: message })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunAt: new Date(), lastStatus: status, lastMessage: message } });
}

/** Status van de achtergrondtaak die voorstellen maakt. "Bezig" verloopt na 5 minuten zonder voortgang (bijv. na een herstart). */
export async function bulkStatus() {
  const [r] = await db.select().from(jobRuns).where(eq(jobRuns.name, BULK_JOB));
  const fresh = !!r?.lastRunAt && Date.now() - r.lastRunAt.getTime() < 5 * 60_000;
  return { running: r?.lastStatus === "bezig" && fresh, status: r?.lastStatus ?? null, message: r?.lastMessage ?? null, at: r?.lastRunAt ?? null };
}

/** Start op de achtergrond voorstellen voor alle open transacties zonder voorstel. Wacht er niet op. */
export async function startBulkSuggest(): Promise<{ started: boolean; total: number }> {
  if ((await bulkStatus()).running) return { started: false, total: 0 };
  const ids = await openWithoutAiSuggestion(5000);
  if (!ids.length) return { started: false, total: 0 };
  await recordBulk("bezig", `0 van ${ids.length}`);
  void (async () => {
    try {
      const r = await suggestForTransactions(ids, { onProgress: (done, total) => recordBulk("bezig", `${done} van ${total}`) });
      await recordBulk("ok", `${r.suggested} voorstellen gemaakt${r.failed ? `, ${r.failed} mislukt` : ""}`);
    } catch (e) {
      await recordBulk("fout", (e as Error).message).catch(() => {});
    }
  })();
  return { started: true, total: ids.length };
}

/** Open transacties met een AI-voorstel vanaf deze zekerheid. */
export async function confidentAiTransactions(min = 90) {
  return db.select().from(bankTransactions).where(and(
    eq(bankTransactions.status, "open"),
    dsql`(${bankTransactions.aiSuggestion}->>'confidence')::int >= ${min}`,
  ));
}

export type RuleProposal = { key: string; name: string; match: RuleMatch; accountCode: string; vatCode: string; contactId: number | null; count: number; lastDate: string };

/**
 * Stelt regels voor waar je dezelfde tegenpartij minstens `min` keer precies hetzelfde hebt geboekt
 * en nog geen regel voor bestaat. Puur, zonder AI: dit is gewoon tellen.
 */
export function proposeRules(history: PastBooking[], existing: RuleLike[], min = 3): RuleProposal[] {
  const groups = new Map<string, PastBooking[]>();
  for (const h of history) {
    const k = counterpartyKey(h);
    if (!k) continue;
    const key = `${k}|${h.amountCents < 0 ? "out" : "in"}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const out: RuleProposal[] = [];
  for (const [key, items] of groups) {
    if (items.length < min) continue;
    const combos = new Set(items.map((h) => `${h.accountCode}|${h.vatCode}|${h.contactId ?? ""}`));
    if (combos.size !== 1) continue; // niet consequent geboekt: geen regel voorstellen
    const last = items[0];
    if (existing.some((r) => ruleMatches(r, { id: 0, date: last.date, amountCents: last.amountCents, counterpartyName: last.counterpartyName, counterpartyIban: last.counterpartyIban, description: last.description }))) continue;
    const direction = last.amountCents < 0 ? "out" as const : "in" as const;
    const match: RuleMatch = last.counterpartyIban ? { iban: normalizeIban(last.counterpartyIban), direction } : { counterpartyContains: last.counterpartyName ?? "", direction };
    out.push({ key, name: `${last.counterpartyName ?? last.counterpartyIban} → ${last.accountCode}`, match, accountCode: last.accountCode, vatCode: last.vatCode, contactId: last.contactId, count: items.length, lastDate: last.date });
  }
  return out.sort((a, b) => b.count - a.count);
}

export async function ruleProposals(): Promise<RuleProposal[]> {
  const [history, rs] = await Promise.all([bookingHistory(1000), db.select().from(rules).where(eq(rules.active, true))]);
  return proposeRules(history, rs as unknown as RuleLike[]);
}

/** Uitgaande directe boekingen op een kostenrekening zonder bon of bijgevoegd bewijs. */
export async function missingReceipts(from: string, to: string) {
  const rows = await sql<{ id: number; date: string; amount_cents: string; counterparty_name: string | null; description: string; account_code: string; account_name: string; vat_code: string; contact_id: number | null; contact_name: string | null; email: string | null; country: string | null }[]>`
    select t.id, t.date::text as date, t.amount_cents, t.counterparty_name, t.description,
      a.code as account_code, a.name as account_name,
      coalesce((select v.vat_code from vat_entries v where v.entry_id = je.id order by v.id limit 1), 'NONE') as vat_code,
      c.id as contact_id, c.name as contact_name, coalesce(c.invoice_email, c.email) as email, c.country
    from bank_transactions t
    join reconciliations r on r.bank_transaction_id = t.id and r.target_type = 'entry'
    join journal_entries je on je.id = r.journal_entry_id and je.source_type = 'bank'
    join lateral (
      select l.account_id, l.contact_id from journal_lines l join accounts a2 on a2.id = l.account_id
      where l.entry_id = je.id and a2.type = 'expense' order by abs(l.amount_cents) desc limit 1
    ) x on true
    join accounts a on a.id = x.account_id
    left join contacts c on c.id = x.contact_id
    where t.amount_cents < 0 and t.status = 'booked' and t.evidence_file_id is null
      and a.code <> '4530' and t.date between ${from} and ${to}
    order by t.date desc`;
  return rows.map((r) => ({ ...r, amountCents: Number(r.amount_cents) }));
}
