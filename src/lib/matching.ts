import { normalizeIban } from "./eu";
import { daysBetween } from "./dates";

/** Pure matching-engine: geen database, makkelijk te testen. */

export type TxLike = { id: number; date: string; amountCents: number; counterpartyName: string | null; counterpartyIban: string | null; description: string };
export type OpenInvoice = { id: number; number: string; openCents: number; contactId: number; contactName: string; contactIbans: string[] };
export type OpenReceipt = { id: number; date: string | null; openCents: number; supplierName: string | null; invoiceNumber: string | null };
export type RuleMatch = { counterpartyContains?: string; descriptionContains?: string; iban?: string; direction?: "in" | "out" };
export type RuleAction =
  | { kind: "book"; accountCode: string; vatCode: string; contactId?: number | null }
  | { kind: "sale"; accountCode: string };
export type RuleLike = { id: number; name: string; match: RuleMatch; action: RuleAction; autoApply: boolean; active: boolean };
export type ContactLite = { id: number; name: string; kind: "business" | "consumer"; country: string; ibans: string[]; isCustomer: boolean };

export type Suggestion = {
  kind: "invoice" | "receipt" | "rule" | "sale" | "vat_payment";
  targetId?: number;
  label: string;
  reason: string;
  confidence: number; // 0..100
  auto: boolean;
  action?: RuleAction;
  amountCents?: number;
};

export const BELASTINGDIENST_IBAN = "NL86INGB0002445588";

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

export function ruleMatches(r: RuleLike, tx: TxLike): boolean {
  if (!r.active) return false;
  const m = r.match;
  if (!m.counterpartyContains && !m.descriptionContains && !m.iban) return false;
  if (m.direction === "in" && tx.amountCents <= 0) return false;
  if (m.direction === "out" && tx.amountCents >= 0) return false;
  if (m.counterpartyContains && !norm(tx.counterpartyName).includes(norm(m.counterpartyContains))) return false;
  if (m.descriptionContains && !norm(tx.description).includes(norm(m.descriptionContains))) return false;
  if (m.iban && normalizeIban(m.iban) !== normalizeIban(tx.counterpartyIban ?? "")) return false;
  return true;
}

/** Vindt factuurnummers als 2026-0042 of 20260042 in een omschrijving. */
export function invoiceNumbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(20\d{2})[-\s/]?(\d{4})\b/g)) out.add(`${m[1]}-${m[2]}`);
  return [...out];
}

export function suggest(tx: TxLike, ctx: { invoices: OpenInvoice[]; receipts: OpenReceipt[]; rules: RuleLike[]; contacts: ContactLite[] }): Suggestion[] {
  const out: Suggestion[] = [];
  const iban = tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : null;

  if (tx.amountCents > 0) {
    const nums = invoiceNumbersIn(tx.description);
    for (const inv of ctx.invoices) {
      const numHit = nums.includes(inv.number);
      const ibanHit = !!iban && inv.contactIbans.map(normalizeIban).includes(iban);
      const exact = inv.openCents === tx.amountCents;
      if (numHit && exact) {
        out.push({ kind: "invoice", targetId: inv.id, label: `Factuur ${inv.number} · ${inv.contactName}`, reason: "Factuurnummer in omschrijving en bedrag gelijk", confidence: 99, auto: true, amountCents: tx.amountCents });
      } else if (numHit) {
        out.push({ kind: "invoice", targetId: inv.id, label: `Factuur ${inv.number} · ${inv.contactName}`, reason: "Factuurnummer in omschrijving, bedrag wijkt af (deelbetaling?)", confidence: 75, auto: false, amountCents: Math.min(tx.amountCents, inv.openCents) });
      } else if (exact && ibanHit) {
        out.push({ kind: "invoice", targetId: inv.id, label: `Factuur ${inv.number} · ${inv.contactName}`, reason: "Bedrag gelijk en IBAN van deze klant", confidence: 85, auto: false, amountCents: tx.amountCents });
      } else if (exact) {
        out.push({ kind: "invoice", targetId: inv.id, label: `Factuur ${inv.number} · ${inv.contactName}`, reason: "Bedrag gelijk", confidence: 50, auto: false, amountCents: tx.amountCents });
      }
    }
  }

  if (tx.amountCents < 0 && iban === BELASTINGDIENST_IBAN) {
    out.push({ kind: "vat_payment", label: "Betaling BTW-aangifte", reason: "Betaling aan de Belastingdienst", confidence: 90, auto: false });
  }

  if (tx.amountCents < 0) {
    for (const r of ctx.receipts) {
      if (r.openCents !== -tx.amountCents) continue;
      const near = r.date ? Math.abs(daysBetween(r.date, tx.date)) <= 10 : false;
      const nameHit = !!r.supplierName && !!tx.counterpartyName &&
        (norm(tx.counterpartyName).includes(norm(r.supplierName).split(" ")[0]) || norm(r.supplierName).includes(norm(tx.counterpartyName).split(" ")[0]));
      const numHit = !!r.invoiceNumber && norm(tx.description).includes(norm(r.invoiceNumber));
      const conf = 55 + (near ? 15 : 0) + (nameHit ? 15 : 0) + (numHit ? 14 : 0);
      out.push({ kind: "receipt", targetId: r.id, label: `Bon ${r.supplierName ?? ""}${r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}`, reason: [near && "datum", nameHit && "naam", numHit && "factuurnummer", "bedrag"].filter(Boolean).join(", ") + " komen overeen", confidence: conf, auto: near && nameHit });
    }
  }

  for (const r of ctx.rules) {
    if (!ruleMatches(r, tx)) continue;
    out.push({ kind: "rule", targetId: r.id, label: r.name, reason: `Regel '${r.name}'`, confidence: 80, auto: r.autoApply, action: r.action });
  }

  if (tx.amountCents > 0 && iban) {
    const c = ctx.contacts.find((c) => c.ibans.map(normalizeIban).includes(iban));
    if (c && c.kind === "consumer" && !out.some((s) => s.kind === "invoice" && s.confidence >= 85)) {
      out.push({ kind: "sale", targetId: c.id, label: `Verkoop aan ${c.name} (${c.country})`, reason: "Particuliere klant herkend op IBAN", confidence: 70, auto: false });
    }
  }

  out.sort((a, b) => b.confidence - a.confidence);
  // auto alleen als er precies één automatische kandidaat is en die bovenaan staat
  const autos = out.filter((s) => s.auto);
  if (autos.length !== 1 || out[0] !== autos[0]) for (const s of out) s.auto = false;
  return out;
}
