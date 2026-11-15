import { handleCallback, ipInCidr, BUNQ_CALLBACK_CIDRS } from "@/lib/bunq/sync";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (process.env.BUNQ_CALLBACK_IP_CHECK !== "false") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "";
    if (!BUNQ_CALLBACK_CIDRS.some((c) => ipInCidr(ip, c))) {
      console.warn(`bunq-callback geweigerd van ${ip}`);
      return new Response("forbidden", { status: 403 });
    }
  }
  try {
    const body = await req.json();
    const r = await handleCallback(body);
    return Response.json(r);
  } catch (e) {
    console.error("bunq-callback mislukt:", e);
    // 200 teruggeven voorkomt eindeloze retries; de nachtelijke sync haalt gemiste betalingen op
    return Response.json({ error: (e as Error).message });
  }
}
