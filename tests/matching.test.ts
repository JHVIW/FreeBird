import { describe, it, expect } from "vitest";
import { suggest, invoiceNumbersIn, BELASTINGDIENST_IBAN } from "@/lib/matching";

const base = { id: 1, date: "2026-09-27", counterpartyName: "Nordlicht GmbH", counterpartyIban: "DE44500105175407324931", description: "" };
const inv = { id: 10, number: "2026-0041", openCents: 245000, contactId: 5, contactName: "Nordlicht GmbH", contactIbans: [] as string[] };

describe("matching", () => {
  it("vindt factuurnummers", () => {
    expect(invoiceNumbersIn("Inv 2026-0041 en 20260042")).toEqual(["2026-0041", "2026-0042"]);
  });
  it("auto bij nummer + bedrag", () => {
    const s = suggest({ ...base, amountCents: 245000, description: "Inv 2026-0041" }, { invoices: [inv], receipts: [], rules: [], contacts: [] });
    expect(s[0]).toMatchObject({ kind: "invoice", targetId: 10, auto: true });
  });
  it("geen auto bij alleen bedrag", () => {
    const s = suggest({ ...base, amountCents: 245000, description: "betaling" }, { invoices: [inv], receipts: [], rules: [], contacts: [] });
    expect(s[0]).toMatchObject({ kind: "invoice", auto: false });
  });
  it("regel wint niet van auto-factuur, maar twee autos = geen auto", () => {
    const rule = { id: 1, name: "Nordlicht", match: { counterpartyContains: "nordlicht" }, action: { kind: "book" as const, accountCode: "8000", vatCode: "V21" }, autoApply: true, active: true };
    const s = suggest({ ...base, amountCents: 245000, description: "Inv 2026-0041" }, { invoices: [inv], receipts: [], rules: [rule], contacts: [] });
    expect(s.filter((x) => x.auto)).toHaveLength(0);
  });
  it("herkent particuliere klant op IBAN", () => {
    const s = suggest({ ...base, amountCents: 5988, description: "WEB-ORD-1" }, { invoices: [], receipts: [], rules: [], contacts: [{ id: 3, name: "M. Schneider", kind: "consumer", country: "DE", ibans: ["DE44500105175407324931"], isCustomer: true }] });
    expect(s[0]).toMatchObject({ kind: "sale", targetId: 3 });
  });
  it("bon op bedrag en datum", () => {
    const s = suggest({ ...base, counterpartyName: "Filamentwinkel.nl", amountCents: -6497, description: "Order 88214" }, { invoices: [], receipts: [{ id: 7, date: "2026-09-22", openCents: 6497, supplierName: "Filamentwinkel.nl", invoiceNumber: "88214" }], rules: [], contacts: [] });
    expect(s[0]).toMatchObject({ kind: "receipt", targetId: 7 });
    expect(s[0].confidence).toBeGreaterThan(90);
  });
  it("Belastingdienst", () => {
    const s = suggest({ ...base, counterpartyIban: BELASTINGDIENST_IBAN, amountCents: -106200 }, { invoices: [], receipts: [], rules: [], contacts: [] });
    expect(s[0].kind).toBe("vat_payment");
  });
});
