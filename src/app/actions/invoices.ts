"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recurringInvoices, invoiceTemplates } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { saveDraft, finalizeInvoice, createCreditNote, deleteDraft, type LineInput } from "@/lib/invoices";
import { generateArtifacts, sendInvoice } from "@/lib/invoice-delivery";
import { today } from "@/lib/dates";
import { draftInvoiceFromText } from "@/lib/ai-invoice";

function parseLines(fd: FormData): LineInput[] {
  const raw = JSON.parse(fstr(fd, "lines") || "[]") as LineInput[];
  return raw.filter((l) => l.description.trim() || l.unitPriceCents);
}

function draftFromForm(fd: FormData) {
  return {
    id: fnum(fd, "rowId") ?? undefined,
    contactId: Number(fd.get("contactId")),
    issueDate: fstr(fd, "issueDate") || null,
    deliveryDate: fstr(fd, "deliveryDate") || null,
    paymentTermDays: fnum(fd, "paymentTermDays"),
    reference: fstr(fd, "reference") || null,
    notes: fstr(fd, "notes") || null,
    lines: parseLines(fd),
    language: (fstr(fd, "language") === "en" ? "en" : fstr(fd, "language") === "nl" ? "nl" : null) as "nl" | "en" | null,
    layoutId: fnum(fd, "layoutId"),
  };
}

export async function saveInvoice(fd: FormData) {
  const intent = fstr(fd, "intent");
  const back = fnum(fd, "rowId") ? `/facturen/${fnum(fd, "rowId")}` : "/facturen/nieuw";
  await run(back, async () => {
    const d = draftFromForm(fd);
    if (!d.contactId) throw new Error("Kies een klant");
    if (!d.lines.length) throw new Error("Voeg minstens één regel toe");
    if (intent === "template") {
      const name = fstr(fd, "templateName");
      if (!name) throw new Error("Geef het sjabloon een naam");
      await db.insert(invoiceTemplates).values({
        name, language: d.language, reference: d.reference, notes: d.notes,
        lines: d.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, accountCode: l.accountCode })),
      });
    }
    const id = await saveDraft(d);
    if (intent === "template") return { to: `/facturen/${id}`, ok: "Sjabloon opgeslagen (de factuur staat als concept)" };
    if (intent === "finalize") {
      try {
        await finalizeInvoice(id, { issueDate: d.issueDate ?? today() });
      } catch (e) {
        return `/facturen/${id}?error=${encodeURIComponent((e as Error).message)}`;
      }
      await generateArtifacts(id).catch((e) => console.warn("PDF/UBL maken mislukt:", e));
      return { to: `/facturen/${id}?send=1`, ok: "Factuur is definitief" };
    }
    return { to: `/facturen/${id}`, ok: "Concept opgeslagen" };
  });
}

export async function sendInvoiceAction(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/facturen/${id}`, async () => {
    await sendInvoice(id, { to: fstr(fd, "to"), subject: fstr(fd, "subject"), body: String(fd.get("body") ?? "") }, fstr(fd, "kind") === "reminder" ? "reminder" : "invoice");
  }, "Verstuurd");
}

export async function creditInvoice(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/facturen/${id}`, async () => `/facturen/${await createCreditNote(id)}`, "Creditnota aangemaakt als concept");
}

export async function deleteInvoice(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/facturen/${id}`, async () => { await deleteDraft(id); return "/facturen"; }, "Concept verwijderd");
}

export async function regenerate(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/facturen/${id}`, async () => { await generateArtifacts(id, { force: true }); }, "PDF en UBL opnieuw gemaakt");
}

export async function saveRecurring(fd: FormData) {
  await run("/facturen/terugkerend", async () => {
    const lines = parseLines(fd);
    if (!lines.length) throw new Error("Voeg minstens één regel toe");
    await db.insert(recurringInvoices).values({
      contactId: Number(fd.get("contactId")), description: fstr(fd, "reference") || "Terugkerende factuur", lines,
      intervalMonths: fnum(fd, "intervalMonths") ?? 1, layoutId: fnum(fd, "layoutId"), nextDate: fstr(fd, "issueDate") || today(), autoSend: fbool(fd, "autoSend"),
    });
  }, "Schema opgeslagen");
}

export async function toggleRecurring(fd: FormData) {
  await run("/facturen/terugkerend", async () => {
    const id = Number(fd.get("rowId"));
    const [r] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id));
    await db.update(recurringInvoices).set({ active: !r.active }).where(eq(recurringInvoices.id, id));
  });
}

export async function aiDraftInvoice(fd: FormData) {
  await run("/facturen/nieuw", async () => {
    const id = await draftInvoiceFromText(fstr(fd, "text"));
    return { to: `/facturen/${id}`, ok: "Concept gemaakt door AI. Controleer de regels voor je hem definitief maakt." };
  });
}
