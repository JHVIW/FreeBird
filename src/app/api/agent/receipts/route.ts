import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { accounts, contacts, files, receipts } from "@/db/schema";
import { agentDenied } from "@/lib/agent-auth";
import { sha256 } from "@/lib/crypto";
import { storeFile } from "@/lib/storage";
import { autoBookReceipt, cleanParsedReceipt, parseReceipt, type ParsedReceipt } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({
  /** Wat er op de factuur staat. Zonder parsed leest DeepSeek hem uit. */
  parsed: z.record(z.string(), z.unknown()).optional(),
  /** Meteen boeken met deze keuzes. Zonder book blijft de bon in Inkoop staan om zelf te boeken. */
  book: z.object({
    date: date.optional(),
    supplierContactId: z.number().int().optional(),
    supplierName: z.string().min(1).optional(),
    invoiceNumber: z.string().optional(),
    accountCode: z.string(),
    vatCode: z.enum(["I21", "I9", "RC_EU", "RC_NONEU", "RC_NL", "NONE"]),
    totalCents: z.number().int().positive().optional(),
    vatCents: z.number().int().nonnegative().optional(),
    description: z.string().optional(),
  }).optional(),
});

/** Bonnen, nieuwste eerst. ?status=parsed|booked|error|ignored|new */
export async function GET(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const status = new URL(req.url).searchParams.get("status");
  const rows = await db.select({ r: receipts, filename: files.filename, sha256: files.sha256 }).from(receipts)
    .leftJoin(files, eq(files.id, receipts.fileId))
    .where(status ? eq(receipts.status, status as typeof receipts.$inferSelect.status) : undefined)
    .orderBy(desc(receipts.id)).limit(500);
  return Response.json(rows.map(({ r, filename, sha256 }) => ({
    id: r.id, status: r.status, source: r.source, filename, sha256, date: r.date, invoiceNumber: r.invoiceNumber, totalCents: r.totalCents,
    paidCents: r.paidCents, supplierContactId: r.supplierContactId, autoNote: r.autoNote, error: r.error, journalEntryId: r.journalEntryId,
  })));
}

/**
 * Upload van één factuur (multipart: file + data als JSON).
 * Hetzelfde bestand twee keer uploaden geeft de bestaande bon terug.
 */
export async function POST(req: Request) {
  const denied = agentDenied(req);
  if (denied) return denied;
  const fd = await req.formData();
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return Response.json({ error: "Geen bestand (veld 'file')" }, { status: 400 });
  if (!ALLOWED.includes(file.type)) return Response.json({ error: `${file.name}: alleen PDF of afbeelding (${file.type})` }, { status: 400 });
  const raw = fd.get("data");
  const body = Body.safeParse(raw ? JSON.parse(String(raw)) : {});
  if (!body.success) return Response.json({ error: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const { parsed, book } = body.data;

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = sha256(buf);
  const [dup] = await db.select({ r: receipts }).from(receipts).innerJoin(files, eq(files.id, receipts.fileId)).where(eq(files.sha256, hash)).limit(1);
  if (dup) return Response.json({ duplicate: true, receipt: dup.r });

  if (book) {
    const [acc] = await db.select().from(accounts).where(eq(accounts.code, book.accountCode));
    if (!acc) return Response.json({ error: `Onbekende rekening ${book.accountCode}` }, { status: 400 });
    if (book.supplierContactId) {
      const [c] = await db.select().from(contacts).where(eq(contacts.id, book.supplierContactId));
      if (!c) return Response.json({ error: `Onbekende leverancier ${book.supplierContactId}` }, { status: 400 });
    }
  }

  const stored = await storeFile(buf, file.name, file.type);
  const [r] = await db.insert(receipts).values({ source: "upload", fileId: stored.id, status: "new", subject: file.name }).returning();

  let receipt: typeof receipts.$inferSelect;
  if (parsed) {
    const accCodes = new Set((await db.select({ code: accounts.code }).from(accounts)).map((a) => a.code));
    const p: ParsedReceipt = cleanParsedReceipt(parsed as ParsedReceipt, accCodes);
    [receipt] = await db.update(receipts).set({
      status: "parsed", parsed: p, date: p.date ?? null, invoiceNumber: p.invoiceNumber ?? null, totalCents: p.totalCents ?? null,
      supplierContactId: book?.supplierContactId ?? null,
    }).where(eq(receipts.id, r.id)).returning();
  } else {
    receipt = await parseReceipt(r.id);
  }

  if (book && receipt.status === "parsed") {
    try {
      const override = Object.fromEntries(Object.entries({
        ...book,
        // bestaande leverancier gaat voor een nieuwe naam
        supplierName: book.supplierContactId ? null : book.supplierName,
        supplierContactId: book.supplierContactId ?? (book.supplierName ? null : undefined),
      }).filter(([, v]) => v !== undefined));
      const booked = await autoBookReceipt(r.id, { override, reason: "via agent-API" });
      receipt = booked ?? (await db.select().from(receipts).where(eq(receipts.id, r.id)))[0];
    } catch (e) {
      [receipt] = await db.update(receipts).set({ autoNote: `Niet geboekt: ${(e as Error).message}` }).where(eq(receipts.id, r.id)).returning();
      return Response.json({ error: (e as Error).message, receipt }, { status: 422 });
    }
  }
  return Response.json({ receipt });
}
