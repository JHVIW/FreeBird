import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, invoiceLines, invoices, invoiceTemplates } from "@/db/schema";
import { aiJson } from "./ai";
import { contactLanguage } from "./i18n";
import { saleDefaultsFor, saveDraft, type LineInput } from "./invoices";
import { today } from "./dates";

type AiInvoice = {
  contactId?: unknown; unknownCustomer?: unknown; reference?: unknown; notes?: unknown; deliveryDate?: unknown;
  lines?: { description?: unknown; quantity?: unknown; unitPriceCents?: unknown }[];
};

/** Zet het AI-antwoord om in geldige regels; gooit een duidelijke fout als er iets ontbreekt. */
export function parseAiInvoice(r: AiInvoice, customerIds: Set<number>) {
  const contactId = Number(r.contactId);
  if (!customerIds.has(contactId)) {
    const name = typeof r.unknownCustomer === "string" && r.unknownCustomer.trim() ? r.unknownCustomer.trim() : null;
    throw new Error(name ? `Klant "${name}" bestaat nog niet. Maak hem eerst aan bij Klanten.` : "Ik herken geen klant in je tekst. Noem de naam van de klant.");
  }
  const lines = (r.lines ?? []).map((l) => ({
    description: String(l.description ?? "").trim().slice(0, 500),
    quantity: Number(l.quantity ?? 1),
    unitPriceCents: Math.round(Number(l.unitPriceCents)),
  })).filter((l) => l.description && Number.isFinite(l.quantity) && l.quantity !== 0 && Number.isFinite(l.unitPriceCents));
  if (!lines.length) throw new Error("Ik kon geen factuurregels met een prijs uit je tekst halen.");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);
  const deliveryDate = str(r.deliveryDate) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.deliveryDate)) ? String(r.deliveryDate) : null;
  return { contactId, lines, reference: str(r.reference), notes: str(r.notes), deliveryDate };
}

/** Maakt een conceptfactuur uit een korte beschrijving. Het concept moet je zelf nog nakijken en definitief maken. */
export async function draftInvoiceFromText(text: string): Promise<number> {
  if (text.trim().length < 5) throw new Error("Beschrijf wat je wilt factureren");
  const [customers, templates, recent] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.isCustomer, true)),
    db.select().from(invoiceTemplates).limit(30),
    db.select({ description: invoiceLines.description, unitPriceCents: invoiceLines.unitPriceCents, quantity: invoiceLines.quantity, contactId: invoices.contactId })
      .from(invoiceLines).innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId)).orderBy(desc(invoices.id)).limit(40),
  ]);
  const active = customers.filter((c) => !c.archived);
  const res = await aiJson<AiInvoice>({
    system: `Je maakt conceptfacturen voor een Nederlandse eenmanszaak of kleine onderneming.
Bedragen zijn in centen en EXCLUSIEF BTW. Staat er expliciet "incl. BTW" in de tekst, reken dan terug met 21%.
Schrijf de regelomschrijvingen in de taal van de klant (nl of en), zakelijk en kort. Een uurtarief wordt: aantal = uren, prijs = tarief.
Gebruik alleen klant-id's uit de lijst. Herken je de klant niet, laat contactId leeg en zet de genoemde naam in unknownCustomer.
Antwoord met een json-object: {"contactId":<id>,"unknownCustomer":"naam of leeg","lines":[{"description":"...","quantity":<getal>,"unitPriceCents":<integer>}],"reference":"optioneel, bijv. projectnaam of PO-nummer","notes":"optioneel","deliveryDate":"YYYY-MM-DD of leeg"}`,
    user: [
      `Vandaag: ${today()}`,
      "Klanten (id naam land taal):", ...active.map((c) => `${c.id} ${c.name} ${c.country} ${contactLanguage(c)}`),
      "", "Sjablonen:", ...templates.map((t) => `${t.name}: ${JSON.stringify(t.lines)}`),
      "", "Recente factuurregels (klant-id, omschrijving, aantal, prijs in centen):", ...recent.map((l) => `${l.contactId} | ${l.description} | ${l.quantity} | ${l.unitPriceCents}`),
      "", `Te factureren: ${text.trim().slice(0, 2000)}`,
    ].join("\n"),
    maxTokens: 1500,
  });
  const inv = parseAiInvoice(res, new Set(active.map((c) => c.id)));
  const def = await saleDefaultsFor(inv.contactId);
  const lines: LineInput[] = inv.lines.map((l) => ({ ...l, vatCode: def.vatCode, accountCode: def.accountCode }));
  return saveDraft({ contactId: inv.contactId, issueDate: today(), deliveryDate: inv.deliveryDate, reference: inv.reference, notes: inv.notes, lines });
}
