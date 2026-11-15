import { agentDenied } from "@/lib/agent-auth";
import { AGENT_FUNCTIONS } from "@/lib/agent-functions";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)), { status, headers: { "Content-Type": "application/json" } });

/** Lijst van aanroepbare functies met hun argumenten. */
export async function GET(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  return json(Object.fromEntries(Object.entries(AGENT_FUNCTIONS).map(([k, f]) => [k, f.doc])));
}

/** {fn, args: [...]}: alleen functies uit AGENT_FUNCTIONS. */
export async function POST(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const { fn, args = [] } = (await req.json()) as { fn?: string; args?: unknown[] };
  const f = fn && Object.hasOwn(AGENT_FUNCTIONS, fn) ? AGENT_FUNCTIONS[fn] : undefined;
  if (!f) return json({ error: `Onbekende functie ${fn}. GET /api/agent/call voor de lijst.` }, 404);
  if (!Array.isArray(args)) return json({ error: "args moet een array zijn" }, 400);
  try {
    const result = await f.run(...args);
    await audit("agent", fn!, "call", { args }, null);
    return json({ result: result ?? null });
  } catch (e) {
    return json({ error: (e as Error).message }, 422);
  }
}
