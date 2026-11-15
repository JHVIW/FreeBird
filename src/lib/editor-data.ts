import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, accounts, vatCodes, invoiceLayouts, invoiceTemplates } from "@/db/schema";
import { contactLanguage } from "./i18n";
import { getSetting } from "./settings";
import { getParam, ossStatus, ossAppliesTo } from "./vat";
import { today } from "./dates";
import type { EditorContact, EditorTemplate } from "@/components/invoice-editor";

export async function editorData() {
  const year = Number(today().slice(0, 4));
  const [cs, accs, codes, inv, rates, oss, layouts, tpls] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.archived, false)).orderBy(asc(contacts.name)),
    db.select().from(accounts).where(eq(accounts.type, "revenue")).orderBy(asc(accounts.code)),
    db.select().from(vatCodes).where(eq(vatCodes.direction, "sale")),
    getSetting("invoice"),
    getParam<Record<string, number>>(year, "eu_vat_rates_bp"),
    ossStatus(year),
    db.select().from(invoiceLayouts).orderBy(asc(invoiceLayouts.name)),
    db.select().from(invoiceTemplates).orderBy(asc(invoiceTemplates.name)),
  ]);
  return {
    contacts: cs.filter((c) => c.isCustomer).map((c): EditorContact => ({
      id: c.id, name: c.name, kind: c.kind, country: c.country, vatNumber: c.vatNumber, viesValid: c.viesValid,
      defaultAccountCode: c.defaultAccountCode, defaultVatCode: c.defaultVatCode, paymentTermDays: c.paymentTermDays,
      language: contactLanguage(c), layoutId: c.layoutId,
    })),
    layouts: layouts.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault })),
    templates: tpls.map((tp): EditorTemplate => ({ id: tp.id, name: tp.name, language: tp.language, reference: tp.reference, notes: tp.notes, lines: tp.lines as EditorTemplate["lines"] })),
    accounts: accs.map((a) => ({ code: a.code, name: a.name, rateBp: null })),
    vatCodes: codes.filter((c) => c.active).map((c) => ({ code: c.code, name: c.name, rateBp: c.rateBp, kind: c.kind })),
    euRates: rates ?? {},
    ossActive: ossAppliesTo(oss, 0),
    defaultTerm: inv.paymentTermDays,
  };
}
