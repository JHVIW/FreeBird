export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "GR", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

export function isEU(cc: string | null | undefined): boolean {
  return !!cc && (EU_COUNTRIES as readonly string[]).includes(cc.toUpperCase());
}

/** VIES gebruikt EL voor Griekenland. */
export function viesPrefix(cc: string): string {
  return cc.toUpperCase() === "GR" ? "EL" : cc.toUpperCase();
}

export const COUNTRY_NAMES: Record<string, string> = {
  NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", LU: "Luxemburg", AT: "Oostenrijk", ES: "Spanje", PT: "Portugal",
  IT: "Italië", GR: "Griekenland", IE: "Ierland", DK: "Denemarken", SE: "Zweden", FI: "Finland", PL: "Polen", CZ: "Tsjechië",
  SK: "Slowakije", HU: "Hongarije", SI: "Slovenië", HR: "Kroatië", RO: "Roemenië", BG: "Bulgarije", EE: "Estland", LV: "Letland",
  LT: "Litouwen", CY: "Cyprus", MT: "Malta", GB: "Verenigd Koninkrijk", US: "Verenigde Staten", CH: "Zwitserland", NO: "Noorwegen",
  CA: "Canada", AU: "Australië", TR: "Turkije", UA: "Oekraïne", BR: "Brazilië", RU: "Rusland", CN: "China", JP: "Japan", IN: "India",
};

export function countryName(cc: string | null | undefined): string {
  if (!cc) return "";
  return COUNTRY_NAMES[cc.toUpperCase()] ?? cc.toUpperCase();
}

/** Landcode uit IBAN (eerste twee letters), voor OSS-bewijs. */
export function ibanCountry(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const m = iban.replace(/\s/g, "").toUpperCase().match(/^([A-Z]{2})\d{2}/);
  return m ? m[1] : null;
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

export function formatIban(iban: string | null | undefined): string {
  if (!iban) return "";
  return normalizeIban(iban).replace(/(.{4})/g, "$1 ").trim();
}
