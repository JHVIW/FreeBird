import { sql } from "@/db";
import { agentDenied } from "@/lib/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * {query, params?}: alleen lezen. Draait in een read-only transactie met een timeout van 15 seconden.
 * Wijzigen gaat altijd via /api/agent/call. De tabel settings is afgeschermd (versleutelde geheimen).
 */
export async function POST(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const { query, params = [] } = (await req.json()) as { query?: string; params?: unknown[] };
  if (!query?.trim()) return Response.json({ error: "query ontbreekt" }, { status: 400 });
  if (/\bsettings\b/i.test(query)) return Response.json({ error: "settings via getSetting in /api/agent/call" }, { status: 403 });
  try {
    const rows = await sql.begin("read only", async (tx) => {
      await tx`set local statement_timeout = 15000`;
      return tx.unsafe(query, params as never[]);
    });
    const list = Array.from(rows).slice(0, 5000);
    return new Response(JSON.stringify({ rows: list, truncated: rows.length > list.length }, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
