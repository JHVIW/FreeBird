import { timingSafeEqual } from "node:crypto";
import { sha256 } from "./crypto";

/**
 * Toegang voor Claude Code (of een ander script) met een vaste token in AGENT_API_TOKEN.
 * Zonder token staat de API uit. Geeft een Response terug als de aanvraag geweigerd wordt.
 */
export function agentDenied(req: Request): Response | null {
  const token = process.env.AGENT_API_TOKEN;
  if (!token || token.length < 32) return Response.json({ error: "Agent-API staat uit (AGENT_API_TOKEN ontbreekt of is te kort)" }, { status: 503 });
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  // hashen zodat de lengtes gelijk zijn voor timingSafeEqual
  const ok = timingSafeEqual(Buffer.from(sha256(given), "hex"), Buffer.from(sha256(token), "hex"));
  return ok ? null : Response.json({ error: "Ongeldige token" }, { status: 401 });
}
