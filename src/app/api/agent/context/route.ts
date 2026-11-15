import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { accounts, vatCodes, contacts, bankTransactions } from "@/db/schema";
import { agentDenied } from "@/lib/agent-auth";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Alles wat nodig is om een inkoopfactuur te boeken: rekeningen, BTW-codes, leveranciers en open betalingen. */
export async function GET(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const since = new URL(req.url).searchParams.get("since") ?? new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const [accs, codes, suppliers, openPayments, general] = await Promise.all([
    db.select({ code: accounts.code, name: accounts.name, type: accounts.type, defaultVatCode: accounts.defaultVatCode })
      .from(accounts).where(and(eq(accounts.active, true), eq(accounts.system, false))).orderBy(accounts.code),
    db.select({ code: vatCodes.code, name: vatCodes.name, rateBp: vatCodes.rateBp, kind: vatCodes.kind })
      .from(vatCodes).where(and(eq(vatCodes.active, true), eq(vatCodes.direction, "purchase"))),
    db.select({ id: contacts.id, name: contacts.name, country: contacts.country, vatNumber: contacts.vatNumber, defaultAccountCode: contacts.defaultAccountCode, defaultVatCode: contacts.defaultVatCode })
      .from(contacts).where(eq(contacts.isSupplier, true)).orderBy(contacts.name),
    db.select({ id: bankTransactions.id, date: bankTransactions.date, amountCents: bankTransactions.amountCents, counterpartyName: bankTransactions.counterpartyName, description: bankTransactions.description })
      .from(bankTransactions).where(and(eq(bankTransactions.status, "open"), lt(bankTransactions.amountCents, 0), gte(bankTransactions.date, since)))
      .orderBy(desc(bankTransactions.date)).limit(1000),
    getSetting("general"),
  ]);
  return Response.json({ openingDate: general.openingDate ?? null, accounts: accs, vatCodes: codes, suppliers, openPayments });
}
