/** Teksten voor documenten die naar klanten gaan (PDF, mail, UBL-notities). */

export type Lang = "nl" | "en";
export const LANGS: { code: Lang; label: string }[] = [{ code: "nl", label: "Nederlands" }, { code: "en", label: "Engels" }];

/** Taal van een klant: expliciet ingesteld, anders NL voor Nederland en Engels voor de rest. */
export function contactLanguage(c: { language: string | null; country: string }): Lang {
  if (c.language === "nl" || c.language === "en") return c.language;
  return c.country.toUpperCase() === "NL" ? "nl" : "en";
}

const T = {
  nl: {
    invoice: "Factuur", creditNote: "Creditnota", to: "Aan", attn: "t.a.v.", vatNumber: "BTW-nummer", cocShort: "KvK", vatShort: "BTW",
    invoiceDate: "Factuurdatum", deliveryDate: "Leverdatum", dueDate: "Vervaldatum", reference: "Referentie", creditOf: "Creditering van", invoiceWord: "Factuur",
    description: "Omschrijving", qty: "Aantal", price: "Prijs", vat: "BTW", total: "Totaal", subtotal: "Subtotaal",
    vatOver: (rate: string, base: string) => `BTW ${rate} over ${base}`,
    payBefore: (date: string) => `Graag vóór ${date} overmaken op`,
    payTo: (iban: string, name: string) => `${iban} t.n.v. ${name}`,
    payRef: (n: string) => `onder vermelding van ${n}`,
    payNow: "Direct betalen",
    page: "Pagina",
  },
  en: {
    invoice: "Invoice", creditNote: "Credit note", to: "Bill to", attn: "Attn.", vatNumber: "VAT number", cocShort: "CoC", vatShort: "VAT",
    invoiceDate: "Invoice date", deliveryDate: "Delivery date", dueDate: "Due date", reference: "Reference", creditOf: "Credit for", invoiceWord: "Invoice",
    description: "Description", qty: "Qty", price: "Unit price", vat: "VAT", total: "Total", subtotal: "Subtotal",
    vatOver: (rate: string, base: string) => `VAT ${rate} on ${base}`,
    payBefore: (date: string) => `Please pay before ${date} to`,
    payTo: (iban: string, name: string) => `${iban}, account holder ${name}`,
    payRef: (n: string) => `quoting reference ${n}`,
    payNow: "Pay now",
    page: "Page",
  },
} as const;

export function t(lang: Lang) {
  return T[lang] ?? T.nl;
}

const MONTHS: Record<Lang, string[]> = {
  nl: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

export function docDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return lang === "en" ? `${d} ${MONTHS.en[m - 1]} ${y}` : `${d} ${MONTHS.nl[m - 1]} ${y}`;
}

export function docMoney(cents: number, lang: Lang): string {
  const n = new Intl.NumberFormat(lang === "en" ? "en-IE" : "nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(cents) / 100);
  const sign = cents < 0 ? "-" : "";
  return lang === "en" ? `${sign}€${n}` : `${sign}€ ${n}`;
}

export function docPct(bp: number, lang: Lang): string {
  return `${(bp / 100).toLocaleString(lang === "en" ? "en-IE" : "nl-NL")}%`;
}

export function docQty(q: string | number, lang: Lang): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toLocaleString(lang === "en" ? "en-IE" : "nl-NL");
}

export function docCountry(cc: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([lang === "en" ? "en" : "nl"], { type: "region" }).of(cc.toUpperCase() === "EL" ? "GR" : cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

/** Variabelen voor mailteksten. Nederlandse en Engelse namen werken allebei. */
export function mailVars(x: { number: string; amountCents: number; dueDate: string | null; company: string; contact: string; paymentUrl: string | null }, lang: Lang) {
  const total = docMoney(x.amountCents, lang);
  const due = docDate(x.dueDate, lang);
  const link = x.paymentUrl ? `\n${lang === "en" ? "Pay online" : "Direct betalen"}: ${x.paymentUrl}\n` : "";
  return {
    nummer: x.number, number: x.number, totaal: total, total, amount: total, vervaldatum: due, duedate: due, due_date: due,
    bedrijf: x.company, company: x.company, klant: x.contact, customer: x.contact, betaallink: link, paymentlink: link, payment_link: link,
  };
}

export const MAIL_VARS_HELP = "{nummer}/{number} {totaal}/{total} {vervaldatum}/{duedate} {bedrijf}/{company} {klant}/{customer} {betaallink}/{paymentlink}";

/** Standaard mailteksten die bij de eerste start worden aangemaakt. */
export const DEFAULT_EMAIL_TEMPLATES = [
  { name: "Factuur (NL)", kind: "invoice", language: "nl", subject: "Factuur {nummer} van {bedrijf}", body: "Hallo,\n\nIn de bijlage vind je factuur {nummer} van {totaal}. Graag betaald vóór {vervaldatum}.\n{betaallink}\nGroet,\n{bedrijf}" },
  { name: "Invoice (EN)", kind: "invoice", language: "en", subject: "Invoice {number} from {company}", body: "Hi,\n\nPlease find attached invoice {number} for {total}, due on {duedate}.\n{paymentlink}\nKind regards,\n{company}" },
  { name: "Herinnering (NL)", kind: "reminder", language: "nl", subject: "Herinnering: factuur {nummer}", body: "Hallo,\n\nFactuur {nummer} van {totaal} stond op {vervaldatum} open en heb ik nog niet ontvangen. Wil je hem alsnog betalen?\n{betaallink}\nGroet,\n{bedrijf}" },
  { name: "Reminder (EN)", kind: "reminder", language: "en", subject: "Reminder: invoice {number}", body: "Hi,\n\nInvoice {number} for {total} was due on {duedate} and I haven't received payment yet. Could you take a look?\n{paymentlink}\nKind regards,\n{company}" },
  { name: "Creditnota (NL)", kind: "credit", language: "nl", subject: "Creditnota {nummer} van {bedrijf}", body: "Hallo,\n\nIn de bijlage vind je creditnota {nummer} van {totaal}.\n\nGroet,\n{bedrijf}" },
  { name: "Credit note (EN)", kind: "credit", language: "en", subject: "Credit note {number} from {company}", body: "Hi,\n\nPlease find attached credit note {number} for {total}.\n\nKind regards,\n{company}" },
] as const;
