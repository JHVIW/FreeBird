import { and, eq, lt, ne } from "drizzle-orm";
import { db, sql } from "@/db";
import { assets, bankTransactions, contacts, invoices, periods, receipts, reconciliations } from "@/db/schema";
import * as bank from "./bank";
import * as inv from "./invoices";
import * as delivery from "./invoice-delivery";
import * as rec from "./receipts";
import * as rep from "./reports";
import * as review from "./ai-review";
import { missingReceipts } from "./ai-bank";
import { postEntry, reverseEntry, type PostEntry } from "./ledger";
import { getSetting, setSetting } from "./settings";
import { checkVies } from "./vies";
import { importPayments, syncAccounts } from "./bunq/sync";
import { normalizeIban } from "./eu";
import { audit } from "./audit";
import { getVatCodes, vatPostingLines } from "./vat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = { doc: string; run: (...args: any[]) => Promise<unknown> };

/** Geheimen gaan nooit over de API. */
const SECRET = /pass|apikey|token|privatekey/i;
const redact = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET.test(k) && v ? "***" : v]));

/** Journaalpost van de directe boeking van een banktransactie. */
async function directEntryId(txId: number) {
  const [r] = await db.select().from(reconciliations).where(and(eq(reconciliations.bankTransactionId, txId), eq(reconciliations.targetType, "entry")));
  return r?.journalEntryId ?? null;
}

/**
 * Functies die de agent-API mag aanroepen, met dezelfde controles als de app.
 * Boekingen lopen altijd hierlangs, nooit via losse SQL.
 */
export const AGENT_FUNCTIONS: Record<string, Fn> = {
  // bank
  bookDirect: { doc: "(txId, {accountCode, vatCode, contactId?, memo?}) open banktransactie direct op een rekening boeken", run: (txId: number, p) => bank.bookDirect(txId, p) },
  rebookDirect: { doc: "(txId, {accountCode, vatCode, contactId?, memo?}) directe boeking corrigeren: tegenboeking + nieuwe boeking; bewijs en gekoppelde bonnen blijven", run: async (txId: number, p) => {
    const old = await directEntryId(txId);
    await bank.unbook(txId);
    await bank.bookDirect(txId, p);
    const now = await directEntryId(txId);
    if (old && now) await db.update(receipts).set({ journalEntryId: now }).where(eq(receipts.journalEntryId, old));
    return { reversedEntryId: old, entryId: now };
  } },
  bookToInvoice: { doc: "(txId, invoiceId, amountCents?) betaling aan verkoopfactuur koppelen", run: bank.bookToInvoice },
  bookToReceipt: { doc: "(txId, receiptId) betaling aan inkoopbon koppelen", run: bank.bookToReceipt },
  bookSale: { doc: "(txId, contactId, accountCode='8300') ontvangst als verkoop zonder factuur", run: (txId: number, contactId: number, accountCode?: string) => bank.bookSale(txId, contactId, accountCode) },
  bookVatPayment: { doc: "(txId) BTW-betaling of -teruggaaf", run: bank.bookVatPayment },
  unbook: { doc: "(txId) boeking ongedaan maken (tegenboeking), transactie weer open", run: bank.unbook },
  runMatching: { doc: "({txIds?, autoApply?}) matching opnieuw draaien", run: bank.runMatching },
  bankStats: { doc: "()", run: bank.bankStats },
  attachEvidence: { doc: "(txId, fileId) bestand (POST /api/agent/files) als bewijs bij een banktransactie", run: async (txId: number, fileId: string) => {
    const [t] = await db.update(bankTransactions).set({ evidenceFileId: fileId }).where(eq(bankTransactions.id, txId)).returning();
    if (!t) throw new Error(`Banktransactie ${txId} niet gevonden`);
    await audit("bank_transactions", txId, "agent:evidence", null, { fileId });
    return { ok: true };
  } },
  excludeBeforeOpening: { doc: "({dryRun=true}) banktransacties van vóór de startdatum ontboeken en negeren: die periode komt uit de Moneybird-maandtotalen", run: async ({ dryRun = true }: { dryRun?: boolean } = {}) => {
    const start = (await getSetting("general")).openingDate;
    if (!start) throw new Error("Geen startdatum ingesteld");
    const txs = await db.select().from(bankTransactions).where(and(lt(bankTransactions.date, start), ne(bankTransactions.status, "ignored")));
    const [pl] = await sql<{ revenue: string; expense: string }[]>`
      select coalesce(sum(-l.amount_cents) filter (where a.type = 'revenue'), 0) as revenue, coalesce(sum(l.amount_cents) filter (where a.type = 'expense'), 0) as expense
      from reconciliations r join journal_lines l on l.entry_id = r.journal_entry_id join accounts a on a.id = l.account_id
      where r.bank_transaction_id = any(${txs.map((t) => t.id)})`;
    const summary = { openingDate: start, transactions: txs.length, booked: txs.filter((t) => t.status === "booked").length, netCents: txs.reduce((s, t) => s + t.amountCents, 0), revenueCents: Number(pl.revenue), expenseCents: Number(pl.expense) };
    // Kwartalen die de Moneybird-overname vergrendelde: de aangifte staat in Moneybird, niet in deze bankboekingen.
    // Die mogen even open om de dubbele boekingen op hun eigen datum terug te draaien; in FreeBird ingediende kwartalen niet.
    const locked = await db.select().from(periods).where(lt(periods.year, Number(start.slice(0, 4)) + 1));
    const mbLocks = locked.filter((p) => (p.totals as { source?: string } | null)?.source === "moneybird" && `${p.year}-${String(p.quarter * 3).padStart(2, "0")}-01` < start);
    if (dryRun) return { dryRun: true, ...summary, temporarilyUnlocks: mbLocks.map((p) => `${p.year}-Q${p.quarter}`) };
    for (const p of mbLocks) await db.delete(periods).where(eq(periods.id, p.id));
    try {
      for (const t of txs) {
        if (t.status === "booked") await bank.unbook(t.id);
        await db.update(bankTransactions).set({ status: "ignored", suggestions: null }).where(eq(bankTransactions.id, t.id));
      }
    } finally {
      for (const p of mbLocks) await db.insert(periods).values(p).onConflictDoNothing();
    }
    await audit("bank_transactions", "voor-startdatum", "agent:exclude", null, { ...summary, temporarilyUnlocked: mbLocks.map((p) => `${p.year}-Q${p.quarter}`) });
    return { dryRun: false, ...summary };
  } },
  missingReceipts: { doc: "(from, to) direct geboekte uitgaven zonder bon", run: missingReceipts },
  syncBunq: { doc: "({full?}) rekeningen en betalingen uit bunq ophalen", run: async (opts: { full?: boolean } = {}) => { await syncAccounts(); return importPayments(opts); } },

  // verkoopfacturen
  saveInvoiceDraft: { doc: "({id?, contactId, issueDate?, reference?, notes?, lines:[{description, quantity, unitPriceCents, vatCode, accountCode}]}) concept opslaan, geeft id", run: (d: inv.DraftInput) => inv.saveDraft(d) },
  finalizeInvoice: { doc: "(id, {issueDate?}) definitief maken: nummer en boeking", run: inv.finalizeInvoice },
  createCreditNote: { doc: "(invoiceId) creditnota als concept", run: inv.createCreditNote },
  deleteInvoiceDraft: { doc: "(id) concept verwijderen", run: inv.deleteDraft },
  getInvoice: { doc: "(id) factuur met regels", run: inv.getInvoice },
  saleDefaultsFor: { doc: "(contactId) standaard BTW-code en rekening voor een klant", run: inv.saleDefaultsFor },
  generateInvoiceFiles: { doc: "(id, {force?}) PDF en UBL maken", run: delivery.generateArtifacts },
  defaultInvoiceEmail: { doc: "(id, 'invoice'|'reminder') voorgestelde mail", run: delivery.defaultEmail },
  sendInvoice: { doc: "(id, {to, subject, body}, 'invoice'|'reminder') factuur naar de klant MAILEN", run: delivery.sendInvoice },

  settleCreditNote: { doc: "(invoiceId, creditNoteId) factuur en creditnota tegen elkaar wegstrepen; beide staan al op debiteuren, dus geen nieuwe boeking", run: async (invoiceId: number, creditNoteId: number) => db.transaction(async (ex) => {
    const [i] = await ex.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    const [c] = await ex.select().from(invoices).where(eq(invoices.id, creditNoteId)).for("update");
    if (!i || !c || i.status === "draft" || c.status === "draft") throw new Error("Factuur of creditnota niet gevonden of nog concept");
    if (i.contactId !== c.contactId) throw new Error("Factuur en creditnota horen bij verschillende relaties");
    const amt = Math.min(i.totalCents - i.paidCents, c.paidCents - c.totalCents);
    if (amt <= 0) throw new Error("Niets te verrekenen");
    await inv.applyPayment(ex, i.id, amt, { creditNoteId: c.id });
    await inv.applyPayment(ex, c.id, -amt, { invoiceId: i.id });
    await audit("invoices", i.id, "agent:settle-credit", null, { creditNoteId: c.id, amt }, ex);
    return { settledCents: amt };
  }) },
  settleInvoiceOther: { doc: "(invoiceId, {date, accountCode, amountCents?, memo}) openstaand bedrag van een factuur afboeken zonder bank, bijv. privé ontvangen (0920) of oninbaar; boekt rekening aan debiteuren", run: async (invoiceId: number, x: { date: string; accountCode: string; amountCents?: number; memo: string }) => db.transaction(async (ex) => {
    const [i] = await ex.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!i || i.status === "draft") throw new Error("Factuur niet gevonden of nog concept");
    const amt = x.amountCents ?? i.totalCents - i.paidCents;
    if (amt <= 0 || amt > i.totalCents - i.paidCents) throw new Error("Bedrag klopt niet met het openstaande deel");
    if (["1500", "1510", "1520", "1530", "1550"].includes(x.accountCode)) throw new Error("Geen BTW-rekening");
    const entryId = await postEntry(ex, {
      date: x.date, description: `${x.memo} (${i.number})`, sourceType: "memorial",
      lines: [{ accountCode: x.accountCode, amountCents: amt, contactId: i.contactId, memo: x.memo }, { accountCode: "1100", amountCents: -amt, contactId: i.contactId, memo: i.number }],
    });
    await inv.applyPayment(ex, i.id, amt, { journalEntryId: entryId, memo: x.memo });
    return { entryId };
  }) },

  // inkoop
  bookReceipt: { doc: "(receiptId, {date, supplierContactId?, supplierName?, invoiceNumber?, accountCode, vatCode, totalCents, vatCents?, description?, asset?}) bon boeken", run: rec.bookReceipt },
  autoBookReceipt: { doc: "(receiptId, {override?, reason?}) bon boeken of als bewijs koppelen", run: rec.autoBookReceipt },
  parseReceipt: { doc: "(receiptId) opnieuw uitlezen met DeepSeek", run: rec.parseReceipt },

  bookPrivatePurchase: { doc: "({fileId?, date, supplierName, supplierCountry?, invoiceNumber?, description, accountCode, totalCents (zakelijk deel incl. BTW), vatCode:'NONE'|'I21'|'I9'|'RC_EU'|'RC_NONEU', vatCents?, asset?:{months, residualCents}}) zakelijke aankoop die privé is betaald: kosten of bedrijfsmiddel tegen 0910 privé-stortingen, met de bon als bewijs. Zonder BTW ook in kwartalen die de Moneybird-overname vergrendelde", run: async (x: {
    fileId?: string; date: string; supplierName: string; supplierCountry?: string; invoiceNumber?: string; description: string;
    accountCode: string; totalCents: number; vatCode: "NONE" | "I21" | "I9" | "RC_EU" | "RC_NONEU"; vatCents?: number; asset?: { months: number; residualCents?: number };
  }) => {
    if (!Number.isInteger(x.totalCents) || x.totalCents <= 0) throw new Error("totalCents moet een positief bedrag in centen zijn");
    if (x.asset && x.asset.months < 60) throw new Error("Afschrijven gaat met maximaal 20% per jaar: minimaal 60 maanden");
    const code = (await getVatCodes(db)).get(x.vatCode);
    if (!code || code.direction !== "purchase" || !["standard", "none", "rc_eu", "rc_nonEu"].includes(code.kind)) throw new Error("Gebruik NONE, I21, I9, RC_EU of RC_NONEU");
    const rate = code.rateBp ?? 0;
    const rc = code.kind.startsWith("rc_");
    // verlegd: het bedrag is de grondslag, de BTW wordt verschuldigd én afgetrokken
    const vat = code.kind === "standard" ? x.vatCents ?? Math.round((x.totalCents * rate) / (10000 + rate)) : rc ? x.vatCents ?? Math.round((x.totalCents * rate) / 10000) : 0;
    const base = rc ? x.totalCents : x.totalCents - vat;
    // zonder BTW verandert een door Moneybird vergrendeld kwartaal niet: daar mag het
    const y = Number(x.date.slice(0, 4)), q = Math.ceil(Number(x.date.slice(5, 7)) / 3);
    const [lock] = await db.select().from(periods).where(and(eq(periods.year, y), eq(periods.quarter, q)));
    const mbLocked = lock?.status === "filed" && (lock.totals as { source?: string } | null)?.source === "moneybird";
    if (mbLocked && vat) throw new Error(`Q${q} ${y} is via Moneybird aangegeven: boek zonder BTW (NONE, totaal incl. BTW als kosten)`);
    return db.transaction(async (ex) => {
      const name = x.supplierName.trim();
      let [sup] = await ex.select().from(contacts).where(eq(contacts.name, name));
      if (!sup) [sup] = await ex.insert(contacts).values({ name, isCustomer: false, isSupplier: true, country: (x.supplierCountry ?? "NL").toUpperCase().slice(0, 2) }).returning();
      const entryId = await postEntry(ex, {
        date: x.date, description: `Privé betaald: ${name} ${x.invoiceNumber ?? ""}`.trim(), sourceType: "memorial", allowLockedPeriod: mbLocked,
        lines: [
          { accountCode: x.asset ? "0200" : x.accountCode, amountCents: base, contactId: sup.id, memo: x.description },
          ...vatPostingLines(code, vat, sup.id),
          { accountCode: "0910", amountCents: -x.totalCents, memo: "zakelijke uitgave privé betaald" },
        ],
        vat: vat ? [{ vatCode: code.code, rateBp: code.rateBp ?? 0, baseCents: base, vatCents: vat, country: sup.country, contactId: sup.id, vatNumber: sup.vatNumber }] : [],
      });
      const [r] = await ex.insert(receipts).values({
        source: "upload", fileId: x.fileId ?? null, status: "booked", journalEntryId: entryId, date: x.date, invoiceNumber: x.invoiceNumber ?? null,
        totalCents: x.totalCents, paidCents: x.totalCents, supplierContactId: sup.id, subject: x.description,
        parsed: { supplierName: name, date: x.date, totalCents: x.totalCents, description: x.description }, autoNote: "Privé betaald, geboekt via agent-API",
      }).returning();
      if (x.asset) await ex.insert(assets).values({ name: x.description, purchaseDate: x.date, costCents: base, residualCents: x.asset.residualCents ?? 0, months: x.asset.months, receiptId: r.id });
      await audit("receipts", r.id, "agent:private-purchase", null, x, ex);
      return { entryId, receiptId: r.id };
    });
  } },

  // journaal
  postEntry: { doc: "({date, description, sourceType:'memorial'|'opening', lines:[{accountCode, amountCents (+debet/-credit), contactId?, memo?}], vat?:[{vatCode, rateBp, baseCents, vatCents, country, contactId?, vatNumber?}]}) memoriaalboeking", run: (e: PostEntry) => postEntry(db, { ...e, sourceType: e.sourceType === "opening" ? "opening" : "memorial" }) },
  postMoneybirdCorrection: { doc: "({date, description, sourceType:'memorial'|'opening', lines}) correctie zonder BTW in een kwartaal dat de Moneybird-overname vergrendelde (bijv. beginsaldo, verkeerd gekoppelde rekening)", run: async (e: PostEntry) => {
    if (e.vat?.length) throw new Error("Alleen correcties zonder BTW: de aangifte van dit kwartaal staat in Moneybird");
    const vatAccounts = new Set(["1500", "1510", "1520", "1530", "1550"]);
    if (e.lines.some((l) => vatAccounts.has(l.accountCode))) throw new Error("Geen BTW-rekeningen in een vergrendeld kwartaal");
    const y = Number(e.date.slice(0, 4)), q = Math.ceil(Number(e.date.slice(5, 7)) / 3);
    const [p] = await db.select().from(periods).where(and(eq(periods.year, y), eq(periods.quarter, q)));
    if (p?.status === "filed" && (p.totals as { source?: string } | null)?.source !== "moneybird") throw new Error(`Q${q} ${y} is in FreeBird ingediend; boek de correctie in een open periode`);
    const id = await postEntry(db, { ...e, sourceType: e.sourceType === "opening" ? "opening" : "memorial", allowLockedPeriod: true });
    await audit("journal_entries", id, "agent:moneybird-correction", null, e);
    return id;
  } },
  reverseEntry: { doc: "(entryId, date, description?) tegenboeking", run: (id: number, date: string, d?: string) => reverseEntry(db, id, date, d) },

  // relaties
  saveContact: { doc: "({id?, name, kind?, isCustomer?, isSupplier?, email?, invoiceEmail?, address?, postcode?, city?, country?, vatNumber?, kvk?, ibans?, paymentTermDays?, defaultAccountCode?, defaultVatCode?, language?, notes?}) relatie aanmaken of wijzigen", run: async (c: Partial<typeof contacts.$inferInsert> & { id?: number }) => {
    const { id, ...v } = c;
    if (v.country) v.country = v.country.toUpperCase().slice(0, 2);
    if (v.vatNumber) v.vatNumber = v.vatNumber.replace(/[\s.]/g, "").toUpperCase();
    if (v.ibans) v.ibans = v.ibans.map(normalizeIban);
    if (id) {
      const [old] = await db.select().from(contacts).where(eq(contacts.id, id));
      if (!old) throw new Error(`Relatie ${id} niet gevonden`);
      const [n] = await db.update(contacts).set(v).where(eq(contacts.id, id)).returning();
      await audit("contacts", id, "agent:update", old, n);
      return n;
    }
    if (!v.name) throw new Error("Naam is verplicht");
    const [n] = await db.insert(contacts).values(v as typeof contacts.$inferInsert).returning();
    return n;
  } },
  checkVies: { doc: "(vatNumber, country?) BTW-nummer controleren", run: checkVies },

  // rapporten en BTW
  vatReturn: { doc: "(year, quarter) BTW-aangifte per rubriek", run: rep.vatReturn },
  icpReport: { doc: "(year, quarter)", run: rep.icpReport },
  ossReport: { doc: "(year, quarter)", run: rep.ossReport },
  periodChecklist: { doc: "(year, quarter)", run: rep.periodChecklist },
  vatFindings: { doc: "(year, quarter) vaste controles voor de aangifte", run: review.vatFindings },
  fileVatPeriod: { doc: "(year, quarter) kwartaal VERGRENDELEN na indienen", run: rep.fileVatPeriod },
  profitAndLoss: { doc: "(from, to)", run: rep.profitAndLoss },
  balanceSheet: { doc: "(on)", run: rep.balanceSheet },
  accountBalances: { doc: "(from|null, to)", run: rep.accountBalances },
  ibOverview: { doc: "(year)", run: rep.ibOverview },
  monthlyResults: { doc: "(year)", run: rep.monthlyResults },
  assetOverview: { doc: "()", run: rep.assetOverview },
  runDepreciation: { doc: "('YYYY-MM') afschrijvingen boeken t/m maand", run: rep.runDepreciation },

  // instellingen (geheimen gemaskeerd, alleen in de app te wijzigen)
  getSetting: { doc: "('company'|'invoice'|'mail'|'bunq'|'general'|'moneybird')", run: async (k: Parameters<typeof getSetting>[0]) => redact(await getSetting(k)) },
  setSetting: { doc: "(key, patch) instellingen wijzigen, behalve geheimen", run: async (k: Parameters<typeof setSetting>[0], patch: Record<string, unknown>) => {
    const bad = Object.keys(patch).filter((f) => SECRET.test(f));
    if (bad.length) throw new Error(`Geheimen wijzig je in de app: ${bad.join(", ")}`);
    await setSetting(k, patch as never);
    return redact(await getSetting(k));
  } },
};
