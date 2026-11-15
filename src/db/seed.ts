import { db } from "./index";
import { accounts, vatCodes, fiscalParams, invoiceLayouts, emailTemplates } from "./schema";
import { eq } from "drizzle-orm";
import { DEFAULT_EMAIL_TEMPLATES } from "../lib/i18n";

type Acc = { code: string; name: string; type: "asset" | "liability" | "equity" | "revenue" | "expense"; ib?: string; vat?: string; system?: boolean };

export const ACCOUNTS: Acc[] = [
  // Balans
  { code: "0200", name: "Inventaris", type: "asset", ib: "Inventaris", system: true },
  { code: "0210", name: "Afschrijving inventaris", type: "asset", ib: "Inventaris", system: true },
  { code: "0900", name: "Ondernemingsvermogen", type: "equity", ib: "Ondernemingsvermogen", system: true },
  { code: "0910", name: "Privé-stortingen", type: "equity", ib: "Ondernemingsvermogen", system: true },
  { code: "0920", name: "Privé-onttrekkingen", type: "equity", ib: "Ondernemingsvermogen", system: true },
  { code: "1000", name: "Bank zakelijk", type: "asset", ib: "Liquide middelen", system: true },
  { code: "1100", name: "Debiteuren", type: "asset", ib: "Vorderingen", system: true },
  { code: "1500", name: "Te betalen BTW hoog", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1510", name: "Te betalen BTW laag", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1520", name: "Te betalen BTW verlegd", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1530", name: "Voorbelasting", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1540", name: "Te betalen BTW OSS", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1550", name: "Af te dragen BTW (aangifte)", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1600", name: "Crediteuren", type: "liability", ib: "Kortlopende schulden", system: true },
  { code: "1900", name: "Vraagposten", type: "asset", ib: "Vorderingen", system: true },
  // Kosten
  { code: "4510", name: "Hosting", type: "expense", ib: "Andere kosten", vat: "RC_EU" },
  { code: "4520", name: "Software & API", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4530", name: "Bankkosten", type: "expense", ib: "Andere kosten", vat: "NONE" },
  { code: "4600", name: "Telefoon & internet", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4610", name: "Kantoorbenodigdheden", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4620", name: "Kleine aanschaffingen", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4700", name: "Reiskosten", type: "expense", ib: "Auto- en transportkosten", vat: "I21" },
  { code: "4710", name: "Marketing & advertenties", type: "expense", ib: "Verkoopkosten", vat: "I21" },
  { code: "4720", name: "Representatie", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4730", name: "Opleiding & boeken", type: "expense", ib: "Andere kosten", vat: "I9" },
  { code: "4740", name: "Verzekeringen", type: "expense", ib: "Andere kosten", vat: "NONE" },
  { code: "4750", name: "Domeinnamen", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4800", name: "Overige kosten", type: "expense", ib: "Andere kosten", vat: "I21" },
  { code: "4900", name: "Afschrijvingen", type: "expense", ib: "Afschrijvingen", system: true },
  { code: "7000", name: "Inkoop materialen", type: "expense", ib: "Inkoopkosten", vat: "I21" },
  { code: "7010", name: "Verzendkosten inkoop", type: "expense", ib: "Inkoopkosten", vat: "I21" },
  // Omzet
  { code: "8000", name: "Omzet diensten NL", type: "revenue", ib: "Netto-omzet", vat: "V21" },
  { code: "8100", name: "Omzet diensten EU (verlegd)", type: "revenue", ib: "Netto-omzet", vat: "ICP_S" },
  { code: "8110", name: "Omzet leveringen EU (ICP)", type: "revenue", ib: "Netto-omzet", vat: "ICP_G" },
  { code: "8200", name: "Omzet buiten EU", type: "revenue", ib: "Netto-omzet", vat: "NONEU_S" },
  { code: "8300", name: "Omzet webshop", type: "revenue", ib: "Netto-omzet", vat: "V21" },
  { code: "8400", name: "Omzet producten", type: "revenue", ib: "Netto-omzet", vat: "V21" },
  { code: "8900", name: "Overige opbrengsten", type: "revenue", ib: "Overige opbrengsten", vat: "V21" },
];

type Vat = { code: string; name: string; direction: "sale" | "purchase"; rateBp: number | null; kind: string; rubriek: string | null; note?: string; noteEn?: string };

export const VAT_CODES: Vat[] = [
  { code: "V21", name: "Verkoop 21%", direction: "sale", rateBp: 2100, kind: "standard", rubriek: "1a" },
  { code: "V9", name: "Verkoop 9%", direction: "sale", rateBp: 900, kind: "standard", rubriek: "1b" },
  { code: "V0", name: "Verkoop 0% / niet bij u belast", direction: "sale", rateBp: 0, kind: "zero", rubriek: "1e" },
  { code: "VERL_NL", name: "Verkoop verlegd binnenland", direction: "sale", rateBp: 0, kind: "reverse_nl", rubriek: "1e", note: "BTW verlegd", noteEn: "VAT reverse charged" },
  { code: "ICP_S", name: "Diensten aan EU-ondernemer (verlegd)", direction: "sale", rateBp: 0, kind: "icp_services", rubriek: "3b", note: "BTW verlegd / Reverse charge (art. 44 en 196 Btw-richtlijn)", noteEn: "Reverse charge: VAT to be accounted for by the recipient (Articles 44 and 196 VAT Directive)" },
  { code: "ICP_G", name: "Intracommunautaire levering goederen", direction: "sale", rateBp: 0, kind: "icp_goods", rubriek: "3b", note: "Intracommunautaire levering, 0% (art. 138 Btw-richtlijn)", noteEn: "Intra-Community supply, 0% VAT (Article 138 VAT Directive)" },
  { code: "EXPORT", name: "Uitvoer goederen buiten EU", direction: "sale", rateBp: 0, kind: "export", rubriek: "3a", note: "Uitvoer, 0%", noteEn: "Export outside the EU, 0% VAT" },
  { code: "NONEU_S", name: "Diensten aan ondernemer buiten EU", direction: "sale", rateBp: 0, kind: "nonEu_services", rubriek: "1e", note: "BTW niet van toepassing, dienst verricht buiten de EU", noteEn: "Place of supply outside the EU, Dutch VAT not applicable" },
  { code: "OSS", name: "OSS: tarief land klant", direction: "sale", rateBp: null, kind: "oss", rubriek: null },
  { code: "I21", name: "Inkoop 21% (voorbelasting)", direction: "purchase", rateBp: 2100, kind: "standard", rubriek: "5b" },
  { code: "I9", name: "Inkoop 9% (voorbelasting)", direction: "purchase", rateBp: 900, kind: "standard", rubriek: "5b" },
  { code: "RC_EU", name: "Inkoop uit EU, BTW verlegd (4b)", direction: "purchase", rateBp: 2100, kind: "rc_eu", rubriek: "4b" },
  { code: "RC_NONEU", name: "Inkoop buiten EU, BTW verlegd (4a)", direction: "purchase", rateBp: 2100, kind: "rc_nonEu", rubriek: "4a" },
  { code: "RC_NL", name: "Inkoop binnenland, BTW verlegd (2a)", direction: "purchase", rateBp: 2100, kind: "rc_nl", rubriek: "2a" },
  { code: "NONE", name: "Geen BTW", direction: "purchase", rateBp: 0, kind: "none", rubriek: null },
];

/** Standaardtarieven EU 2026 voor digitale diensten (basispunten). Controleer jaarlijks. */
export const EU_RATES_2026: Record<string, number> = {
  AT: 2000, BE: 2100, BG: 2000, CY: 1900, CZ: 2100, DE: 1900, DK: 2500, EE: 2400, GR: 2400, ES: 2100,
  FI: 2550, FR: 2000, HR: 2500, HU: 2700, IE: 2300, IT: 2200, LT: 2100, LU: 1700, LV: 2100, MT: 1800,
  NL: 2100, PL: 2300, PT: 2300, RO: 2100, SE: 2500, SI: 2200, SK: 2300,
};

const PARAMS_2026: Record<string, { value: unknown; note?: string }> = {
  oss_threshold_cents: { value: 1_000_000, note: "EU-brede drempel B2C digitale diensten" },
  hours_criterion: { value: 1225 },
  self_employed_deduction_cents: { value: 120_000, note: "Zelfstandigenaftrek 2026" },
  mkb_profit_exemption_bp: { value: 1270, note: "MKB-winstvrijstelling 12,70%" },
  kia_min_investment_cents: { value: 290_100, note: "Controleren op belastingdienst.nl" },
  mixed_cost_accounts: { value: ["4720"], note: "Gemengde kosten (representatie, eten, drinken): 80% aftrekbaar. Drempel als alternatief in mixed_cost_threshold_cents" },
  eu_vat_rates_bp: { value: EU_RATES_2026, note: "Standaardtarieven, controleren voor OSS" },
  ib_rates: {
    value: {
      brackets: [{ uptoCents: 3_888_300, bp: 3575 }, { uptoCents: 7_842_600, bp: 3756 }, { uptoCents: null, bp: 4950 }],
      deductionCapBp: 3756,
      generalCredit: { maxCents: 311_500, phaseOutFromCents: 2_973_600, phaseOutBp: 639.8 },
      labourCredit: {
        steps: [{ uptoCents: 1_196_500, bp: 832.4 }, { uptoCents: 2_584_500, bp: 3100.9 }, { uptoCents: 4_559_200, bp: 195 }],
        phaseOutFromCents: 4_559_200, phaseOutBp: 651,
      },
      zvw: { bp: 485, maxBaseCents: 7_940_900 },
    },
    note: "Box 1 2026 (onder AOW-leeftijd), heffingskortingen en Zvw-bijdrage. Controleren op belastingdienst.nl",
  },
};

export async function seed() {
  for (const a of ACCOUNTS) {
    await db.insert(accounts).values({
      code: a.code, name: a.name, type: a.type, ibCategory: a.ib ?? null, defaultVatCode: a.vat ?? null, system: a.system ?? false,
    }).onConflictDoNothing();
  }
  for (const v of VAT_CODES) {
    await db.insert(vatCodes).values({
      code: v.code, name: v.name, direction: v.direction, rateBp: v.rateBp, kind: v.kind, rubriek: v.rubriek, invoiceNote: v.note ?? null, invoiceNoteEn: v.noteEn ?? null,
    }).onConflictDoNothing();
    if (v.noteEn) await db.update(vatCodes).set({ invoiceNoteEn: v.noteEn }).where(eq(vatCodes.code, v.code));
  }
  for (const year of [2026, 2027]) {
    for (const [key, p] of Object.entries(PARAMS_2026)) {
      await db.insert(fiscalParams).values({ year, key, value: p.value, note: year === 2026 ? p.note ?? null : `Overgenomen van 2026, controleren` })
        .onConflictDoNothing();
    }
  }
  const layouts = await db.select().from(invoiceLayouts).limit(1);
  if (!layouts.length) await db.insert(invoiceLayouts).values({ name: "Standaard", style: "klassiek", isDefault: true });
  const mails = await db.select().from(emailTemplates).limit(1);
  if (!mails.length) await db.insert(emailTemplates).values(DEFAULT_EMAIL_TEMPLATES.map((m) => ({ ...m, isDefault: true })));
}
