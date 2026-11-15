import { asc } from "drizzle-orm";
import { Zip, ZipPassThrough } from "fflate";
import { db } from "@/db";
import { mbItems } from "@/db/schema";
import { readStoredFile } from "@/lib/storage";
import type { MbFile } from "@/lib/moneybird-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safe = (s: string) => s.replace(/[^\w.\- ]+/g, "_").slice(0, 80);

/** Het hele Moneybird-archief als ZIP: alle bestanden plus de ruwe gegevens als JSON. Wordt gestreamd, dus ook groot gaat goed. */
export async function GET() {
  const items = await db.select().from(mbItems).orderBy(asc(mbItems.kind), asc(mbItems.date), asc(mbItems.id));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (err) { controller.error(err); return; }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      const add = (name: string, data: Uint8Array) => {
        const f = new ZipPassThrough(name);
        zip.add(f);
        f.push(data, true);
      };
      const byKind = new Map<string, unknown[]>();
      for (const it of items) byKind.set(it.kind, [...(byKind.get(it.kind) ?? []), it.raw]);
      for (const [kind, raws] of byKind) add(`gegevens/${kind}.json`, new TextEncoder().encode(JSON.stringify(raws, null, 1)));
      for (const it of items) {
        for (const f of it.files as MbFile[]) {
          if (!f.fileId) continue;
          const file = await readStoredFile(f.fileId).catch(() => null);
          if (!file) continue;
          const year = it.date?.slice(0, 4) ?? "zonder-datum";
          add(`bestanden/${it.kind}/${year}/${safe(`${it.date ?? ""} ${it.number ?? it.mbId}`.trim())} - ${safe(f.name)}`, new Uint8Array(file.buf));
          // niet sneller lezen dan de download gaat: anders staat het hele archief in het geheugen
          while ((controller.desiredSize ?? 1) <= 0) await new Promise((r) => setTimeout(r, 25));
        }
      }
      zip.end();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }));
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="moneybird-archief-${new Date().toISOString().slice(0, 10)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
