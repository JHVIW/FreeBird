import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bankAccounts, bankTransactions } from "@/db/schema";
import { listAccounts, listPayments, getPayment, registerCallback, type BunqPayment } from "./client";
import { getSetting, setSetting } from "../settings";
import { runMatching } from "../bank";
import { normalizeIban } from "../eu";

function toRow(p: BunqPayment, bankAccountId: number) {
  const cp = p.counterparty_alias ?? {};
  const iban = cp.iban ?? cp.label_monetary_account?.iban ?? null;
  const name = cp.display_name ?? cp.label_monetary_account?.display_name ?? null;
  // bunq geeft "2026-09-28 14:03:11.123456" in UTC; boekdatum in NL-tijd
  const created = new Date(p.created.replace(" ", "T") + "Z");
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Amsterdam" }).format(created);
  return {
    bankAccountId, bunqPaymentId: p.id, date, amountCents: Math.round(Number(p.amount.value) * 100), currency: p.amount.currency,
    counterpartyName: name, counterpartyIban: iban ? normalizeIban(iban) : null, description: p.description ?? "", type: p.type, raw: p as unknown as object,
  };
}

/** Koppelt de bunq-rekening(en) aan bank_accounts. Bij één rekening wordt die gekozen. */
export async function syncAccounts() {
  const accs = await listAccounts();
  const active = accs.filter((a) => a.status === "ACTIVE");
  const st = await getSetting("bunq");
  for (const a of active) {
    await db.insert(bankAccounts).values({ bunqAccountId: a.id, iban: normalizeIban(a.iban), name: a.description || "bunq", balanceCents: a.balanceCents, balanceAt: new Date() })
      .onConflictDoUpdate({ target: bankAccounts.bunqAccountId, set: { iban: normalizeIban(a.iban), name: a.description || "bunq", balanceCents: a.balanceCents, balanceAt: new Date() } });
  }
  if (!st.monetaryAccountId && active.length) await setSetting("bunq", { monetaryAccountId: active[0].id });
  return active;
}

async function openingDate(): Promise<string> {
  const g = await getSetting("general");
  return g.openingDate ?? `${new Date().getFullYear()}-01-01`;
}

/**
 * Importeert betalingen vanaf de nieuwste terug tot een bekende betaling (incrementeel)
 * of tot de startdatum van de administratie (volledig).
 */
export async function importPayments(opts: { full?: boolean } = {}) {
  const accounts = await db.select().from(bankAccounts).where(eq(bankAccounts.active, true));
  const from = await openingDate();
  let inserted = 0;
  const newIds: number[] = [];
  for (const acc of accounts) {
    if (!acc.bunqAccountId) continue;
    const [latest] = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, acc.id)).orderBy(desc(bankTransactions.bunqPaymentId)).limit(1);
    let olderId: number | undefined;
    let stop = false;
    for (let page = 0; page < 200 && !stop; page++) {
      const { payments, hasOlder } = await listPayments(acc.bunqAccountId, { olderId, count: 200 });
      if (!payments.length) break;
      for (const p of payments) {
        const row = toRow(p, acc.id);
        if (row.date < from) { stop = true; break; }
        if (!opts.full && latest?.bunqPaymentId && p.id <= latest.bunqPaymentId) { stop = true; break; }
        const res = await db.insert(bankTransactions).values(row).onConflictDoNothing().returning({ id: bankTransactions.id });
        if (res.length) { inserted++; newIds.push(res[0].id); }
      }
      olderId = payments[payments.length - 1].id;
      if (!hasOlder) break;
    }
  }
  await setSetting("bunq", { lastSyncAt: new Date().toISOString() });
  const m = newIds.length ? await runMatching({ txIds: newIds }) : { applied: 0 };
  return { inserted, autoBooked: m.applied };
}

/** Verwerkt een bunq-callback: altijd de betaling opnieuw ophalen, nooit de body vertrouwen. */
export async function handleCallback(body: unknown) {
  const n = (body as { NotificationUrl?: { category?: string; object?: Record<string, { id?: number; monetary_account_id?: number }> } }).NotificationUrl;
  if (!n || n.category !== "MUTATION") return { ignored: true };
  const obj = n.object?.Payment;
  if (!obj?.id || !obj.monetary_account_id) return { ignored: true };
  const [acc] = await db.select().from(bankAccounts).where(eq(bankAccounts.bunqAccountId, obj.monetary_account_id));
  if (!acc) return { ignored: true };
  const p = await getPayment(obj.monetary_account_id, obj.id);
  const row = toRow(p, acc.id);
  if (row.date < (await openingDate())) return { ignored: true };
  const res = await db.insert(bankTransactions).values(row).onConflictDoNothing().returning({ id: bankTransactions.id });
  if (res.length) await runMatching({ txIds: [res[0].id] });
  await syncAccounts().catch(() => {});
  return { inserted: res.length };
}

export async function ensureCallback() {
  const url = `${process.env.APP_URL?.replace(/\/$/, "")}/api/bunq/callback`;
  if (!process.env.APP_URL) throw new Error("APP_URL ontbreekt");
  const st = await getSetting("bunq");
  if (st.callbackRegisteredUrl !== url) await registerCallback(url);
  return url;
}

/** Zit een IPv4-adres in een CIDR-blok? */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  const toInt = (s: string) => s.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const clean = ip.replace(/^::ffff:/, "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(clean) & mask) === (toInt(range) & mask);
}

export const BUNQ_CALLBACK_CIDRS = ["185.40.108.0/22"];
