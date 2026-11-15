import { and, eq, lte, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { invoices, invoiceEvents, recurringInvoices } from "@/db/schema";
import { getInvoice, finalizeInvoice, saveDraft, type InvoiceSnapshot, type LineInput } from "./invoices";
import { renderInvoicePdf } from "./pdf/invoice-pdf";
import { buildUbl } from "./ubl";
import { storeFile, readStoredFile } from "./storage";
import { getSetting } from "./settings";
import { getVatCodes } from "./vat";
import { sendMail, fillTemplate } from "./mail";
import { mailVars, type Lang } from "./i18n";
import { pdfLayout, emailTemplateFor, type MailKind } from "./templates";
import { createBunqmeTab } from "./bunq/client";
import { fmtDate, today, addMonths, daysBetween } from "./dates";

/** Maakt PDF + UBL (en optioneel een bunq.me-link) voor een definitieve factuur. */
export async function generateArtifacts(id: number, opts: { force?: boolean } = {}) {
  const data = await getInvoice(id);
  if (!data || data.inv.status === "draft") throw new Error("Factuur is nog geen definitieve factuur");
  const { inv, lines } = data;
  if (inv.pdfFileId && inv.ublFileId && !opts.force) return inv;
  const settings = await getSetting("invoice");
  const codes = await getVatCodes();
  const snapshot = inv.snapshot as InvoiceSnapshot;
  const isCredit = !!inv.creditOf || inv.totalCents < 0;
  const lang = (inv.language === "en" ? "en" : "nl") as Lang;

  let paymentUrl = inv.paymentUrl;
  if (!paymentUrl && !isCredit && settings.bunqmeLinks && inv.totalCents > 0) {
    const bunq = await getSetting("bunq");
    if (bunq.apiKey && bunq.monetaryAccountId) {
      try {
        const tab = await createBunqmeTab(bunq.monetaryAccountId, inv.totalCents, `${lang === "en" ? "Invoice" : "Factuur"} ${inv.number}`);
        paymentUrl = tab.url;
        await db.update(invoices).set({ paymentUrl, bunqmeTabId: String(tab.id) }).where(eq(invoices.id, id));
      } catch (e) {
        console.warn("bunq.me-link maken mislukt:", (e as Error).message);
      }
    }
  }

  const pdf = await renderInvoicePdf({
    number: inv.number!, issueDate: inv.issueDate!, deliveryDate: inv.deliveryDate, dueDate: inv.dueDate!, reference: inv.reference, notes: inv.notes,
    subtotalCents: inv.subtotalCents, vatCents: inv.vatCents, totalCents: inv.totalCents, paymentUrl, isCredit,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, rateBp: l.rateBp, baseCents: l.baseCents, vatCents: l.vatCents, vatCode: l.vatCode })),
    snapshot, footer: settings.footer, language: lang, layout: await pdfLayout(inv.layoutId, lang),
  });
  const ubl = buildUbl({
    number: inv.number!, issueDate: inv.issueDate!, dueDate: inv.dueDate!, deliveryDate: inv.deliveryDate, reference: inv.reference, isCredit,
    creditOfNumber: snapshot.creditOfNumber, currency: inv.currency, snapshot, paymentUrl,
    lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unitPriceCents, baseCents: l.baseCents, vatCents: l.vatCents, rateBp: l.rateBp, kind: codes.get(l.vatCode)!.kind })),
    subtotalCents: inv.subtotalCents, vatCents: inv.vatCents, totalCents: inv.totalCents, paidCents: 0,
  });
  const pdfFile = await storeFile(Buffer.from(pdf), `${inv.number}.pdf`, "application/pdf");
  const ublFile = await storeFile(Buffer.from(ubl, "utf8"), `${inv.number}.xml`, "application/xml");
  const [updated] = await db.update(invoices).set({ pdfFileId: pdfFile.id, ublFileId: ublFile.id }).where(eq(invoices.id, id)).returning();
  return updated;
}

export function mailKindFor(inv: { creditOf: number | null; totalCents: number }, kind: "invoice" | "reminder"): MailKind {
  if (kind === "reminder") return "reminder";
  return inv.creditOf || inv.totalCents < 0 ? "credit" : "invoice";
}

/** Vult de mailtekst voor een factuur in de taal van de factuur. */
export async function defaultEmail(id: number, kind: "invoice" | "reminder" = "invoice", templateId?: number | null) {
  const data = await getInvoice(id);
  if (!data) throw new Error("Factuur niet gevonden");
  const lang = (data.inv.language === "en" ? "en" : "nl") as Lang;
  const company = await getSetting("company");
  const tpl = await emailTemplateFor(mailKindFor(data.inv, kind), lang, templateId);
  const v = mailVars({
    number: data.inv.number ?? "", amountCents: kind === "reminder" ? data.inv.totalCents - data.inv.paidCents : data.inv.totalCents,
    dueDate: data.inv.dueDate, company: company.name, contact: data.contact.contactPerson ?? data.contact.name, paymentUrl: data.inv.paymentUrl,
  }, lang);
  return {
    to: data.contact.invoiceEmail ?? data.contact.email ?? "",
    subject: fillTemplate(tpl?.subject ?? "{number}", v),
    body: fillTemplate(tpl?.body ?? "", v),
    templateId: tpl?.id ?? null,
    language: lang,
  };
}

export async function sendInvoice(id: number, msg: { to: string; subject: string; body: string }, kind: "invoice" | "reminder" = "invoice") {
  let inv = await generateArtifacts(id);
  const settings = await getSetting("invoice");
  if (!msg.to) throw new Error("Geen e-mailadres voor deze klant");
  const pdf = await readStoredFile(inv.pdfFileId!);
  const attachments = [{ filename: `${inv.number}.pdf`, content: pdf!.buf, contentType: "application/pdf" }];
  if (settings.attachUbl && inv.ublFileId) {
    const ubl = await readStoredFile(inv.ublFileId);
    attachments.push({ filename: `${inv.number}.xml`, content: ubl!.buf, contentType: "application/xml" });
  }
  const res = await sendMail({ to: msg.to, subject: msg.subject, text: msg.body, attachments });
  if (kind === "invoice") {
    [inv] = await db.update(invoices).set({ sentAt: new Date() }).where(eq(invoices.id, id)).returning();
    await db.insert(invoiceEvents).values({ invoiceId: id, type: "sent", meta: { to: msg.to, messageId: res.messageId } });
  } else {
    await db.update(invoices).set({ remindersSent: dsql`${invoices.remindersSent} + 1` }).where(eq(invoices.id, id));
    await db.insert(invoiceEvents).values({ invoiceId: id, type: "reminder", meta: { to: msg.to, messageId: res.messageId, n: inv.remindersSent + 1 } });
  }
  return res;
}

/** Stuurt herinneringen voor verlopen facturen volgens het schema in Instellingen. */
export async function processReminders(on = today()) {
  const s = await getSetting("invoice");
  if (!s.reminderDays.length) return { sent: 0 };
  const open = await db.select().from(invoices).where(and(eq(invoices.status, "open"), lte(invoices.dueDate, on)));
  let sent = 0;
  for (const inv of open) {
    if (!inv.sentAt || !inv.dueDate || inv.totalCents <= 0) continue;
    const late = daysBetween(inv.dueDate, on);
    const due = s.reminderDays[inv.remindersSent];
    if (due == null || late < due) continue;
    try {
      const msg = await defaultEmail(inv.id, "reminder");
      await sendInvoice(inv.id, msg, "reminder");
      sent++;
    } catch (e) {
      console.warn(`Herinnering ${inv.number} mislukt:`, (e as Error).message);
    }
  }
  return { sent };
}

/** Maakt facturen aan voor terugkerende schema's waarvan de datum bereikt is. */
export async function processRecurring(on = today()) {
  const due = await db.select().from(recurringInvoices).where(and(eq(recurringInvoices.active, true), lte(recurringInvoices.nextDate, on)));
  let created = 0;
  for (const r of due) {
    const id = await saveDraft({ contactId: r.contactId, issueDate: r.nextDate, reference: r.description, lines: r.lines as LineInput[], recurringId: r.id, layoutId: r.layoutId });
    await db.update(recurringInvoices).set({ nextDate: addMonths(r.nextDate, r.intervalMonths) }).where(eq(recurringInvoices.id, r.id));
    created++;
    if (r.autoSend) {
      try {
        await finalizeInvoice(id);
        const msg = await defaultEmail(id);
        await sendInvoice(id, msg);
      } catch (e) {
        console.warn(`Terugkerende factuur ${r.id} niet automatisch verstuurd:`, (e as Error).message);
      }
    }
  }
  return { created };
}
