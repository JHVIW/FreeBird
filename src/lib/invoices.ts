import { and, asc, eq, sql as dsql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { contacts, invoices, invoiceLines, invoiceEvents, numberSequences } from "@/db/schema";
import { postEntry, LedgerError, type PostLine, type PostVat } from "./ledger";
import { getVatCodes, vatPostingLines, euRate, ossStatus, ossAppliesTo } from "./vat";
import { getSetting, type Company } from "./settings";
import { lineBase, vatOf } from "./money";
import { today, addDays } from "./dates";
import { isEU } from "./eu";
import { audit } from "./audit";
import { contactLanguage, type Lang } from "./i18n";

export type LineInput = { description: string; quantity: number; unitPriceCents: number; vatCode: string; accountCode: string };
export type DraftInput = {
  id?: number; contactId: number; issueDate?: string | null; deliveryDate?: string | null; paymentTermDays?: number | null;
  reference?: string | null; notes?: string | null; lines: LineInput[]; recurringId?: number | null; creditOf?: number | null;
  language?: Lang | null; layoutId?: number | null;
};

export type InvoiceSnapshot = {
  company: Company;
  contact: { name: string; contactPerson: string | null; address: string | null; postcode: string | null; city: string | null; country: string; vatNumber: string | null; kvk: string | null; kind: "business" | "consumer"; email: string | null };
  notes: string[];
  creditOfNumber?: string | null;
  language?: Lang;
};

async function rateFor(ex: Executor, vatCode: string, country: string, year: number): Promise<number> {
  const codes = await getVatCodes(ex);
  const c = codes.get(vatCode);
  if (!c) throw new LedgerError(`Onbekende BTW-code ${vatCode}`);
  if (c.direction !== "sale") throw new LedgerError(`${vatCode} is geen verkoopcode`);
  if (c.kind === "oss") return euRate(year, country, ex);
  return c.rateBp ?? 0;
}

export async function computeLines(ex: Executor, lines: LineInput[], country: string, year: number) {
  const out = [];
  for (const [i, l] of lines.entries()) {
    if (!l.description.trim()) throw new LedgerError(`Regel ${i + 1} heeft geen omschrijving`);
    if (!Number.isFinite(l.quantity)) throw new LedgerError(`Regel ${i + 1}: ongeldig aantal`);
    const rateBp = await rateFor(ex, l.vatCode, country, year);
    const baseCents = lineBase(l.quantity, l.unitPriceCents);
    out.push({ ...l, position: i, rateBp, baseCents, vatCents: vatOf(baseCents, rateBp) });
  }
  return out;
}

export async function saveDraft(input: DraftInput, ex: Executor = db): Promise<number> {
  return (ex === db ? db.transaction((tx) => saveDraftTx(tx, input)) : saveDraftTx(ex, input));
}

async function saveDraftTx(tx: Executor, input: DraftInput): Promise<number> {
  const [contact] = await tx.select().from(contacts).where(eq(contacts.id, input.contactId));
  if (!contact) throw new LedgerError("Klant niet gevonden");
  const year = Number((input.issueDate ?? today()).slice(0, 4));
  const lines = await computeLines(tx, input.lines, contact.country, year);
  const subtotal = lines.reduce((s, l) => s + l.baseCents, 0);
  const vat = lines.reduce((s, l) => s + l.vatCents, 0);
  const term = input.paymentTermDays ?? contact.paymentTermDays ?? (await getSetting("invoice", tx)).paymentTermDays;
  const values = {
    contactId: input.contactId, issueDate: input.issueDate || null, deliveryDate: input.deliveryDate || null,
    dueDate: input.issueDate ? addDays(input.issueDate, term) : null,
    reference: input.reference || null, notes: input.notes || null,
    subtotalCents: subtotal, vatCents: vat, totalCents: subtotal + vat,
    recurringId: input.recurringId ?? null, creditOf: input.creditOf ?? null,
    language: input.language ?? contactLanguage(contact), layoutId: input.layoutId ?? contact.layoutId ?? null,
  };
  let id = input.id;
  if (id) {
    const [cur] = await tx.select().from(invoices).where(eq(invoices.id, id));
    if (!cur) throw new LedgerError("Factuur niet gevonden");
    if (cur.status !== "draft") throw new LedgerError("Een definitieve factuur kan niet meer worden gewijzigd. Maak een creditnota.");
    await tx.update(invoices).set(values).where(eq(invoices.id, id));
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  } else {
    const [row] = await tx.insert(invoices).values({ ...values, status: "draft" }).returning({ id: invoices.id });
    id = row.id;
  }
  if (lines.length) {
    await tx.insert(invoiceLines).values(lines.map((l) => ({
      invoiceId: id!, position: l.position, description: l.description, quantity: String(l.quantity), unitPriceCents: l.unitPriceCents,
      vatCode: l.vatCode, rateBp: l.rateBp, accountCode: l.accountCode, baseCents: l.baseCents, vatCents: l.vatCents,
    })));
  }
  return id!;
}

/** Volgend nummer zonder gaten: de teller zit in dezelfde transactie als de factuur. */
export async function nextNumber(tx: Executor, year: number): Promise<string> {
  const key = `invoice-${year}`;
  const rows = await tx.execute(dsql`
    insert into ${numberSequences} (key, next) values (${key}, 2)
    on conflict (key) do update set next = ${numberSequences.next} + 1
    returning next - 1 as n`);
  const n = Number((rows as unknown as Array<{ n: number }>)[0].n);
  return `${year}-${String(n).padStart(4, "0")}`;
}

export function validateCompany(c: Company): string[] {
  const missing: string[] = [];
  if (!c.name) missing.push("bedrijfsnaam");
  if (!c.address || !c.postcode || !c.city) missing.push("adres");
  if (!c.kvk) missing.push("KvK-nummer");
  if (!c.vatNumber) missing.push("BTW-id");
  if (!c.iban) missing.push("IBAN");
  return missing;
}

export async function finalizeInvoice(id: number, opts: { issueDate?: string } = {}): Promise<{ number: string }> {
  const result = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
    if (!inv) throw new LedgerError("Factuur niet gevonden");
    if (inv.status !== "draft") throw new LedgerError("Factuur is al definitief");
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, inv.contactId));
    let lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.position));
    if (!lines.length) throw new LedgerError("Factuur heeft geen regels");

    const company = await getSetting("company", tx);
    const missing = validateCompany(company);
    if (missing.length) throw new LedgerError(`Vul eerst je bedrijfsgegevens aan: ${missing.join(", ")} (Instellingen)`);
    if (contact.kind === "business" && (!contact.address || !contact.city)) throw new LedgerError("Adres van de klant ontbreekt");

    const issueDate = opts.issueDate ?? inv.issueDate ?? today();
    const year = Number(issueDate.slice(0, 4));
    const codes = await getVatCodes(tx);

    // herbereken met de definitieve datum (tarieven per jaar)
    const recomputed = await computeLines(tx, lines.map((l) => ({
      description: l.description, quantity: Number(l.quantity), unitPriceCents: l.unitPriceCents, vatCode: l.vatCode, accountCode: l.accountCode,
    })), contact.country, year);

    const usedKinds = new Set(recomputed.map((l) => codes.get(l.vatCode)!.kind));
    if ((usedKinds.has("icp_services") || usedKinds.has("icp_goods"))) {
      if (contact.kind !== "business" || !contact.vatNumber) throw new LedgerError("Verlegging naar een EU-ondernemer vereist een BTW-nummer van de klant");
      if (contact.viesValid !== true) throw new LedgerError("Het BTW-nummer van de klant is niet (geldig) gecontroleerd in VIES. Controleer het eerst bij de klant.");
      if (!isEU(contact.country) || contact.country === "NL") throw new LedgerError("ICP-verlegging geldt alleen voor klanten in een ander EU-land");
    }
    if (usedKinds.has("oss") && (contact.country === "NL" || !isEU(contact.country))) throw new LedgerError("OSS geldt alleen voor particulieren in een ander EU-land");
    const isB2cEu = contact.kind === "consumer" && isEU(contact.country) && contact.country !== "NL";
    if (isB2cEu && !inv.creditOf) {
      const st = await ossStatus(year, tx);
      const base = recomputed.reduce((s, l) => s + l.baseCents, 0);
      const applies = ossAppliesTo(st, base);
      if (applies && recomputed.some((l) => l.vatCode === "V21" || l.vatCode === "V9")) {
        throw new LedgerError("De OSS-drempel is (met deze factuur) overschreden. Gebruik BTW-code OSS: tarief van het land van de klant.");
      }
      if (!applies && usedKinds.has("oss")) throw new LedgerError("Je zit onder de OSS-drempel; reken Nederlandse BTW (V21).");
    }

    // regels opnieuw opslaan met definitieve tarieven
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    await tx.insert(invoiceLines).values(recomputed.map((l) => ({
      invoiceId: id, position: l.position, description: l.description, quantity: String(l.quantity), unitPriceCents: l.unitPriceCents,
      vatCode: l.vatCode, rateBp: l.rateBp, accountCode: l.accountCode, baseCents: l.baseCents, vatCents: l.vatCents,
    })));
    const subtotal = recomputed.reduce((s, l) => s + l.baseCents, 0);
    const vatTotal = recomputed.reduce((s, l) => s + l.vatCents, 0);
    const total = subtotal + vatTotal;

    const number = await nextNumber(tx, year);
    const settingsInv = await getSetting("invoice", tx);
    const term = contact.paymentTermDays ?? settingsInv.paymentTermDays;
    const dueDate = addDays(issueDate, term);

    let creditOfNumber: string | null = null;
    if (inv.creditOf) {
      const [orig] = await tx.select().from(invoices).where(eq(invoices.id, inv.creditOf));
      creditOfNumber = orig?.number ?? null;
    }

    // Journaalpost
    const plines: PostLine[] = [{ accountCode: "1100", amountCents: total, contactId: contact.id, memo: number }];
    const byAccount = new Map<string, number>();
    for (const l of recomputed) byAccount.set(l.accountCode, (byAccount.get(l.accountCode) ?? 0) + l.baseCents);
    for (const [code, base] of byAccount) plines.push({ accountCode: code, amountCents: -base, contactId: contact.id });
    const byVat = new Map<string, { code: string; rate: number; base: number; vat: number }>();
    for (const l of recomputed) {
      const k = `${l.vatCode}|${l.rateBp}`;
      const g = byVat.get(k) ?? { code: l.vatCode, rate: l.rateBp, base: 0, vat: 0 };
      g.base += l.baseCents; g.vat += l.vatCents; byVat.set(k, g);
    }
    const pvat: PostVat[] = [];
    for (const g of byVat.values()) {
      const code = codes.get(g.code)!;
      plines.push(...vatPostingLines(code, g.vat, contact.id));
      pvat.push({
        vatCode: g.code, rateBp: g.rate, baseCents: g.base, vatCents: g.vat, country: contact.country, customerKind: contact.kind,
        contactId: contact.id, vatNumber: contact.vatNumber, countryEvidence: { address: contact.country },
      });
    }
    const entryId = await postEntry(tx, {
      date: issueDate, description: `${inv.creditOf ? "Creditnota" : "Factuur"} ${number} ${contact.name}`,
      sourceType: "invoice", sourceId: id, lines: plines, vat: pvat,
    });

    const lang = (inv.language === "en" ? "en" : "nl") as Lang;
    const notes = [...new Set(recomputed.map((l) => { const c = codes.get(l.vatCode)!; return lang === "en" ? c.invoiceNoteEn ?? c.invoiceNote : c.invoiceNote; }).filter(Boolean) as string[])];
    const snapshot: InvoiceSnapshot = {
      company,
      contact: {
        name: contact.name, contactPerson: contact.contactPerson, address: contact.address, postcode: contact.postcode, city: contact.city,
        country: contact.country, vatNumber: contact.vatNumber, kvk: contact.kvk, kind: contact.kind, email: contact.invoiceEmail ?? contact.email,
      },
      notes,
      creditOfNumber,
      language: lang,
    };
    await tx.update(invoices).set({
      number, status: "open", issueDate, dueDate, snapshot, subtotalCents: subtotal, vatCents: vatTotal, totalCents: total, journalEntryId: entryId,
    }).where(eq(invoices.id, id));
    await tx.insert(invoiceEvents).values({ invoiceId: id, type: "finalized", meta: { number } });
    await audit("invoices", id, "finalize", { status: "draft" }, { number, total }, tx);

    if (inv.creditOf) {
      const [orig] = await tx.select().from(invoices).where(eq(invoices.id, inv.creditOf));
      // creditnota verrekenen met origineel: beide zijn dan voldaan voor het gecrediteerde deel
      const credit = Math.min(-total, orig.totalCents - orig.paidCents);
      if (credit > 0) {
        await tx.update(invoices).set({ paidCents: orig.paidCents + credit, status: orig.paidCents + credit >= orig.totalCents ? "credited" : orig.status })
          .where(eq(invoices.id, orig.id));
        await tx.update(invoices).set({ paidCents: -credit, status: "paid" }).where(eq(invoices.id, id));
      }
      await tx.insert(invoiceEvents).values({ invoiceId: orig.id, type: "credited", meta: { creditNote: number } });
    }
    return { number };
  });
  return result;
}

/** Maakt een creditnota (concept) voor een definitieve factuur. */
export async function createCreditNote(invoiceId: number): Promise<number> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || inv.status === "draft") throw new LedgerError("Alleen definitieve facturen kun je crediteren");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.position));
  return saveDraft({
    contactId: inv.contactId, issueDate: today(), reference: inv.language === "en" ? `Credit note for ${inv.number}` : `Creditnota voor ${inv.number}`, creditOf: inv.id,
    language: inv.language as Lang, layoutId: inv.layoutId,
    lines: lines.map((l) => ({ description: l.description, quantity: -Number(l.quantity), unitPriceCents: l.unitPriceCents, vatCode: l.vatCode, accountCode: l.accountCode })),
  });
}

/** Registreert een (deel)betaling op een factuur. De journaalpost doet de bankmodule. */
export async function applyPayment(tx: Executor, invoiceId: number, amountCents: number, meta: Record<string, unknown> = {}) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv) throw new LedgerError("Factuur niet gevonden");
  if (inv.status === "draft") throw new LedgerError("Concept-facturen kunnen niet betaald worden");
  const paid = inv.paidCents + amountCents;
  const status = paid >= inv.totalCents ? "paid" : "open";
  await tx.update(invoices).set({ paidCents: paid, status }).where(eq(invoices.id, invoiceId));
  await tx.insert(invoiceEvents).values({ invoiceId, type: status === "paid" ? "paid" : "payment", meta: { amountCents, ...meta } });
}

export async function deleteDraft(id: number) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv || inv.status !== "draft") throw new LedgerError("Alleen concepten kunnen worden verwijderd");
  await db.delete(invoices).where(eq(invoices.id, id));
}

export async function getInvoice(id: number) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv) return null;
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.position));
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, inv.contactId));
  const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, id)).orderBy(asc(invoiceEvents.at));
  return { inv, lines, contact, events };
}

export function openAmount(inv: { totalCents: number; paidCents: number }) {
  return inv.totalCents - inv.paidCents;
}

export function isOverdue(inv: { status: string; dueDate: string | null }, on = today()) {
  return inv.status === "open" && !!inv.dueDate && inv.dueDate < on;
}

export async function invoiceEventsFor(id: number) {
  return db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, id)));
}

/** Standaard BTW-code en omzetrekening voor een klant (zelfde logica als de editor). */
export async function saleDefaultsFor(contactId: number): Promise<{ vatCode: string; accountCode: string }> {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) throw new LedgerError("Klant niet gevonden");
  const { ossStatus: st, ossAppliesTo: applies, determineSaleVat } = await import("./vat");
  const oss = await st(Number(today().slice(0, 4)));
  const det = determineSaleVat({ kind: c.kind, country: c.country, vatNumber: c.vatNumber, viesValid: c.viesValid }, "services", applies(oss, 0));
  const vatCode = c.defaultVatCode ?? det.vatCode;
  const accountCode = c.defaultAccountCode ?? (vatCode === "ICP_S" ? "8100" : vatCode === "NONEU_S" ? "8200" : "8000");
  return { vatCode, accountCode };
}
