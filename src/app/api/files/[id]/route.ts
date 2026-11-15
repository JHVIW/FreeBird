import { readStoredFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Niet gevonden", { status: 404 });
  const f = await readStoredFile(id);
  if (!f) return new Response("Niet gevonden", { status: 404 });
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(f.buf), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${f.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
