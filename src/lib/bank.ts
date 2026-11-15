import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { bankTransactions, bankAccounts, invoices, contacts, receipts, rules, reconciliations, journalEntries } from "@/db/schema";
import { postEntry, reverseEntry, LedgerError, type PostLine } from "./ledger";
import { getVatCodes, vatPostingLines, purchaseAmounts, determineSaleVat, ossStatus, ossAppliesTo, euRate } from "./vat";
import { applyPayment } from "./invoices";
import { splitGross } from "./money";
import { suggest, type Suggestion, type RuleLike, BELASTINGDIENST_IBAN } from "./matching";
import { ibanCountry, normalizeIban } from "./eu";
import { audit } from "./audit";

type BankTx = typeof bankTransactions.$inferSelect;

async function loadTx(ex: Executor, id: number): Promise<BankTx & { ledgerCode: string }> {
  const [row] = await ex.select({ t: bankTransactions, code: bankAccounts.ledgerAccountCode }).from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId)).where(eq(bankTransactions.id, id)).for("update", { of: bankTransactions });
  if (!row) throw new LedgerError("Transactie niet gevonden");
  return { ...row.t, ledgerCode: row.code };
}

async function reconciledSum(ex: Executor, txId: number): Promise<number> {
  const [r] = await ex.select({ s: dsql<string>`coalesce(sum(${reconciliations.amountCents}),0)` }).from(reconciliations)
    .where(eq(reconciliations.bankTransactionId, txId));
  return Number(r.s);
}

async function finishIfComplete(ex: Executor, tx: BankTx) {
  const done = await reconciledSum(ex, tx.id);
  if (done === tx.amountCents) await ex.update(bankTransactions).set({ status: "booked", suggestions: null }).where(eq(bankTransactions.id, tx.id));
}

function remaining(tx: BankTx, done: number) { return tx.amountCents - done; }

async function rememberIban(ex: Executor, contactId: number, iban: string | null) {
  if (!iban) return;
  const n = normalizeIban(iban);
  const [c] = await ex.select().from(contacts).where(eq(contacts.id, contactId));
  if (c && !c.ibans.includes(n)) await ex.update(contacts).set({ ibans: [...c.ibans, n] }).where(eq(contacts.id, contactId));
}

/** Ontvangst op factuur: bank aan debiteuren. */
export async function bookToInvoice(txId: number, invoiceId: number, amountCents?: number) {
  return db.transaction(async (ex) => {
    const tx = await loadTx(ex, txId);
    const open = remaining(tx, await reconciledSum(ex, txId));
    const [inv] = await ex.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!inv || inv.status === "draft") throw new LedgerError("Factuur niet gevonden of nog concept");
    const amt = amountCents ?? Math.min(open, inv.totalCents - inv.paidCents);
    if (amt === 0) throw new LedgerError("Niets te koppelen");
    if (Math.abs(amt) > Math.abs(open)) throw new LedgerError("Bedrag is groter dan het nog te koppelen deel van de transactie");
    const entryId = await postEntry(ex, {
      date: tx.date, description: `Ontvangst ${inv.number} ${tx.counterpartyName ?? ""}`.trim(), sourceType: "bank", sourceId: tx.id,
      lines: [
        { accountCode: tx.ledgerCode, amountCents: amt, contactId: inv.contactId },
        { accountCode: "1100", amountCents: -amt, contactId: inv.contactId, memo: inv.number },
      ],
    });
    await ex.insert(reconciliations).values({ bankTransactionId: tx.id, targetType: "invoice", targetId: inv.id, amountCents: amt, journalEntryId: entryId });
    await applyPayment(ex, inv.id, amt, { bankTransactionId: tx.id });
    await rememberIban(ex, inv.contactId, tx.counterpartyIban);
    await finishIfComplete(ex, tx);
  });
}

/** Betaling van een geboekte bon/inkoopfactuur: crediteuren aan bank. */
export async function bookToReceipt(txId: number, receiptId: number) {
  return db.transaction(async (ex) => {
    const tx = await loadTx(ex, txId);
    const open = remaining(tx, await reconciledSum(ex, txId));
    const [r] = await ex.select().from(receipts).where(eq(receipts.id, receiptId));
    if (!r || r.status !== "booked" || r.totalCents == null) throw new LedgerError("Boek de bon eerst");
    const amt = Math.min(-open, r.totalCents - r.paidCents);
    if (amt <= 0) throw new LedgerError("Niets te koppelen");
    const entryId = await postEntry(ex, {
      date: tx.date, description: `Betaling ${r.parsed && (r.parsed as { supplierName?: string }).supplierName || tx.counterpartyName || "bon"}`, sourceType: "bank", sourceId: tx.id,
      lines: [
        { accountCode: "1600", amountCents: amt, contactId: r.supplierContactId },
        { accountCode: tx.ledgerCode, amountCents: -amt, contactId: r.supplierContactId },
      ],
    });
    await ex.insert(reconciliations).values({ bankTransactionId: tx.id, targetType: "receipt", targetId: r.id, amountCents: -amt, journalEntryId: entryId });
    await ex.update(receipts).set({ paidCents: r.paidCents + amt }).where(eq(receipts.id, r.id));
    if (r.supplierContactId) await rememberIban(ex, r.supplierContactId, tx.counterpartyIban);
    await finishIfComplete(ex, tx);
  });
}

/** Bon/inkoopfactuur privé betaald (zonder bank): crediteuren aan 0910 privé-stortingen. */
export async function markReceiptPrivate(receiptId: number, date: string) {
  return db.transaction(async (ex) => {
    const [r] = await ex.select().from(receipts).where(eq(receipts.id, receiptId)).for("update");
    if (!r || r.status !== "booked" || r.totalCents == null) throw new LedgerError("Boek de bon eerst");
    const amt = r.totalCents - r.paidCents;
    if (amt <= 0) throw new LedgerError("Niets openstaand");
    const name = (r.parsed as { supplierName?: string } | null)?.supplierName ?? "bon";
    const entryId = await postEntry(ex, {
      date, description: `Privé betaald: ${name} ${r.invoiceNumber ?? ""}`.trim(), sourceType: "memorial",
      lines: [
        { accountCode: "1600", amountCents: amt, contactId: r.supplierContactId, memo: "privé betaald" },
        { accountCode: "0910", amountCents: -amt, memo: "zakelijke uitgave privé betaald" },
      ],
    });
    await ex.update(receipts).set({ paidCents: r.paidCents + amt }).where(eq(receipts.id, r.id));
    await audit("receipts", r.id, "private-payment", null, { entryId, amt, date }, ex);
  });
}

/** Directe boeking op een grootboekrekening met BTW-code (kosten, privé, overige opbrengst). */
export async function bookDirect(txId: number, p: { accountCode: string; vatCode: string; contactId?: number | null; memo?: string | null }, ex0?: Executor) {
  const run = async (ex: Executor) => {
    const tx = await loadTx(ex, txId);
    const open = remaining(tx, await reconciledSum(ex, txId));
    if (open === 0) throw new LedgerError("Transactie is al volledig geboekt");
    const codes = await getVatCodes(ex);
    const code = codes.get(p.vatCode);
    if (!code) throw new LedgerError("Onbekende BTW-code");
    // land en BTW-nummer van de relatie gaan voor het IBAN-land (bijv. PayPal in LU), anders klopt de ICP-opgaaf niet
    const [rel] = p.contactId ? await ex.select().from(contacts).where(eq(contacts.id, p.contactId)) : [];
    const country = rel?.country ?? ibanCountry(tx.counterpartyIban) ?? "NL";
    const vatNumber = rel?.vatNumber ?? null;
    const lines: PostLine[] = [{ accountCode: tx.ledgerCode, amountCents: open, contactId: p.contactId }];
    const vat = [];
    if (open < 0) {
      if (code.direction !== "purchase") throw new LedgerError("Gebruik een inkoop-BTW-code voor uitgaande betalingen");
      const { base, vat: v } = purchaseAmounts(code, -open);
      lines.push({ accountCode: p.accountCode, amountCents: base, contactId: p.contactId, memo: p.memo });
      lines.push(...vatPostingLines(code, v, p.contactId));
      if (code.kind !== "none") vat.push({ vatCode: code.code, rateBp: code.rateBp ?? 0, baseCents: base, vatCents: v, country, contactId: p.contactId ?? null, vatNumber });
    } else {
      if (code.direction === "sale") {
        const rate = code.rateBp ?? 0;
        const { base, vat: v } = code.kind === "standard" ? splitGross(open, rate) : { base: open, vat: 0 };
        lines.push({ accountCode: p.accountCode, amountCents: -base, contactId: p.contactId, memo: p.memo });
        lines.push(...vatPostingLines(code, v, p.contactId));
        vat.push({ vatCode: code.code, rateBp: rate, baseCents: base, vatCents: v, country, contactId: p.contactId ?? null, vatNumber });
      } else if (code.kind === "none") {
        // terugbetaling/privé-storting zonder BTW
        lines.push({ accountCode: p.accountCode, amountCents: -open, contactId: p.contactId, memo: p.memo });
      } else {
        // terugbetaling van een inkoop met BTW (creditnota leverancier)
        const { base, vat: v } = purchaseAmounts(code, open);
        lines.push({ accountCode: p.accountCode, amountCents: -base, contactId: p.contactId, memo: p.memo });
        lines.push(...vatPostingLines(code, -v, p.contactId));
        vat.push({ vatCode: code.code, rateBp: code.rateBp ?? 0, baseCents: -base, vatCents: -v, country, contactId: p.contactId ?? null, vatNumber });
      }
    }
    const entryId = await postEntry(ex, {
      date: tx.date, description: [tx.counterpartyName, tx.description].filter(Boolean).join(" · ").slice(0, 200) || "Banktransactie",
      sourceType: "bank", sourceId: tx.id, lines, vat,
    });
    await ex.insert(reconciliations).values({ bankTransactionId: tx.id, targetType: "entry", targetId: entryId, amountCents: open, journalEntryId: entryId });
    await finishIfComplete(ex, tx);
    return entryId;
  };
  return ex0 ? run(ex0) : db.transaction(run);
}

/** Verkoop zonder factuur (webshop, kassa): BTW op basis van klantland, OSS-drempel en IBAN-bewijs. */
export async function bookSale(txId: number, contactId: number, accountCode = "8300", ex0?: Executor) {
  const run = async (ex: Executor) => {
    const tx = await loadTx(ex, txId);
    const open = remaining(tx, await reconciledSum(ex, txId));
    if (open <= 0) throw new LedgerError("Alleen ontvangsten kunnen als verkoop worden geboekt");
    const [c] = await ex.select().from(contacts).where(eq(contacts.id, contactId));
    if (!c) throw new LedgerError("Klant niet gevonden");
    const year = Number(tx.date.slice(0, 4));
    const st = await ossStatus(year, ex);
    // eerst een voorlopige split op NL-tarief om de basis voor de drempeltoets te schatten
    const provisional = splitGross(open, 2100).base;
    const det = determineSaleVat({ kind: c.kind, country: c.country, vatNumber: c.vatNumber, viesValid: c.viesValid }, "digital", ossAppliesTo(st, provisional));
    const codes = await getVatCodes(ex);
    const code = codes.get(det.vatCode)!;
    const rate = code.kind === "oss" ? await euRate(year, c.country, ex) : code.rateBp ?? 0;
    const { base, vat } = code.kind === "standard" || code.kind === "oss" ? splitGross(open, rate) : { base: open, vat: 0 };
    const evidence = { customer: c.country, iban: ibanCountry(tx.counterpartyIban) };
    const entryId = await postEntry(ex, {
      date: tx.date, description: `Verkoop ${c.name} (${c.country})`, sourceType: "sale", sourceId: tx.id,
      lines: [
        { accountCode: tx.ledgerCode, amountCents: open, contactId: c.id },
        { accountCode, amountCents: -base, contactId: c.id, memo: tx.description.slice(0, 100) },
        ...vatPostingLines(code, vat, c.id),
      ],
      vat: [{ vatCode: code.code, rateBp: rate, baseCents: base, vatCents: vat, country: c.country, customerKind: c.kind, contactId: c.id, vatNumber: c.vatNumber, countryEvidence: evidence }],
    });
    await ex.insert(reconciliations).values({ bankTransactionId: tx.id, targetType: "entry", targetId: entryId, amountCents: open, journalEntryId: entryId });
    await rememberIban(ex, c.id, tx.counterpartyIban);
    await finishIfComplete(ex, tx);
    return entryId;
  };
  return ex0 ? run(ex0) : db.transaction(run);
}

/** Betaling aan de Belastingdienst voor een aangifte. */
export async function bookVatPayment(txId: number) {
  return db.transaction(async (ex) => {
    const tx = await loadTx(ex, txId);
    const open = remaining(tx, await reconciledSum(ex, txId));
    const entryId = await postEntry(ex, {
      date: tx.date, description: `BTW-afdracht ${tx.description}`.slice(0, 200), sourceType: "bank", sourceId: tx.id,
      lines: [{ accountCode: tx.ledgerCode, amountCents: open }, { accountCode: "1550", amountCents: -open }],
    });
    await ex.insert(reconciliations).values({ bankTransactionId: tx.id, targetType: "entry", targetId: entryId, amountCents: open, journalEntryId: entryId });
    await finishIfComplete(ex, tx);
  });
}

/** Maakt alle koppelingen van een transactie ongedaan via tegenboekingen. */
export async function unbook(txId: number) {
  return db.transaction(async (ex) => {
    const tx = await loadTx(ex, txId);
    const recs = await ex.select().from(reconciliations).where(eq(reconciliations.bankTransactionId, txId));
    for (const r of recs) {
      if (r.journalEntryId) {
        const [je] = await ex.select().from(journalEntries).where(eq(journalEntries.id, r.journalEntryId));
        await reverseEntry(ex, r.journalEntryId, je.date, `Ontkoppeld: ${je.description}`);
      }
      if (r.targetType === "invoice") {
        const [inv] = await ex.select().from(invoices).where(eq(invoices.id, r.targetId));
        const paid = inv.paidCents - r.amountCents;
        await ex.update(invoices).set({ paidCents: paid, status: paid >= inv.totalCents ? "paid" : "open" }).where(eq(invoices.id, inv.id));
      }
      if (r.targetType === "receipt") {
        const [rc] = await ex.select().from(receipts).where(eq(receipts.id, r.targetId));
        await ex.update(receipts).set({ paidCents: rc.paidCents + r.amountCents }).where(eq(receipts.id, rc.id));
      }
    }
    await ex.delete(reconciliations).where(eq(reconciliations.bankTransactionId, txId));
    await ex.update(bankTransactions).set({ status: "open" }).where(eq(bankTransactions.id, txId));
    await audit("bank_transactions", txId, "unbook", { recs }, null, ex);
  });
}

async function matchingContext(ex: Executor) {
  const invs = await ex.select({ i: invoices, name: contacts.name, ibans: contacts.ibans }).from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.contactId)).where(eq(invoices.status, "open"));
  const recs = await ex.select().from(receipts).where(eq(receipts.status, "booked"));
  const rs = await ex.select().from(rules).where(eq(rules.active, true));
  const cs = await ex.select().from(contacts).where(eq(contacts.archived, false));
  return {
    invoices: invs.filter((x) => x.i.totalCents - x.i.paidCents > 0).map((x) => ({ id: x.i.id, number: x.i.number!, openCents: x.i.totalCents - x.i.paidCents, contactId: x.i.contactId, contactName: x.name, contactIbans: x.ibans })),
    receipts: recs.filter((r) => (r.totalCents ?? 0) - r.paidCents > 0).map((r) => ({ id: r.id, date: r.date, openCents: (r.totalCents ?? 0) - r.paidCents, supplierName: (r.parsed as { supplierName?: string } | null)?.supplierName ?? null, invoiceNumber: r.invoiceNumber })),
    rules: rs.map((r) => ({ ...r, match: r.match, action: r.action }) as RuleLike),
    contacts: cs.map((c) => ({ id: c.id, name: c.name, kind: c.kind, country: c.country, ibans: c.ibans, isCustomer: c.isCustomer })),
  };
}

/** Berekent voorstellen voor open transacties en past automatische matches toe. */
export async function runMatching(opts: { txIds?: number[]; autoApply?: boolean } = {}) {
  const ctx = await matchingContext(db);
  const where = opts.txIds?.length ? and(eq(bankTransactions.status, "open"), inArray(bankTransactions.id, opts.txIds)) : eq(bankTransactions.status, "open");
  const open = await db.select().from(bankTransactions).where(where);
  let applied = 0;
  for (const tx of open) {
    const sugg = suggest(tx, ctx);
    await db.update(bankTransactions).set({ suggestions: sugg }).where(eq(bankTransactions.id, tx.id));
    const top = sugg[0];
    if (opts.autoApply !== false && top?.auto) {
      try {
        await applySuggestion(tx.id, top);
        applied++;
      } catch (e) {
        console.warn(`Automatisch koppelen mislukt voor transactie ${tx.id}: ${(e as Error).message}`);
      }
    }
  }
  return { checked: open.length, applied };
}

export async function applySuggestion(txId: number, s: Suggestion) {
  switch (s.kind) {
    case "invoice": return bookToInvoice(txId, s.targetId!, s.amountCents);
    case "receipt": return bookToReceipt(txId, s.targetId!);
    case "vat_payment": return bookVatPayment(txId);
    case "sale": return bookSale(txId, s.targetId!);
    case "rule": {
      const a = s.action!;
      await db.update(rules).set({ hits: dsql`${rules.hits} + 1` }).where(eq(rules.id, s.targetId!));
      if (a.kind === "book") return bookDirect(txId, { accountCode: a.accountCode, vatCode: a.vatCode, contactId: a.contactId });
      if (a.kind === "sale") {
        const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
        const iban = tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : null;
        const [c] = iban ? await db.select().from(contacts).where(dsql`${iban} = any(${contacts.ibans})`) : [];
        if (!c) throw new LedgerError("Geen klant bekend voor deze IBAN. Kies of maak de klant.");
        return bookSale(txId, c.id, a.accountCode);
      }
    }
  }
}

export async function bankStats() {
  const [r] = await db.select({
    open: dsql<number>`count(*) filter (where ${bankTransactions.status} = 'open')`,
    total: dsql<number>`count(*)`,
  }).from(bankTransactions);
  return { open: Number(r.open), total: Number(r.total) };
}

export { BELASTINGDIENST_IBAN };
