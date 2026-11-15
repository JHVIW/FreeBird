import { viesPrefix } from "./eu";

export type ViesResult = { valid: boolean; name?: string; address?: string; checkedAt: Date; raw?: unknown; error?: string };

/** Splitst "DE298765431" of "DE 298765431" in land + nummer. */
export function splitVatNumber(vat: string, fallbackCountry?: string): { cc: string; number: string } {
  const s = vat.replace(/[\s.\-]/g, "").toUpperCase();
  const m = s.match(/^([A-Z]{2})(.+)$/);
  if (m) return { cc: m[1] === "EL" ? "GR" : m[1], number: m[2] };
  return { cc: (fallbackCountry ?? "NL").toUpperCase(), number: s };
}

/** Controleert een BTW-nummer via de VIES REST API van de Europese Commissie. */
export async function checkVies(vat: string, fallbackCountry?: string): Promise<ViesResult> {
  const { cc, number } = splitVatNumber(vat, fallbackCountry);
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${viesPrefix(cc)}/vat/${encodeURIComponent(number)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const j = (await res.json()) as { isValid?: boolean; name?: string; address?: string; userError?: string };
    if (j.userError && j.userError !== "VALID" && j.userError !== "INVALID") {
      return { valid: false, checkedAt: new Date(), raw: j, error: `VIES niet beschikbaar (${j.userError}), probeer later opnieuw` };
    }
    return { valid: !!j.isValid, name: j.name && j.name !== "---" ? j.name : undefined, address: j.address, checkedAt: new Date(), raw: j };
  } catch (e) {
    return { valid: false, checkedAt: new Date(), error: `VIES niet bereikbaar: ${(e as Error).message}` };
  }
}
