/** Alle bedragen zijn integers in centen. Nooit floats opslaan. */

const nf = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatEur(cents: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (cents == null) return "";
  const neg = cents < 0;
  const s = nf.format(Math.abs(cents) / 100);
  const pre = neg ? "−" : opts.sign && cents > 0 ? "+" : "";
  return `${pre}€ ${s}`;
}

export function formatWholeEur(euros: number): string {
  return new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 }).format(euros);
}

/** Parse "1.234,56", "1234.56", "€ 12,50", "-3,00" naar centen. */
export function parseEur(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = String(input).trim().replace(/[€\s]/g, "").replace("−", "-");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, "");
  else if (lastComma === -1 && (s.match(/\./g)?.length ?? 0) > 1) s = s.replace(/\./g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [int, frac = ""] = s.replace("-", "").split(".");
  const c = Number(int) * 100 + Number((frac + "00").slice(0, 2)) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0);
  return neg ? -c : c;
}

/** Bankiers-onafhankelijke afronding half-up op hele centen. */
export function roundHalfUp(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** BTW over een bedrag in centen met tarief in basispunten. */
export function vatOf(baseCents: number, rateBp: number): number {
  return roundHalfUp((baseCents * rateBp) / 10000);
}

/** Splits een bedrag incl. BTW in basis + BTW. */
export function splitGross(grossCents: number, rateBp: number): { base: number; vat: number } {
  if (rateBp === 0) return { base: grossCents, vat: 0 };
  const base = roundHalfUp((grossCents * 10000) / (10000 + rateBp));
  return { base, vat: grossCents - base };
}

export function lineBase(quantity: number, unitPriceCents: number): number {
  return roundHalfUp(quantity * unitPriceCents);
}

export function formatPct(bp: number | null | undefined): string {
  if (bp == null) return "";
  return `${(bp / 100).toLocaleString("nl-NL")}%`;
}
