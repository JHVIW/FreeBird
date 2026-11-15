import type { InvoiceSnapshot } from "./invoices";

/** UBL 2.1 volgens Peppol BIS Billing 3.0. */

const esc = (s: string | null | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (cents: number) => (cents / 100).toFixed(2);

/** Electronic Address Scheme per land op basis van BTW-nummer. */
const EAS_VAT: Record<string, string> = {
  NL: "9944", BE: "9925", DE: "9930", FR: "9957", AT: "9914", IT: "9906", ES: "9920", LU: "9938", IE: "9935",
  PT: "9946", DK: "9902", SE: "9955", FI: "0213", GR: "9933", PL: "9945", CZ: "9929", SK: "9950", HU: "9910",
  SI: "9949", HR: "9934", RO: "9947", BG: "9926", EE: "9931", LV: "9939", LT: "9937", CY: "9928", MT: "9943",
};

type Category = { id: string; percent: number; reasonCode?: string; reason?: string };

export function taxCategory(kind: string, rateBp: number): Category {
  switch (kind) {
    case "standard":
    case "oss":
      return { id: "S", percent: rateBp / 100 };
    case "reverse_nl":
    case "icp_services":
      return { id: "AE", percent: 0, reasonCode: "VATEX-EU-AE", reason: "Reverse charge" };
    case "icp_goods":
      return { id: "K", percent: 0, reasonCode: "VATEX-EU-IC", reason: "Intra-community supply" };
    case "export":
      return { id: "G", percent: 0, reasonCode: "VATEX-EU-G", reason: "Export outside the EU" };
    case "nonEu_services":
      return { id: "O", percent: 0, reasonCode: "VATEX-EU-O", reason: "Not subject to VAT" };
    default:
      return { id: "Z", percent: 0 };
  }
}

export type UblInput = {
  number: string; issueDate: string; dueDate: string; deliveryDate: string | null; reference: string | null; isCredit: boolean;
  creditOfNumber?: string | null; currency: string; snapshot: InvoiceSnapshot;
  lines: { description: string; quantity: number; unitPriceCents: number; baseCents: number; vatCents: number; rateBp: number; kind: string }[];
  subtotalCents: number; vatCents: number; totalCents: number; paidCents: number; paymentUrl?: string | null;
};

function party(tag: string, p: { name: string; address: string | null; postcode: string | null; city: string | null; country: string; vatNumber: string | null; kvk?: string | null; email?: string | null }) {
  const vat = p.vatNumber?.replace(/\s/g, "").toUpperCase() ?? null;
  const vatCc = vat?.slice(0, 2) === "EL" ? "GR" : vat?.slice(0, 2);
  const eas = vat && vatCc ? EAS_VAT[vatCc] : undefined;
  const endpoint = eas && vat ? `<cbc:EndpointID schemeID="${eas}">${esc(vat)}</cbc:EndpointID>`
    : p.email ? `<cbc:EndpointID schemeID="EM">${esc(p.email)}</cbc:EndpointID>` : "";
  return `<cac:${tag}><cac:Party>${endpoint}
<cac:PostalAddress>${p.address ? `<cbc:StreetName>${esc(p.address)}</cbc:StreetName>` : ""}${p.city ? `<cbc:CityName>${esc(p.city)}</cbc:CityName>` : ""}${p.postcode ? `<cbc:PostalZone>${esc(p.postcode)}</cbc:PostalZone>` : ""}<cac:Country><cbc:IdentificationCode>${esc(p.country)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
${vat ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(vat)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ""}
<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>${p.kvk ? `<cbc:CompanyID schemeID="0106">${esc(p.kvk)}</cbc:CompanyID>` : ""}</cac:PartyLegalEntity>
${p.email ? `<cac:Contact><cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail></cac:Contact>` : ""}
</cac:Party></cac:${tag}>`;
}

export function buildUbl(x: UblInput): string {
  const root = x.isCredit ? "CreditNote" : "Invoice";
  const ns = x.isCredit ? "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" : "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  const sign = x.isCredit ? -1 : 1; // creditnota's hebben positieve bedragen in UBL
  const c = x.snapshot.company;
  const k = x.snapshot.contact;

  const groups = new Map<string, { cat: Category; base: number; vat: number }>();
  for (const l of x.lines) {
    const cat = taxCategory(l.kind, l.rateBp);
    const key = `${cat.id}|${cat.percent}`;
    const g = groups.get(key) ?? { cat, base: 0, vat: 0 };
    g.base += l.baseCents * sign; g.vat += l.vatCents * sign;
    groups.set(key, g);
  }
  const catXml = (cat: Category) =>
    `<cbc:ID>${cat.id}</cbc:ID><cbc:Percent>${cat.percent.toFixed(2)}</cbc:Percent>${cat.reasonCode ? `<cbc:TaxExemptionReasonCode>${cat.reasonCode}</cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>${esc(cat.reason)}</cbc:TaxExemptionReason>` : ""}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>`;
  const lineTag = x.isCredit ? "CreditNoteLine" : "InvoiceLine";
  const qtyTag = x.isCredit ? "CreditedQuantity" : "InvoicedQuantity";
  const payable = (x.totalCents - x.paidCents) * sign;

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
<cbc:ID>${esc(x.number)}</cbc:ID>
<cbc:IssueDate>${x.issueDate}</cbc:IssueDate>
${x.isCredit ? "" : `<cbc:DueDate>${x.dueDate}</cbc:DueDate>`}
<cbc:${x.isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>${x.isCredit ? "381" : "380"}</cbc:${x.isCredit ? "CreditNoteTypeCode" : "InvoiceTypeCode"}>
${x.snapshot.notes.map((n) => `<cbc:Note>${esc(n)}</cbc:Note>`).join("")}
<cbc:DocumentCurrencyCode>${x.currency}</cbc:DocumentCurrencyCode>
<cbc:BuyerReference>${esc(x.reference || x.number)}</cbc:BuyerReference>
${x.creditOfNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(x.creditOfNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
${party("AccountingSupplierParty", { name: c.name, address: c.address, postcode: c.postcode, city: c.city, country: c.country, vatNumber: c.vatNumber, kvk: c.kvk, email: c.email })}
${party("AccountingCustomerParty", { name: k.name, address: k.address, postcode: k.postcode, city: k.city, country: k.country, vatNumber: k.vatNumber, kvk: k.kvk, email: k.email })}
${x.deliveryDate ? `<cac:Delivery><cbc:ActualDeliveryDate>${x.deliveryDate}</cbc:ActualDeliveryDate></cac:Delivery>` : ""}
${x.isCredit ? "" : `<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>${esc(x.number)}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${esc(c.iban.replace(/\s/g, ""))}</cbc:ID><cbc:Name>${esc(c.name)}</cbc:Name>${c.bic ? `<cac:FinancialInstitutionBranch><cbc:ID>${esc(c.bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ""}</cac:PayeeFinancialAccount></cac:PaymentMeans>`}
<cac:TaxTotal><cbc:TaxAmount currencyID="${x.currency}">${amt(x.vatCents * sign)}</cbc:TaxAmount>
${[...groups.values()].map((g) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${x.currency}">${amt(g.base)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${x.currency}">${amt(g.vat)}</cbc:TaxAmount><cac:TaxCategory>${catXml(g.cat)}</cac:TaxCategory></cac:TaxSubtotal>`).join("\n")}
</cac:TaxTotal>
<cac:LegalMonetaryTotal>
<cbc:LineExtensionAmount currencyID="${x.currency}">${amt(x.subtotalCents * sign)}</cbc:LineExtensionAmount>
<cbc:TaxExclusiveAmount currencyID="${x.currency}">${amt(x.subtotalCents * sign)}</cbc:TaxExclusiveAmount>
<cbc:TaxInclusiveAmount currencyID="${x.currency}">${amt(x.totalCents * sign)}</cbc:TaxInclusiveAmount>
${x.paidCents ? `<cbc:PrepaidAmount currencyID="${x.currency}">${amt(x.paidCents * sign)}</cbc:PrepaidAmount>` : ""}
<cbc:PayableAmount currencyID="${x.currency}">${amt(payable)}</cbc:PayableAmount>
</cac:LegalMonetaryTotal>
${x.lines.map((l, i) => {
  const cat = taxCategory(l.kind, l.rateBp);
  const q = l.quantity * sign;
  return `<cac:${lineTag}><cbc:ID>${i + 1}</cbc:ID><cbc:${qtyTag} unitCode="C62">${q}</cbc:${qtyTag}><cbc:LineExtensionAmount currencyID="${x.currency}">${amt(l.baseCents * sign)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${esc(l.description.slice(0, 100))}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${cat.id}</cbc:ID><cbc:Percent>${cat.percent.toFixed(2)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${x.currency}">${amt(l.unitPriceCents)}</cbc:PriceAmount></cac:Price></cac:${lineTag}>`;
}).join("\n")}
</${root}>
`;
}
