import { and, desc, eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { aiResults, bankTransactions } from "@/db/schema";
import { aiJson, aiModel } from "./ai";
import { missingReceipts } from "./ai-bank";
import { quarterRange } from "./dates";
import { isEU } from "./eu";
import { formatEur } from "./money";
import { getSetting } from "./settings";

export type Finding = { severity: "hoog" | "middel" | "laag"; title: string; detail: string; href?: string; source: "regel" | "ai" };
export type VatReview = { summary: string; findings: Finding[]; model: string; at: string };

const DEDUCTIBLE = ["I21", "I9", "RC_EU", "RC_NONEU", "RC_NL"];

type Booking = { entry_id: number; date: string; description: string; source_type: string; account_code: string | null; account_name: string | null; vat_code: string; base_cents: string; vat_cents: string; country: string };

/** Alle boekingen met BTW in een kwartaal, met de belangrijkste grootboekrekening erbij. */
async function quarterBookings(from: string, to: string): Promise<Booking[]> {
  return sql<Booking[]>`
    select je.id as entry_id, je.date::text as date, je.description, je.source_type,
      x.code as account_code, x.name as account_name,
      v.vat_code, v.base_cents, v.vat_cents, v.country
    from vat_entries v
    join journal_entries je on je.id = v.entry_id
    left join lateral (
      select a.code, a.name from journal_lines l join accounts a on a.id = l.account_id
      where l.entry_id = je.id and a.type in ('expense', 'revenue', 'equity') order by abs(l.amount_cents) desc limit 1
    ) x on true
    where v.date between ${from} and ${to}
    order by je.date, je.id`;
}

/** Vaste controles zonder AI: snel, gratis en voorspelbaar. */
export async function vatFindings(year: number, quarter: number): Promise<Finding[]> {
  const { from, to } = quarterRange(year, quarter);
  const rows = await quarterBookings(from, to);
  const out: Finding[] = [];
  const drill = (r: string) => `/btw?y=${year}&q=${quarter}&tab=aangifte&r=${r}`;

  const nlVatAbroad = rows.filter((r) => ["I21", "I9"].includes(r.vat_code) && r.country && r.country !== "NL");
  if (nlVatAbroad.length) out.push({
    severity: "hoog", source: "regel", href: drill("5b"),
    title: `${nlVatAbroad.length}× Nederlandse BTW afgetrokken bij een buitenlandse leverancier`,
    detail: `Een buitenlandse leverancier rekent meestal geen Nederlandse BTW; dan hoort er RC_EU of RC_NONEU bij. Bijvoorbeeld: ${nlVatAbroad.slice(0, 3).map((r) => `${r.description} (${r.country})`).join(", ")}.`,
  });

  const rcEuWrong = rows.filter((r) => r.vat_code === "RC_EU" && r.country && !isEU(r.country));
  const rcNonEuWrong = rows.filter((r) => r.vat_code === "RC_NONEU" && r.country && isEU(r.country) && r.country !== "NL");
  if (rcEuWrong.length || rcNonEuWrong.length) out.push({
    severity: "middel", source: "regel", href: drill("4b"),
    title: `${rcEuWrong.length + rcNonEuWrong.length}× verlegde BTW past niet bij het land`,
    detail: [...rcEuWrong.map((r) => `${r.description}: RC_EU maar land ${r.country}`), ...rcNonEuWrong.map((r) => `${r.description}: RC_NONEU maar land ${r.country}`)].slice(0, 4).join("; ")
      + ". Het land komt van de IBAN; bij kaartbetalingen kan dat afwijken van de leverancier.",
  });

  const noVatAccounts = rows.filter((r) => ["4530", "4740"].includes(r.account_code ?? "") && Number(r.vat_cents) !== 0);
  if (noVatAccounts.length) out.push({
    severity: "middel", source: "regel", href: drill("5b"),
    title: `${noVatAccounts.length}× BTW geboekt op bankkosten of verzekeringen`,
    detail: "Bankkosten en verzekeringen zijn vrijgesteld van BTW, daar hoort geen voorbelasting bij.",
  });

  const dups = await sql<{ a: number; b: number; name: string | null; amount_cents: string; date: string }[]>`
    select t1.id as a, t2.id as b, t1.counterparty_name as name, t1.amount_cents, t1.date::text as date
    from bank_transactions t1 join bank_transactions t2
      on t2.id > t1.id and t2.amount_cents = t1.amount_cents and t2.amount_cents < 0
      and coalesce(t2.counterparty_iban, t2.counterparty_name) = coalesce(t1.counterparty_iban, t1.counterparty_name)
      and abs(t2.date - t1.date) <= 3
    where t1.status = 'booked' and t2.status = 'booked' and t1.date between ${from} and ${to}`;
  if (dups.length) out.push({
    severity: "laag", source: "regel", href: `/bank?filter=booked&tx=${dups[0].b}`,
    title: `${dups.length}× mogelijk dubbele betaling`,
    detail: dups.slice(0, 3).map((d) => `${d.name ?? "?"} ${formatEur(-Number(d.amount_cents))} rond ${d.date}`).join("; ") + ". Klopt dit, dan is er niets aan de hand.",
  });

  const missing = (await missingReceipts(from, to)).filter((m) => DEDUCTIBLE.includes(m.vat_code));
  if (missing.length) out.push({
    severity: "hoog", source: "regel", href: `/inkoop?tab=ontbrekend&y=${year}&q=${quarter}`,
    title: `${missing.length}× voorbelasting zonder bon of factuur`,
    detail: "Je mag BTW alleen aftrekken als je een factuur hebt. Voeg de bon toe of vraag hem op bij de leverancier.",
  });
  return out;
}

const REVIEW_SYSTEM = `Je controleert de BTW-administratie van een Nederlandse eenmanszaak of kleine onderneming voor de kwartaalaangifte.
Je krijgt alle boekingen met BTW in het kwartaal en de bevindingen van de vaste controles. Zoek aanvullende problemen die de vaste controles missen, bijvoorbeeld:
- een BTW-code die niet past bij de omschrijving of leverancier (bijv. Amerikaanse SaaS met I21, Hetzner zonder RC_EU, boeken met 21% in plaats van 9%);
- privé-uitgaven die als zakelijk zijn geboekt;
- omzet met de verkeerde code (bijv. EU-bedrijf met V21 in plaats van ICP_S);
- opvallende bedragen of omschrijvingen.
Herhaal geen bevindingen die al in de vaste controles staan. Wees concreet: noem de boeking. Geen algemeen advies.
Antwoord met een json-object: {"summary":"één of twee zinnen","findings":[{"severity":"hoog|middel|laag","title":"kort","detail":"wat er mis lijkt en wat te doen"}]}.
Geef een lege lijst als alles klopt.`;

/** Draait de AI-controle over een kwartaal en bewaart de uitkomst. */
export async function runVatReview(year: number, quarter: number): Promise<VatReview> {
  const { from, to } = quarterRange(year, quarter);
  const [rows, fixed] = await Promise.all([quarterBookings(from, to), vatFindings(year, quarter)]);
  if (!rows.length) {
    const review: VatReview = { summary: "Geen boekingen met BTW in dit kwartaal.", findings: [], model: aiModel(), at: new Date().toISOString() };
    await db.insert(aiResults).values({ kind: "vat_review", key: `${year}-${quarter}`, value: review });
    return review;
  }
  const data = rows.slice(0, 400).map((r) => ({
    id: r.entry_id, datum: r.date, omschrijving: r.description.slice(0, 120), bron: r.source_type,
    rekening: r.account_code ? `${r.account_code} ${r.account_name}` : null, btwCode: r.vat_code, land: r.country,
    grondslag: formatEur(Number(r.base_cents)), btw: formatEur(Number(r.vat_cents)),
  }));
  const res = await aiJson<{ summary?: string; findings?: { severity?: string; title?: string; detail?: string }[] }>({
    system: REVIEW_SYSTEM,
    user: `Kwartaal Q${quarter} ${year}.\n\nVaste controles:\n${JSON.stringify(fixed.map((f) => f.title))}\n\nBoekingen:\n${JSON.stringify(data)}`,
    maxTokens: 2500, think: true,
  });
  const sev = (s?: string): Finding["severity"] => (s === "hoog" || s === "laag" ? s : "middel");
  const review: VatReview = {
    summary: String(res.summary ?? "").slice(0, 500),
    findings: (res.findings ?? []).filter((f) => f.title).slice(0, 15).map((f) => ({ severity: sev(f.severity), title: String(f.title).slice(0, 160), detail: String(f.detail ?? "").slice(0, 600), source: "ai" as const })),
    model: aiModel(), at: new Date().toISOString(),
  };
  await db.insert(aiResults).values({ kind: "vat_review", key: `${year}-${quarter}`, value: review });
  return review;
}

export async function lastVatReview(year: number, quarter: number): Promise<VatReview | null> {
  const [r] = await db.select().from(aiResults).where(and(eq(aiResults.kind, "vat_review"), eq(aiResults.key, `${year}-${quarter}`))).orderBy(desc(aiResults.id)).limit(1);
  return (r?.value as VatReview) ?? null;
}

export type MailDraft = { to: string | null; subject: string; body: string; at: string };

/** Schrijft een korte mail aan de leverancier om een ontbrekende factuur op te vragen. */
export async function draftReceiptRequest(txId: number): Promise<MailDraft> {
  const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
  if (!t) throw new Error("Transactie niet gevonden");
  const [m] = (await missingReceipts(t.date, t.date)).filter((r) => r.id === txId);
  const company = await getSetting("company");
  const english = !!m?.country && m.country !== "NL";
  const res = await aiJson<{ subject?: string; body?: string }>({
    system: `Je schrijft korte, vriendelijke zakelijke mails namens ${company.name}${company.vatNumber ? ` (BTW-nummer ${company.vatNumber})` : ""}. Schrijf in het ${english ? "Engels" : "Nederlands"}. Antwoord met een json-object: {"subject":"...","body":"..."}. Onderteken met ${company.name}. Geen placeholders.`,
    user: `Vraag de leverancier om de factuur van deze betaling, op naam van ${company.name}${company.address ? `, ${company.address}, ${company.postcode} ${company.city}` : ""}, met ons BTW-nummer erop.\nLeverancier: ${m?.contact_name ?? t.counterpartyName ?? "onbekend"}\nBetaald op: ${t.date}\nBedrag: ${formatEur(-t.amountCents)}\nOmschrijving bij de betaling: ${t.description}`,
    maxTokens: 800, temperature: 0.3,
  });
  const draft: MailDraft = { to: m?.email ?? null, subject: String(res.subject ?? "Factuur gevraagd").slice(0, 200), body: String(res.body ?? "").slice(0, 3000), at: new Date().toISOString() };
  await db.insert(aiResults).values({ kind: "mail_draft", key: String(txId), value: draft });
  return draft;
}

export async function lastMailDraft(txId: number): Promise<MailDraft | null> {
  const [r] = await db.select().from(aiResults).where(and(eq(aiResults.kind, "mail_draft"), eq(aiResults.key, String(txId)))).orderBy(desc(aiResults.id)).limit(1);
  return (r?.value as MailDraft) ?? null;
}
