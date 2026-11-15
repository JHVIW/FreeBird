import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { db } from "@/db";
import { receipts, contacts, accounts, assets, bankTransactions, reconciliations, journalEntries, journalLines } from "@/db/schema";
import { getSetting } from "./settings";
import { aiJson } from "./ai";
import { imapClient, imapConfigured } from "./mail";
import { storeFile, readStoredFile } from "./storage";
import { postEntry, LedgerError } from "./ledger";
import { getVatCodes, vatPostingLines } from "./vat";
import { invoiceNumbersIn } from "./matching";
import { runMatching, bookToReceipt } from "./bank";
import { isEU } from "./eu";
import { daysBetween } from "./dates";
import { invoiceEvents, invoices } from "@/db/schema";

export type ParsedReceipt = {
  supplierName?: string; supplierVatNumber?: string; supplierCountry?: string; invoiceNumber?: string; date?: string;
  currency?: string; totalCents?: number; vatLines?: { rateBp: number; baseCents: number; vatCents: number }[];
  description?: string; suggestedAccountCode?: string; reverseCharge?: boolean;
  /** false als het geen factuur of bon is (nieuwsbrief, orderbevestiging zonder bedrag). */
  isInvoice?: boolean;
  /** Hoe zeker de AI is van leverancier, bedrag en rekening (0-100). */
  confidence?: number;
};

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

const RECEIPT_FORMAT = `Antwoord met een json-object met deze velden (laat een veld weg als het niet op de bon staat):
{
  "supplierName": string,
  "supplierVatNumber": string,        // BTW-nummer leverancier, met landcode
  "supplierCountry": string,          // ISO 3166-1 alpha-2, bijv. "NL", "DE", "US"
  "invoiceNumber": string,
  "date": "YYYY-MM-DD",               // factuurdatum
  "currency": string,                 // bijv. "EUR"
  "totalCents": integer,              // totaal te betalen INCLUSIEF BTW, in centen
  "vatLines": [{ "rateBp": integer, "baseCents": integer, "vatCents": integer }],  // tarief in basispunten: 21% = 2100
  "reverseCharge": boolean,           // true als de bon "reverse charge" / "BTW verlegd" vermeldt
  "description": string,              // korte omschrijving van wat er gekocht is
  "suggestedAccountCode": string,     // beste grootboekrekening uit de lijst
  "isInvoice": boolean,               // false als dit geen factuur of bon is (nieuwsbrief, verzendbevestiging, offerte)
  "confidence": integer               // 0-100: hoe zeker je bent van leverancier, totaalbedrag, datum en rekening samen
}
Alle bedragen zijn gehele getallen in centen.`;

/** Haalt de tekstlaag uit een PDF. Leeg bij een gescande PDF zonder tekst. */
export async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/[ \t]+/g, " ").trim();
}

/** Leest een bon uit met DeepSeek: afbeeldingen via vision, PDF's via hun tekstlaag. */
export async function ocrReceipt(buf: Buffer, mime: string): Promise<ParsedReceipt> {
  const accs = await db.select().from(accounts).where(eq(accounts.type, "expense"));
  const accountList = accs.filter((a) => !a.system).map((a) => `${a.code} ${a.name}`).join("\n");
  const system = `Je leest bonnen en inkoopfacturen uit voor een Nederlandse eenmanszaak of kleine onderneming. ${RECEIPT_FORMAT}\nKies suggestedAccountCode uit:\n${accountList}`;
  let parsed: ParsedReceipt;
  if (mime === "text/plain") {
    const text = buf.toString("utf8").trim();
    if (text.length < 20) throw new Error("De mail bevat geen tekst om uit te lezen.");
    parsed = await aiJson<ParsedReceipt>({ system, user: `Tekst van de e-mail:\n\n${text.slice(0, 30_000)}`, maxTokens: 1500 });
  } else if (mime === "application/pdf") {
    const text = await pdfText(buf);
    if (text.length < 20) throw new Error("Deze PDF bevat geen tekst (gescand). Upload een foto of screenshot van de bon.");
    parsed = await aiJson<ParsedReceipt>({ system, user: `Tekst van de PDF:\n\n${text.slice(0, 30_000)}`, maxTokens: 1500 });
  } else {
    parsed = await aiJson<ParsedReceipt>({ system, user: "Lees deze bon uit.", images: [{ mime, data: buf }], maxTokens: 1500 });
  }
  return cleanParsedReceipt(parsed, new Set(accs.map((a) => a.code)));
}

/** Haalt onzin uit het AI-antwoord: verkeerde types, onbekende rekeningen, datums die geen datum zijn. */
export function cleanParsedReceipt(p: ParsedReceipt, accountCodes: Set<string>): ParsedReceipt {
  const int = (v: unknown) => (typeof v === "number" || typeof v === "string") && Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined;
  const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    supplierName: str(p.supplierName),
    supplierVatNumber: str(p.supplierVatNumber)?.replace(/\s/g, "").toUpperCase(),
    supplierCountry: str(p.supplierCountry)?.toUpperCase().slice(0, 2),
    invoiceNumber: str(p.invoiceNumber),
    date: str(p.date) && /^\d{4}-\d{2}-\d{2}$/.test(p.date!) ? p.date : undefined,
    currency: str(p.currency)?.toUpperCase(),
    totalCents: int(p.totalCents),
    vatLines: Array.isArray(p.vatLines)
      ? p.vatLines.map((l) => ({ rateBp: int(l?.rateBp) ?? 0, baseCents: int(l?.baseCents) ?? 0, vatCents: int(l?.vatCents) ?? 0 }))
      : undefined,
    reverseCharge: p.reverseCharge === true,
    description: str(p.description),
    suggestedAccountCode: p.suggestedAccountCode && accountCodes.has(String(p.suggestedAccountCode)) ? String(p.suggestedAccountCode) : undefined,
    isInvoice: p.isInvoice !== false,
    confidence: int(p.confidence) != null ? Math.max(0, Math.min(100, int(p.confidence)!)) : undefined,
  };
}

async function findSupplier(p: ParsedReceipt) {
  if (!p.supplierName && !p.supplierVatNumber) return null;
  const conds = [];
  if (p.supplierVatNumber) conds.push(eq(contacts.vatNumber, p.supplierVatNumber.replace(/\s/g, "").toUpperCase()));
  if (p.supplierName) conds.push(ilike(contacts.name, p.supplierName.split(/\s+/).slice(0, 2).join(" ") + "%"));
  const [c] = await db.select().from(contacts).where(or(...conds)).limit(1);
  return c ?? null;
}

/** Slaat een bestand op als bon en leest hem uit. */
export async function ingestReceipt(buf: Buffer, filename: string, mime: string, meta: { source: "mail" | "upload"; messageId?: string; sourceKey?: string; from?: string; subject?: string }) {
  if (meta.sourceKey) {
    const [dup] = await db.select().from(receipts).where(eq(receipts.sourceKey, meta.sourceKey));
    if (dup) return dup;
  }
  const file = await storeFile(buf, filename, mime);
  const [r] = await db.insert(receipts).values({
    source: meta.source, messageId: meta.messageId ?? null, sourceKey: meta.sourceKey ?? null, fromAddress: meta.from ?? null, subject: meta.subject ?? null, fileId: file.id, status: "new",
  }).returning();
  return parseReceipt(r.id);
}

export async function parseReceipt(id: number) {
  const [r] = await db.select().from(receipts).where(eq(receipts.id, id));
  const f = await readStoredFile(r.fileId!);
  try {
    const parsed = await ocrReceipt(f!.buf, f!.mime);
    if (parsed.isInvoice === false) {
      const [u] = await db.update(receipts).set({ status: "ignored", parsed, error: null, autoNote: "Geen factuur of bon, overgeslagen" }).where(eq(receipts.id, id)).returning();
      return u;
    }
    const supplier = await findSupplier(parsed);
    const [u] = await db.update(receipts).set({
      status: "parsed", parsed, error: null, date: parsed.date ?? null, invoiceNumber: parsed.invoiceNumber ?? null,
      totalCents: parsed.totalCents ?? null, supplierContactId: supplier?.id ?? null,
    }).where(eq(receipts.id, id)).returning();
    if (u.source === "mail" && (await getSetting("mail")).autoBook) {
      try {
        return (await autoBookReceipt(id)) ?? (await db.select().from(receipts).where(eq(receipts.id, id)))[0];
      } catch (e) {
        const [v] = await db.update(receipts).set({ autoNote: `Niet automatisch geboekt: ${(e as Error).message}` }).where(eq(receipts.id, id)).returning();
        return v;
      }
    }
    return u;
  } catch (e) {
    const [u] = await db.update(receipts).set({ status: "error", error: (e as Error).message }).where(eq(receipts.id, id)).returning();
    return u;
  }
}

export type BookReceiptInput = {
  date: string; supplierContactId?: number | null; supplierName?: string | null; invoiceNumber?: string | null;
  accountCode: string; vatCode: string; totalCents: number; vatCents?: number | null; description?: string | null;
  asset?: { months: number; residualCents: number } | null;
};

/** Boekt een bon als inkoop op crediteuren. Betaling volgt via de bank. */
export async function bookReceipt(id: number, x: BookReceiptInput) {
  return db.transaction(async (ex) => {
    const [r] = await ex.select().from(receipts).where(eq(receipts.id, id)).for("update");
    if (!r) throw new LedgerError("Bon niet gevonden");
    if (r.status === "booked") throw new LedgerError("Bon is al geboekt");
    const codes = await getVatCodes(ex);
    const code = codes.get(x.vatCode);
    if (!code || code.direction !== "purchase") throw new LedgerError("Kies een inkoop-BTW-code");
    let supplierId = x.supplierContactId ?? null;
    if (!supplierId && x.supplierName) {
      const [c] = await ex.insert(contacts).values({ name: x.supplierName, isCustomer: false, isSupplier: true, country: (r.parsed as ParsedReceipt | null)?.supplierCountry?.toUpperCase().slice(0, 2) || "NL", vatNumber: (r.parsed as ParsedReceipt | null)?.supplierVatNumber ?? null }).returning();
      supplierId = c.id;
    }
    const rate = code.rateBp ?? 0;
    let base: number, vat: number, payable: number;
    if (code.kind === "standard") {
      vat = x.vatCents ?? Math.round((x.totalCents * rate) / (10000 + rate));
      base = x.totalCents - vat; payable = x.totalCents;
    } else if (code.kind.startsWith("rc_")) {
      base = x.totalCents; vat = x.vatCents ?? Math.round((base * rate) / 10000); payable = x.totalCents;
    } else {
      base = x.totalCents; vat = 0; payable = x.totalCents;
    }
    const accountCode = x.asset ? "0200" : x.accountCode;
    const [sup] = supplierId ? await ex.select().from(contacts).where(eq(contacts.id, supplierId)) : [];
    const entryId = await postEntry(ex, {
      date: x.date, description: `Inkoop ${sup?.name ?? x.supplierName ?? ""} ${x.invoiceNumber ?? ""}`.trim(), sourceType: "receipt", sourceId: id,
      lines: [
        { accountCode, amountCents: base, contactId: supplierId, memo: x.description },
        ...vatPostingLines(code, vat, supplierId),
        { accountCode: "1600", amountCents: -payable, contactId: supplierId, memo: x.invoiceNumber },
      ],
      vat: code.kind === "none" ? [] : [{ vatCode: code.code, rateBp: rate, baseCents: base, vatCents: vat, country: sup?.country ?? "NL", contactId: supplierId, vatNumber: sup?.vatNumber ?? null }],
    });
    await ex.update(receipts).set({
      status: "booked", journalEntryId: entryId, date: x.date, totalCents: payable, invoiceNumber: x.invoiceNumber ?? null, supplierContactId: supplierId,
    }).where(eq(receipts.id, id));
    if (x.asset) {
      await ex.insert(assets).values({ name: x.description || sup?.name || "Bedrijfsmiddel", purchaseDate: x.date, costCents: base, residualCents: x.asset.residualCents, months: x.asset.months, receiptId: id });
    }
    return entryId;
  }).then(async (entryId) => { await runMatching(); return entryId; });
}

/** Haalt nieuwe mails uit de bonnenmap, slaat bijlagen op en verplaatst de mail naar Verwerkt. */
export async function pollReceiptsMailbox() {
  const m = await getSetting("mail");
  if (!imapConfigured(m)) return { skipped: true, imported: 0 };
  const client = imapClient(m);
  await client.connect();
  let imported = 0;
  try {
    try { await client.mailboxCreate(m.processedFolder); } catch { /* bestaat al */ }
    const lock = await client.getMailboxLock(m.receiptsFolder);
    const done: number[] = [];
    try {
      for await (const msg of client.fetch("1:*", { uid: true, source: true, envelope: true })) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const messageId = mail.messageId ?? `uid-${msg.uid}`;
        let i = 0;
        for (const att of mail.attachments ?? []) {
          const mime = att.contentType?.toLowerCase();
          if (!ACCEPTED.includes(mime)) continue;
          if (att.size < 2000 && mime.startsWith("image/")) continue; // logo's in handtekeningen
          await ingestReceipt(att.content, att.filename ?? `bon-${i}`, mime, {
            source: "mail", messageId, sourceKey: `${messageId}#${i}`, from: mail.from?.text, subject: mail.subject,
          });
          imported++; i++;
        }
        // geen bruikbare bijlage: veel SaaS-facturen staan in de mail zelf. Alleen als platte tekst opslaan,
        // nooit als HTML: die zou in de app worden getoond en kan scripts bevatten.
        const body = (mail.text || htmlToText(typeof mail.html === "string" ? mail.html : "")).trim();
        if (i === 0 && body.length > 40) {
          const text = `Van: ${mail.from?.text ?? ""}\nOnderwerp: ${mail.subject ?? ""}\nDatum: ${mail.date?.toISOString().slice(0, 10) ?? ""}\n\n${body}`;
          await ingestReceipt(Buffer.from(text, "utf8"), `${(mail.subject ?? "mail").slice(0, 60)}.txt`, "text/plain", {
            source: "mail", messageId, sourceKey: `${messageId}#body`, from: mail.from?.text, subject: mail.subject,
          });
          imported++;
        }
        done.push(msg.uid);
      }
      if (done.length) await client.messageMove(done, m.processedFolder, { uid: true });
    } finally {
      lock.release();
    }
    if (m.watchBounces) await scanBounces(client);
  } finally {
    await client.logout();
  }
  return { imported };
}

/** Zoekt bounce-meldingen in de inbox en zet ze op de factuur. */
async function scanBounces(client: ReturnType<typeof imapClient>) {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - 3 * 86400000);
    const uids = await client.search({ since, from: "mailer-daemon" }, { uid: true });
    if (!uids || !uids.length) return;
    for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
      if (!msg.source) continue;
      const mail = await simpleParser(msg.source);
      const text = `${mail.subject ?? ""}\n${mail.text ?? ""}`;
      for (const num of invoiceNumbersIn(text)) {
        const [inv] = await db.select().from(invoices).where(eq(invoices.number, num));
        if (!inv) continue;
        const key = mail.messageId ?? `uid-${msg.uid}`;
        const existing = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, inv.id));
        if (existing.some((e) => e.type === "bounced" && (e.meta as { key?: string })?.key === key)) continue;
        await db.insert(invoiceEvents).values({ invoiceId: inv.id, type: "bounced", meta: { key, subject: mail.subject } });
      }
    }
  } finally {
    lock.release();
  }
}

/** Simpele HTML naar tekst voor mails zonder tekstversie. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&euro;/g, "€").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

/** BTW-code voor een uitgelezen bon: verlegd bij buitenlandse leverancier zonder BTW, anders op tarief. */
export function guessVatCode(p: ParsedReceipt, supplierCountry?: string | null): string {
  const vatSum = p.vatLines?.reduce((s, v) => s + v.vatCents, 0);
  const rate = p.vatLines?.[0]?.rateBp;
  const cc = (p.supplierCountry ?? supplierCountry ?? "NL").toUpperCase();
  const noVat = vatSum === 0 || rate === 0 || !p.vatLines?.length;
  if (p.reverseCharge || (cc !== "NL" && noVat)) return isEU(cc) ? "RC_EU" : "RC_NONEU";
  if (rate === 900) return "I9";
  return noVat ? "NONE" : "I21";
}

export type ReceiptProposal = {
  supplierContactId: number | null; supplierName: string | null; accountCode: string; vatCode: string;
  date: string; totalCents: number; vatCents: number | null; invoiceNumber: string | null; description: string | null;
  /** Waarom we dit zeker genoeg vinden om zonder te vragen te boeken, of null als niet. */
  safeBecause: string | null;
};

/** Grootboekrekening waarop deze leverancier de vorige keer is geboekt. */
async function lastAccountFor(contactId: number): Promise<string | null> {
  const [row] = await db.select({ code: accounts.code }).from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.contactId, contactId), eq(accounts.type, "expense"), or(eq(journalEntries.sourceType, "receipt"), eq(journalEntries.sourceType, "bank"))))
    .orderBy(desc(journalEntries.date), desc(journalEntries.id)).limit(1);
  return row?.code ?? null;
}

/** Stelt een boeking voor op basis van leverancier, eerdere boekingen en het AI-antwoord. */
export async function proposeReceiptBooking(r: typeof receipts.$inferSelect): Promise<ReceiptProposal | null> {
  const p = (r.parsed as ParsedReceipt | null) ?? {};
  const total = r.totalCents ?? p.totalCents;
  const date = r.date ?? p.date;
  if (!total || total <= 0 || !date) return null;
  if (p.currency && p.currency !== "EUR") return null;
  const [sup] = r.supplierContactId ? await db.select().from(contacts).where(eq(contacts.id, r.supplierContactId)) : [];
  const learned = sup ? sup.defaultAccountCode ?? (await lastAccountFor(sup.id)) : null;
  const accountCode = learned ?? p.suggestedAccountCode ?? "4800";
  const vatCode = sup?.defaultVatCode?.match(/^(I21|I9|RC_EU|RC_NONEU|RC_NL|NONE)$/) ? sup.defaultVatCode : guessVatCode(p, sup?.country);
  const vatSum = p.vatLines?.reduce((s, v) => s + v.vatCents, 0);
  const safeBecause = learned ? `leverancier ${sup!.name} eerder op ${learned} geboekt`
    : (p.confidence ?? 0) >= 90 && p.suggestedAccountCode && p.supplierName ? `AI is ${p.confidence}% zeker` : null;
  return {
    supplierContactId: sup?.id ?? null, supplierName: sup ? null : p.supplierName ?? null, accountCode, vatCode, date, totalCents: total,
    vatCents: vatCode === "I21" || vatCode === "I9" ? vatSum ?? null : null, invoiceNumber: r.invoiceNumber ?? p.invoiceNumber ?? null,
    description: p.description ?? null, safeBecause,
  };
}

const firstWord = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/)[0] ?? "";

/**
 * Boekt een binnengekomen factuur zonder tussenkomst, als dat veilig kan.
 * Is de betaling al direct op de bank geboekt, dan wordt de factuur alleen als bewijs gekoppeld (anders zou de kostenpost dubbel staan).
 * Staat er een open betaling klaar, dan wordt die meteen gekoppeld.
 */
export async function autoBookReceipt(id: number, opts: { override?: Partial<ReceiptProposal>; reason?: string } = {}) {
  const [r] = await db.select().from(receipts).where(eq(receipts.id, id));
  if (!r || r.status !== "parsed") return null;
  const base = await proposeReceiptBooking(r);
  const merged = opts.override ? { ...base, ...opts.override, safeBecause: opts.reason ?? base?.safeBecause ?? null } : base;
  const prop = merged?.date && merged.totalCents && merged.accountCode && merged.vatCode ? merged as ReceiptProposal : null;
  if (!prop) { await db.update(receipts).set({ autoNote: "Niet automatisch geboekt: bedrag, datum of valuta ontbreekt" }).where(eq(receipts.id, id)); return null; }
  const supplierName = prop.supplierName ?? (prop.supplierContactId ? (await db.select().from(contacts).where(eq(contacts.id, prop.supplierContactId)))[0]?.name : null);
  const near = (d: string) => Math.abs(daysBetween(d, prop.date)) <= 10;
  const nameHit = (n: string | null) => !!firstWord(supplierName) && firstWord(n).length > 1 && (firstWord(n) === firstWord(supplierName) || (n ?? "").toLowerCase().includes(firstWord(supplierName)));

  // 1. al direct geboekte betaling zonder bewijs: alleen als bewijs koppelen
  const booked = await db.select({ t: bankTransactions, entryId: reconciliations.journalEntryId }).from(bankTransactions)
    .innerJoin(reconciliations, and(eq(reconciliations.bankTransactionId, bankTransactions.id), eq(reconciliations.targetType, "entry")))
    .where(and(eq(bankTransactions.status, "booked"), eq(bankTransactions.amountCents, -prop.totalCents), isNull(bankTransactions.evidenceFileId)));
  const dup = booked.filter(({ t }) => near(t.date)).sort((a, b) => Number(nameHit(b.t.counterpartyName)) - Number(nameHit(a.t.counterpartyName)))[0];
  if (dup && (nameHit(dup.t.counterpartyName) || booked.filter(({ t }) => near(t.date)).length === 1)) {
    await db.update(bankTransactions).set({ evidenceFileId: r.fileId }).where(eq(bankTransactions.id, dup.t.id));
    const [u] = await db.update(receipts).set({
      status: "booked", journalEntryId: dup.entryId, totalCents: prop.totalCents, paidCents: prop.totalCents, date: prop.date,
      autoNote: `Betaling van ${dup.t.date} was al geboekt; factuur als bewijs gekoppeld`,
    }).where(eq(receipts.id, id)).returning();
    return u;
  }

  if (!prop.safeBecause) {
    await db.update(receipts).set({ autoNote: "Niet automatisch geboekt: onbekende leverancier en de AI is niet zeker genoeg" }).where(eq(receipts.id, id));
    return null;
  }

  // 2. boeken, en een open betaling erbij zoeken
  await bookReceipt(id, {
    date: prop.date, supplierContactId: prop.supplierContactId, supplierName: prop.supplierName, invoiceNumber: prop.invoiceNumber,
    accountCode: prop.accountCode, vatCode: prop.vatCode, totalCents: prop.totalCents, vatCents: prop.vatCents, description: prop.description,
  });
  const open = (await db.select().from(bankTransactions).where(and(eq(bankTransactions.status, "open"), eq(bankTransactions.amountCents, -prop.totalCents))))
    .filter((t) => near(t.date));
  const pay = open.find((t) => nameHit(t.counterpartyName)) ?? (open.length === 1 ? open[0] : undefined);
  let note = `Automatisch geboekt op ${prop.accountCode} met ${prop.vatCode} (${prop.safeBecause})`;
  // bookReceipt draait de matching al, die kan de betaling zelf hebben gekoppeld
  const [after] = await db.select().from(receipts).where(eq(receipts.id, id));
  if (after.paidCents > 0) note += ", betaling gekoppeld";
  else if (pay) {
    try { await bookToReceipt(pay.id, id); note += `, betaling van ${pay.date} gekoppeld`; } catch { /* betaling volgt via matching */ }
  }
  const [u] = await db.update(receipts).set({ autoNote: note }).where(eq(receipts.id, id)).returning();
  return u;
}
