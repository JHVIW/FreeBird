"use server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { invoiceLayouts, invoiceTemplates, emailTemplates, contacts, invoices } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { storeFile } from "@/lib/storage";
import { saveDraft, saleDefaultsFor, type LineInput } from "@/lib/invoices";

const B = "/facturen/sjablonen";

export async function saveLayout(fd: FormData) {
  const id = fnum(fd, "rowId");
  await run(`${B}#opmaak`, async () => {
    const color = fstr(fd, "accentColor");
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Kleur moet een hexcode zijn, bijv. #1E6B47");
    const values: Partial<typeof invoiceLayouts.$inferInsert> = {
      name: fstr(fd, "name") || "Opmaak", style: fstr(fd, "style") || "klassiek", accentColor: color, font: fstr(fd, "font") || "Helvetica",
      showPaymentBox: fbool(fd, "showPaymentBox"), footerNl: fstr(fd, "footerNl") || null, footerEn: fstr(fd, "footerEn") || null, isDefault: fbool(fd, "isDefault"),
    };
    const logo = fd.get("logo");
    if (logo instanceof File && logo.size > 0) {
      if (!["image/png", "image/jpeg"].includes(logo.type)) throw new Error("Logo moet PNG of JPG zijn");
      if (logo.size > 2_000_000) throw new Error("Logo is groter dan 2 MB");
      const f = await storeFile(Buffer.from(await logo.arrayBuffer()), logo.name, logo.type);
      values.logoFileId = f.id;
    }
    if (fbool(fd, "removeLogo")) values.logoFileId = null;
    let lid = id;
    if (id) await db.update(invoiceLayouts).set(values).where(eq(invoiceLayouts.id, id));
    else lid = (await db.insert(invoiceLayouts).values(values as typeof invoiceLayouts.$inferInsert).returning())[0].id;
    if (values.isDefault) await db.update(invoiceLayouts).set({ isDefault: false }).where(ne(invoiceLayouts.id, lid!));
    return `${B}?layout=${lid}#opmaak`;
  }, "Opmaak opgeslagen");
}

export async function deleteLayout(fd: FormData) {
  await run(`${B}#opmaak`, async () => {
    const id = Number(fd.get("rowId"));
    const [l] = await db.select().from(invoiceLayouts).where(eq(invoiceLayouts.id, id));
    if (l?.isDefault) throw new Error("De standaardopmaak kun je niet verwijderen. Maak eerst een andere opmaak standaard.");
    await db.update(contacts).set({ layoutId: null }).where(eq(contacts.layoutId, id));
    await db.update(invoices).set({ layoutId: null }).where(and(eq(invoices.layoutId, id), eq(invoices.status, "draft")));
    await db.delete(invoiceLayouts).where(eq(invoiceLayouts.id, id));
    return `${B}#opmaak`;
  }, "Opmaak verwijderd");
}

export async function saveEmailTemplate(fd: FormData) {
  const id = fnum(fd, "rowId");
  await run(`${B}#mail`, async () => {
    const kind = fstr(fd, "kind"), language = fstr(fd, "language");
    if (!["invoice", "reminder", "credit"].includes(kind) || !["nl", "en"].includes(language)) throw new Error("Ongeldige soort of taal");
    const values = { name: fstr(fd, "name") || "Mailtekst", kind, language, subject: fstr(fd, "subject"), body: String(fd.get("body") ?? ""), isDefault: fbool(fd, "isDefault") };
    if (!values.subject || !values.body.trim()) throw new Error("Onderwerp en tekst zijn verplicht");
    let tid = id;
    if (id) await db.update(emailTemplates).set(values).where(eq(emailTemplates.id, id));
    else tid = (await db.insert(emailTemplates).values(values).returning())[0].id;
    if (values.isDefault) {
      await db.update(emailTemplates).set({ isDefault: false })
        .where(and(eq(emailTemplates.kind, kind), eq(emailTemplates.language, language), ne(emailTemplates.id, tid!)));
    }
    return `${B}?mail=${tid}#mail`;
  }, "Mailtekst opgeslagen");
}

export async function deleteEmailTemplate(fd: FormData) {
  await run(`${B}#mail`, async () => { await db.delete(emailTemplates).where(eq(emailTemplates.id, Number(fd.get("rowId")))); return `${B}#mail`; }, "Mailtekst verwijderd");
}

export async function deleteInvoiceTemplate(fd: FormData) {
  await run(`${B}#inhoud`, async () => { await db.delete(invoiceTemplates).where(eq(invoiceTemplates.id, Number(fd.get("rowId")))); return `${B}#inhoud`; }, "Sjabloon verwijderd");
}

export async function renameInvoiceTemplate(fd: FormData) {
  await run(`${B}#inhoud`, async () => {
    await db.update(invoiceTemplates).set({ name: fstr(fd, "name"), language: fstr(fd, "language") || null }).where(eq(invoiceTemplates.id, Number(fd.get("rowId"))));
    return `${B}#inhoud`;
  }, "Opgeslagen");
}

/** Nieuwe concept-factuur op basis van een inhoudssjabloon. */
export async function invoiceFromTemplate(fd: FormData) {
  await run(`${B}#inhoud`, async () => {
    const [tpl] = await db.select().from(invoiceTemplates).where(eq(invoiceTemplates.id, Number(fd.get("rowId"))));
    const contactId = fnum(fd, "contactId");
    if (!contactId) throw new Error("Kies een klant");
    const d = await saleDefaultsFor(contactId);
    const lines = (tpl.lines as Partial<LineInput>[]).map((l) => ({
      description: l.description ?? "", quantity: Number(l.quantity ?? 1), unitPriceCents: Number(l.unitPriceCents ?? 0), vatCode: d.vatCode, accountCode: l.accountCode ?? d.accountCode,
    }));
    const id = await saveDraft({ contactId, reference: tpl.reference, notes: tpl.notes, lines });
    return `/facturen/${id}`;
  }, "Concept aangemaakt uit sjabloon");
}
