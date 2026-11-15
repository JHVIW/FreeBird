import { isEU } from "./eu";

export type Customer = { kind: "business" | "consumer"; country: string; vatNumber?: string | null; viesValid?: boolean | null };
export type SupplyType = "services" | "goods" | "digital";

/**
 * Bepaalt de BTW-behandeling van een verkoop.
 * ossActive: of voor deze verkoop het OSS-regime geldt (drempel overschreden).
 */
export function determineSaleVat(c: Customer, supply: SupplyType, ossActive: boolean): { vatCode: string; country: string } {
  const cc = c.country.toUpperCase();
  const validBusiness = c.kind === "business" && !!c.vatNumber && c.viesValid !== false;
  if (cc === "NL") return { vatCode: "V21", country: cc };
  if (isEU(cc)) {
    if (validBusiness) return { vatCode: supply === "goods" ? "ICP_G" : "ICP_S", country: cc };
    return { vatCode: ossActive ? "OSS" : "V21", country: cc };
  }
  if (supply === "goods") return { vatCode: "EXPORT", country: cc };
  return { vatCode: "NONEU_S", country: cc };
}

