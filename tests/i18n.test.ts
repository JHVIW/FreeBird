import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { invoices, invoiceLayouts, emailTemplates } from "@/db/schema";
import { resetDb, makeContact } from "./db";
import { saveDraft, finalizeInvoice, createCreditNote, type InvoiceSnapshot } from "@/lib/invoices";
import { defaultEmail } from "@/lib/invoice-delivery";
import { contactLanguage, docMoney, docDate, mailVars } from "@/lib/i18n";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { pdfLayout } from "@/lib/templates";
import { fillTemplate } from "@/lib/mail";

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await sql.end(); });

describe("taal", () => {
  it("kiest automatisch op land, tenzij ingesteld", () => {
    expect(contactLanguage({ language: null, country: "NL" })).toBe("nl");
    expect(contactLanguage({ language: null, country: "DE" })).toBe("en");
    expect(contactLanguage({ language: "nl", country: "BE" })).toBe("nl");
    expect(contactLanguage({ language: "en", country: "NL" })).toBe("en");
  });
  it("formatteert Engelse bedragen en datums", () => {
    expect(docMoney(123456, "en")).toBe("€1,234.56");
    expect(docMoney(123456, "nl")).toBe("€ 1.234,56");
    expect(docDate("2026-10-01", "en")).toBe("1 October 2026");
  });
  it("vult Nederlandse en Engelse variabelen", () => {
    const v = mailVars({ number: "2026-0001", amountCents: 1000, dueDate: "2026-11-01", company: "Zwaluw", contact: "X", paymentUrl: null }, "en");
    expect(fillTemplate("{number} {nummer} {total} {duedate}", v)).toBe("2026-0001 2026-0001 €10.00 1 November 2026");
  });

  it("maakt een Engelse factuur voor een Duitse klant, met Engelse BTW-tekst en mail", async () => {
    const de = await makeContact({ name: "Nordlicht GmbH", country: "DE", vatNumber: "DE298765431", viesValid: true, email: "a@b.example" });
    const id = await saveDraft({ contactId: de.id, issueDate: "2026-10-01", lines: [{ description: "API work", quantity: 1, unitPriceCents: 100000, vatCode: "ICP_S", accountCode: "8100" }] });
    const [draft] = await db.select().from(invoices).where(eq(invoices.id, id));
    expect(draft.language).toBe("en");
    await finalizeInvoice(id);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const snap = inv.snapshot as InvoiceSnapshot;
    expect(snap.language).toBe("en");
    expect(snap.notes[0]).toMatch(/^Reverse charge/);
    const mail = await defaultEmail(id);
    expect(mail.subject).toBe("Invoice 2026-0001 from Studio Zwaluw");
    expect(mail.body).toContain("€1,000.00");
    const credit = await createCreditNote(id);
    const [cn] = await db.select().from(invoices).where(eq(invoices.id, credit));
    expect(cn.language).toBe("en");
    expect(cn.reference).toBe("Credit note for 2026-0001");
  });

  it("houdt Nederlands voor een NL-klant en respecteert de keuze op de klant", async () => {
    const nl = await makeContact({ name: "Pixelforge", country: "NL" });
    const be = await makeContact({ name: "Brams", country: "BE", language: "nl" });
    const a = await saveDraft({ contactId: nl.id, lines: [{ description: "x", quantity: 1, unitPriceCents: 100, vatCode: "V21", accountCode: "8000" }] });
    const b = await saveDraft({ contactId: be.id, lines: [{ description: "x", quantity: 1, unitPriceCents: 100, vatCode: "V21", accountCode: "8000" }] });
    const rows = await db.select().from(invoices);
    expect(rows.find((r) => r.id === a)!.language).toBe("nl");
    expect(rows.find((r) => r.id === b)!.language).toBe("nl");
  });

  it("standaard-opmaak en mailteksten zijn aangemaakt, en alle stijlen renderen", async () => {
    const layouts = await db.select().from(invoiceLayouts);
    expect(layouts.filter((l) => l.isDefault)).toHaveLength(1);
    const mails = await db.select().from(emailTemplates);
    expect(mails.map((m) => `${m.kind}-${m.language}`).sort()).toEqual(["credit-en", "credit-nl", "invoice-en", "invoice-nl", "reminder-en", "reminder-nl"]);
    const [inv] = await db.select().from(invoices).where(eq(invoices.number, "2026-0001"));
    for (const style of ["klassiek", "modern", "compact"]) {
      const [l] = await db.insert(invoiceLayouts).values({ name: style, style, accentColor: "#336699", font: style === "compact" ? "Times-Roman" : "Helvetica" }).returning();
      const pdf = await renderInvoicePdf({
        number: inv.number!, issueDate: inv.issueDate!, deliveryDate: null, dueDate: inv.dueDate!, reference: null, notes: null,
        subtotalCents: inv.subtotalCents, vatCents: 0, totalCents: inv.totalCents, paymentUrl: "https://bunq.me/x", isCredit: false,
        lines: [{ description: "API work", quantity: "1", unitPriceCents: 100000, rateBp: 0, baseCents: 100000, vatCents: 0, vatCode: "ICP_S" }],
        snapshot: inv.snapshot as InvoiceSnapshot, footer: "", language: "en", layout: await pdfLayout(l.id, "en"),
      });
      expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
    }
  });
});
