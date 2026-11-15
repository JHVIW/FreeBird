import { agentDenied } from "@/lib/agent-auth";
import { storeFile } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

/** Slaat een bestand op (multipart veld 'file') en geeft het id, bijv. voor attachEvidence. */
export async function POST(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const f = (await req.formData()).get("file");
  if (!(f instanceof File) || !f.size) return Response.json({ error: "Geen bestand (veld 'file')" }, { status: 400 });
  if (!ALLOWED.includes(f.type)) return Response.json({ error: `Type ${f.type} niet toegestaan` }, { status: 400 });
  const row = await storeFile(Buffer.from(await f.arrayBuffer()), f.name, f.type);
  return Response.json({ id: row.id, filename: row.filename, sha256: row.sha256 });
}
