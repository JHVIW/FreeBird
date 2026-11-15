import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceLayouts, emailTemplates } from "@/db/schema";
import { readStoredFile } from "./storage";
import { DEFAULT_LAYOUT, type PdfLayout } from "./pdf/invoice-pdf";
import type { Lang } from "./i18n";

export type LayoutRow = typeof invoiceLayouts.$inferSelect;

export async function getLayoutRow(id?: number | null): Promise<LayoutRow | null> {
  if (id) {
    const [r] = await db.select().from(invoiceLayouts).where(eq(invoiceLayouts.id, id));
    if (r) return r;
  }
  const [d] = await db.select().from(invoiceLayouts).orderBy(desc(invoiceLayouts.isDefault), asc(invoiceLayouts.id)).limit(1);
  return d ?? null;
}

/** Zet een opmaak om naar wat de PDF-renderer nodig heeft, incl. logo-bytes. */
export async function pdfLayout(id: number | null | undefined, lang: Lang): Promise<PdfLayout> {
  const r = await getLayoutRow(id);
  if (!r) return DEFAULT_LAYOUT;
  let logo: PdfLayout["logo"] = null;
  if (r.logoFileId) {
    const f = await readStoredFile(r.logoFileId);
    if (f) logo = { data: f.buf, format: f.mime === "image/png" ? "png" : "jpg" };
  }
  return {
    style: r.style, accentColor: r.accentColor, font: r.font, showPaymentBox: r.showPaymentBox, logo,
    footer: (lang === "en" ? r.footerEn : r.footerNl) || null,
  };
}

export type MailKind = "invoice" | "reminder" | "credit";

export async function listEmailTemplates(kind?: MailKind, lang?: Lang) {
  const conds = [];
  if (kind) conds.push(eq(emailTemplates.kind, kind));
  if (lang) conds.push(eq(emailTemplates.language, lang));
  return db.select().from(emailTemplates).where(conds.length ? and(...conds) : undefined).orderBy(desc(emailTemplates.isDefault), asc(emailTemplates.name));
}

/** Kiest de mailtekst: opgegeven id, anders de standaard voor soort + taal, anders een andere van die soort. */
export async function emailTemplateFor(kind: MailKind, lang: Lang, id?: number | null) {
  if (id) {
    const [r] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, id));
    if (r) return r;
  }
  const same = await listEmailTemplates(kind, lang);
  if (same[0]) return same[0];
  if (kind === "credit") return emailTemplateFor("invoice", lang);
  const any = await listEmailTemplates(kind);
  return any[0] ?? null;
}
