import { sql } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await sql`select 1`;
  return Response.json({ ok: true });
}
