import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { pdfLayout } from "@/lib/templates";
import { getSetting } from "@/lib/settings";
import { today, addDays } from "@/lib/dates";

export const runtime = "nodejs";

/** Voorbeeld-PDF van een opmaak met fictieve klant. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lang = new URL(req.url).searchParams.get("lang") === "en" ? "en" : "nl";
  const company = await getSetting("company");
  const d = today();
  const pdf = await renderInvoicePdf({
    number: `${d.slice(0, 4)}-0000`, issueDate: d, deliveryDate: null, dueDate: addDays(d, 30), reference: lang === "en" ? "Example" : "Voorbeeld", notes: null,
    subtotalCents: 245000, vatCents: 0, totalCents: 245000, paymentUrl: "https://bunq.me/voorbeeld", isCredit: false, language: lang,
    lines: [
      { description: lang === "en" ? "API integration, September" : "API-integratie, september", quantity: "1", unitPriceCents: 160000, rateBp: 0, baseCents: 160000, vatCents: 0, vatCode: "ICP_S" },
      { description: lang === "en" ? "Hosting and maintenance" : "Hosting en onderhoud", quantity: "1", unitPriceCents: 85000, rateBp: 0, baseCents: 85000, vatCents: 0, vatCode: "ICP_S" },
    ],
    snapshot: {
      company,
      contact: { name: "Voorbeeld GmbH", contactPerson: null, address: "Musterstraße 1", postcode: "10115", city: "Berlin", country: "DE", vatNumber: "DE123456789", kvk: null, kind: "business", email: null },
      notes: [lang === "en" ? "Reverse charge: VAT to be accounted for by the recipient (Articles 44 and 196 VAT Directive)" : "BTW verlegd / Reverse charge (art. 44 en 196 Btw-richtlijn)"],
      language: lang,
    },
    footer: "", layout: await pdfLayout(Number(id), lang),
  });
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=voorbeeld.pdf", "Cache-Control": "no-store" } });
}
