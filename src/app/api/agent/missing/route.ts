import { sql } from "@/db";
import { agentDenied } from "@/lib/agent-auth";
import { missingReceipts } from "@/lib/ai-bank";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uitgaven die direct op een kostenrekening zijn geboekt zonder bon (zoals Inkoop › Ontbrekend),
 * plus een telling van de banktransacties per status. ?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function GET(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const general = await getSetting("general");
  const from = sp.get("from") ?? general.openingDate ?? `${new Date().getFullYear()}-01-01`;
  const to = sp.get("to") ?? new Date().toISOString().slice(0, 10);
  const [missing, bank] = await Promise.all([
    missingReceipts(from, to),
    sql<{ status: string; n: string; first: string | null; last: string | null }[]>`
      select status::text, count(*) as n, min(date)::text as first, max(date)::text as last from bank_transactions group by status`,
  ]);
  return Response.json({
    from, to,
    bank: bank.map((b) => ({ status: b.status, count: Number(b.n), first: b.first, last: b.last })),
    missing: missing.map((m) => ({
      bankTxId: m.id, date: m.date, amountCents: m.amountCents, counterpartyName: m.counterparty_name, description: m.description,
      accountCode: m.account_code, accountName: m.account_name, vatCode: m.vat_code, contactName: m.contact_name,
    })),
  });
}
