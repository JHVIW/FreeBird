"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, contacts, rules } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { applySuggestion, bookToInvoice, bookToReceipt, bookDirect, bookSale, unbook, runMatching, bookVatPayment } from "@/lib/bank";
import { importPayments, syncAccounts } from "@/lib/bunq/sync";
import type { Suggestion } from "@/lib/matching";
import { normalizeIban } from "@/lib/eu";
import { parseEur } from "@/lib/money";
import { suggestForTransactions, startBulkSuggest, confidentAiTransactions, type AiSuggestion } from "@/lib/ai-bank";
import { storeFile } from "@/lib/storage";

const back = (fd: FormData) => fstr(fd, "back") || "/bank";

export async function confirmSuggestion(fd: FormData) {
  const txId = Number(fd.get("txId"));
  const idx = Number(fd.get("idx"));
  await run(back(fd), async () => {
    const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
    const s = (tx?.suggestions as Suggestion[] | null)?.[idx];
    if (!s) throw new Error("Voorstel niet meer geldig, ververs de pagina");
    await applySuggestion(txId, s);
    await runMatching();
  }, "Geboekt");
}

export async function linkInvoice(fd: FormData) {
  const txId = Number(fd.get("txId"));
  await run(back(fd), async () => {
    const amount = parseEur(fstr(fd, "amount"));
    await bookToInvoice(txId, Number(fd.get("invoiceId")), amount ?? undefined);
  }, "Gekoppeld aan factuur");
}

export async function linkReceipt(fd: FormData) {
  await run(back(fd), async () => { await bookToReceipt(Number(fd.get("txId")), Number(fd.get("receiptId"))); }, "Gekoppeld aan bon");
}

export async function bookAccount(fd: FormData) {
  const txId = Number(fd.get("txId"));
  await run(back(fd), async () => {
    const accountCode = fstr(fd, "accountCode");
    const vatCode = fstr(fd, "vatCode");
    const contactId = fnum(fd, "contactId");
    await bookDirect(txId, { accountCode, vatCode, contactId, memo: fstr(fd, "memo") || null });
    if (fbool(fd, "remember")) {
      const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
      const match = tx.counterpartyIban ? { iban: tx.counterpartyIban, direction: tx.amountCents < 0 ? "out" : "in" } : { counterpartyContains: tx.counterpartyName ?? "", direction: tx.amountCents < 0 ? "out" : "in" };
      await db.insert(rules).values({
        name: `${tx.counterpartyName ?? tx.counterpartyIban} → ${accountCode}`, match,
        action: { kind: "book", accountCode, vatCode, contactId }, autoApply: fbool(fd, "auto"),
      });
      await runMatching();
    }
  }, "Geboekt");
}

export async function bookAsSale(fd: FormData) {
  const txId = Number(fd.get("txId"));
  await run(back(fd), async () => {
    let contactId = fnum(fd, "contactId");
    const [tx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, txId));
    if (!contactId) {
      const name = fstr(fd, "newName") || tx.counterpartyName || "Particulier";
      const country = (fstr(fd, "newCountry") || "NL").toUpperCase();
      const [c] = await db.insert(contacts).values({
        name, kind: "consumer", country, ibans: tx.counterpartyIban ? [normalizeIban(tx.counterpartyIban)] : [], email: fstr(fd, "newEmail") || null,
      }).returning();
      contactId = c.id;
    }
    await bookSale(txId, contactId, fstr(fd, "accountCode") || "8300");
    if (fbool(fd, "remember")) {
      const exists = (await db.select().from(rules)).some((r) => (r.action as { kind: string }).kind === "sale");
      if (!exists) {
        await db.insert(rules).values({ name: "Ontvangst van bekende particulier → verkoop zonder factuur", match: { descriptionContains: fstr(fd, "pattern") || "ORDER", direction: "in" }, action: { kind: "sale", accountCode: fstr(fd, "accountCode") || "8300" }, autoApply: true });
      }
    }
    await runMatching();
  }, "Verkoop geboekt");
}

export async function payVat(fd: FormData) {
  await run(back(fd), async () => { await bookVatPayment(Number(fd.get("txId"))); }, "BTW-betaling geboekt");
}

export async function undoBooking(fd: FormData) {
  await run(back(fd), async () => { await unbook(Number(fd.get("txId"))); await runMatching({ autoApply: false }); }, "Ontkoppeld");
}

export async function syncNow(fd: FormData) {
  await run(back(fd), async () => {
    await syncAccounts();
    const r = await importPayments();
    return { ok: `${r.inserted} nieuwe transacties, ${r.autoBooked} automatisch geboekt` };
  });
}

export async function rematch(fd: FormData) {
  await run(back(fd), async () => {
    const r = await runMatching();
    return { ok: `${r.checked} transacties bekeken, ${r.applied} automatisch geboekt` };
  });
}

export async function aiSuggestAll(fd: FormData) {
  await run(back(fd), async () => {
    const r = await startBulkSuggest();
    if (!r.started) return { ok: r.total === 0 ? "Alle open transacties hebben al een voorstel" : "De AI is al bezig" };
    return { ok: `De AI maakt voorstellen voor ${r.total} transactie(s)` };
  });
}

async function bookWithAi(ids: number[]) {
  let booked = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const [t] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, id));
    const s = t?.aiSuggestion as AiSuggestion | null;
    if (!t || t.status !== "open" || !s) continue;
    try {
      await bookDirect(t.id, { accountCode: s.accountCode, vatCode: s.vatCode, contactId: s.contactId });
      booked++;
    } catch (e) {
      errors.push(`${t.counterpartyName ?? t.id}: ${(e as Error).message}`);
    }
  }
  return { ok: `${booked} transactie(s) geboekt${errors.length ? `. Niet gelukt: ${errors.slice(0, 3).join("; ")}` : ""}` };
}

/** Boekt de aangevinkte transacties volgens hun AI-voorstel. */
export async function bookSelectedAi(fd: FormData) {
  await run(back(fd), async () => {
    const ids = fd.getAll("ids").map(Number).filter(Number.isFinite);
    if (!ids.length) throw new Error("Vink eerst transacties aan");
    return bookWithAi(ids);
  });
}

export async function aiSuggestOne(fd: FormData) {
  await run(back(fd), async () => {
    const r = await suggestForTransactions([Number(fd.get("txId"))]);
    if (!r.suggested) throw new Error("De AI kon geen geldig voorstel maken. Boek hem handmatig.");
  }, "AI-voorstel bijgewerkt");
}

/** Boekt alle open transacties met een AI-voorstel van minstens 90% zekerheid. */
export async function bookAiConfident(fd: FormData) {
  await run(back(fd), async () => {
    if (!fbool(fd, "confirm")) throw new Error("Vink aan dat je de voorstellen hebt bekeken");
    return bookWithAi((await confidentAiTransactions(90)).map((t) => t.id));
  });
}

export async function createRuleFromProposal(fd: FormData) {
  await run(back(fd), async () => {
    const match = JSON.parse(fstr(fd, "match")) as Record<string, string>;
    await db.insert(rules).values({
      name: fstr(fd, "name"), match,
      action: { kind: "book", accountCode: fstr(fd, "accountCode"), vatCode: fstr(fd, "vatCode"), contactId: fnum(fd, "contactId") },
      autoApply: fbool(fd, "auto"),
    });
    const r = await runMatching();
    return { ok: `Regel aangemaakt${r.applied ? `, ${r.applied} transactie(s) direct geboekt` : ""}` };
  });
}

const EVIDENCE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

/** Voegt een bon of factuur toe als bewijs bij een direct geboekte transactie. */
export async function attachEvidence(fd: FormData) {
  await run(back(fd), async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || !f.size) throw new Error("Kies een bestand");
    if (!EVIDENCE_TYPES.includes(f.type)) throw new Error("Alleen PDF of afbeelding");
    const file = await storeFile(Buffer.from(await f.arrayBuffer()), f.name, f.type);
    await db.update(bankTransactions).set({ evidenceFileId: file.id }).where(eq(bankTransactions.id, Number(fd.get("txId"))));
  }, "Bewijs toegevoegd");
}
