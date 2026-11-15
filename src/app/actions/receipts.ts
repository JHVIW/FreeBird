"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { receipts } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { ingestReceipt, parseReceipt, bookReceipt, pollReceiptsMailbox } from "@/lib/receipts";
import { bookToReceipt, markReceiptPrivate } from "@/lib/bank";
import { parseEur } from "@/lib/money";
import { draftReceiptRequest } from "@/lib/ai-review";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

export async function uploadReceipts(fd: FormData) {
  await run("/inkoop", async () => {
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) throw new Error("Kies een of meer bestanden");
    let last = 0;
    for (const f of files) {
      if (!ALLOWED.includes(f.type)) throw new Error(`${f.name}: alleen PDF of afbeelding`);
      const r = await ingestReceipt(Buffer.from(await f.arrayBuffer()), f.name, f.type, { source: "upload" });
      last = r.id;
    }
    return { to: `/inkoop?id=${last}`, ok: `${files.length} bestand(en) toegevoegd` };
  });
}

export async function bookReceiptAction(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/inkoop?id=${id}`, async () => {
    const total = parseEur(fstr(fd, "total"));
    if (total == null || total <= 0) throw new Error("Vul het totaalbedrag in");
    const vat = fstr(fd, "vat") ? parseEur(fstr(fd, "vat")) : null;
    const isAsset = fbool(fd, "isAsset");
    await bookReceipt(id, {
      date: fstr(fd, "date"), supplierContactId: fnum(fd, "supplierContactId"), supplierName: fstr(fd, "supplierName") || null,
      invoiceNumber: fstr(fd, "invoiceNumber") || null, accountCode: fstr(fd, "accountCode"), vatCode: fstr(fd, "vatCode"),
      totalCents: total, vatCents: vat, description: fstr(fd, "description") || null,
      asset: isAsset ? { months: fnum(fd, "assetMonths") ?? 36, residualCents: parseEur(fstr(fd, "assetResidual")) ?? 0 } : null,
    });
    const txId = fnum(fd, "bankTxId");
    if (txId) await bookToReceipt(txId, id);
    return { to: "/inkoop", ok: txId ? "Geboekt en gekoppeld aan de bank" : "Geboekt" };
  });
}

export async function markReceiptPrivateAction(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/inkoop?id=${id}`, async () => {
    const date = fstr(fd, "date");
    if (!date) throw new Error("Kies een betaaldatum");
    await markReceiptPrivate(id, date);
    return { ok: "Gemarkeerd als privébetaling" };
  });
}

export async function reparse(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/inkoop?id=${id}`, async () => { await parseReceipt(id); }, "Opnieuw uitgelezen");
}

export async function ignoreReceipt(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/inkoop`, async () => { await db.update(receipts).set({ status: "ignored" }).where(eq(receipts.id, id)); }, "Genegeerd");
}

export async function pollNow() {
  await run("/inkoop", async () => {
    const r = await pollReceiptsMailbox();
    return { ok: r.skipped ? "IMAP is nog niet ingesteld" : `${r.imported} bijlage(n) opgehaald` };
  });
}

export async function draftReceiptMail(fd: FormData) {
  const txId = Number(fd.get("txId"));
  const back = fstr(fd, "back") || "/inkoop?tab=ontbrekend";
  await run(back, async () => {
    await draftReceiptRequest(txId);
    return { to: `${back.split("#")[0]}&mail=${txId}#mail-${txId}` };
  });
}
