"use server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { rules, fiscalParams, accounts } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { setSetting, getSetting } from "@/lib/settings";
import { setupBunq } from "@/lib/bunq/client";
import { syncAccounts, importPayments, ensureCallback } from "@/lib/bunq/sync";
import { testSmtp, testImap } from "@/lib/mail";
import { normalizeIban } from "@/lib/eu";
import { clearVatCache } from "@/lib/vat";

const B = "/instellingen";

export async function saveCompany(fd: FormData) {
  await run(`${B}#bedrijf`, async () => {
    await setSetting("company", {
      name: fstr(fd, "name"), address: fstr(fd, "address"), postcode: fstr(fd, "postcode"), city: fstr(fd, "city"), country: fstr(fd, "country") || "NL",
      kvk: fstr(fd, "kvk"), vatNumber: fstr(fd, "vatNumber").replace(/\s/g, "").toUpperCase(), iban: normalizeIban(fstr(fd, "iban")), bic: fstr(fd, "bic"),
      email: fstr(fd, "email"), phone: fstr(fd, "phone"), website: fstr(fd, "website"),
    });
  }, "Bedrijfsgegevens opgeslagen");
}

export async function saveInvoiceSettings(fd: FormData) {
  await run(`${B}#factuur`, async () => {
    await setSetting("invoice", {
      paymentTermDays: fnum(fd, "paymentTermDays") ?? 30,
      reminderDays: fstr(fd, "reminderDays").split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0),
      footer: fstr(fd, "footer"),
      bunqmeLinks: fbool(fd, "bunqmeLinks"), attachUbl: fbool(fd, "attachUbl"),
    });
  }, "Factuurinstellingen opgeslagen");
}

export async function saveMail(fd: FormData) {
  await run(`${B}#mail`, async () => {
    await setSetting("mail", {
      smtpHost: fstr(fd, "smtpHost"), smtpPort: fnum(fd, "smtpPort") ?? 465, smtpSecure: fbool(fd, "smtpSecure"), smtpUser: fstr(fd, "smtpUser"), smtpPass: fstr(fd, "smtpPass") || undefined,
      imapHost: fstr(fd, "imapHost"), imapPort: fnum(fd, "imapPort") ?? 993, imapSecure: fbool(fd, "imapSecure"), imapUser: fstr(fd, "imapUser"), imapPass: fstr(fd, "imapPass") || undefined,
      fromName: fstr(fd, "fromName"), fromAddress: fstr(fd, "fromAddress"),
      receiptsFolder: fstr(fd, "receiptsFolder"), processedFolder: fstr(fd, "processedFolder"), sentFolder: fstr(fd, "sentFolder"), watchBounces: fbool(fd, "watchBounces"), autoBook: fbool(fd, "autoBook"),
    });
  }, "E-mailinstellingen opgeslagen");
}

export async function testMail() {
  await run(`${B}#mail`, async () => {
    await testSmtp();
    const folders = await testImap().catch((e) => { throw new Error(`SMTP werkt, IMAP niet: ${(e as Error).message}`); });
    const m = await getSetting("mail");
    const missing = [m.receiptsFolder, m.sentFolder].filter((f) => f && !folders.includes(f));
    return { ok: `SMTP en IMAP werken.${missing.length ? ` Let op: map(pen) ${missing.join(", ")} niet gevonden. Beschikbaar: ${folders.slice(0, 15).join(", ")}` : ""}` };
  });
}

export async function connectBunq(fd: FormData) {
  await run(`${B}#bunq`, async () => {
    const key = fstr(fd, "apiKey") || (await getSetting("bunq")).apiKey;
    if (!key) throw new Error("Vul je bunq API key in");
    await setupBunq(key, fstr(fd, "permittedIp") || undefined);
    const accs = await syncAccounts();
    let cb = "";
    try { cb = await ensureCallback(); } catch (e) { cb = `callback niet ingesteld: ${(e as Error).message}`; }
    return { ok: `bunq gekoppeld: ${accs.length} rekening(en). ${cb ? `Callback: ${cb}` : ""}` };
  });
}

export async function bunqFullImport() {
  await run(`${B}#bunq`, async () => {
    await syncAccounts();
    const r = await importPayments({ full: true });
    return { ok: `${r.inserted} transacties geïmporteerd, ${r.autoBooked} automatisch geboekt` };
  });
}

export async function saveGeneral(fd: FormData) {
  await run(`${B}#algemeen`, async () => {
    await setSetting("general", {
      openingDate: fstr(fd, "openingDate") || undefined, deepseekApiKey: fstr(fd, "deepseekApiKey") || undefined,
      moneybirdToken: fstr(fd, "moneybirdToken") || undefined, moneybirdAdministrationId: fstr(fd, "moneybirdAdministrationId") || undefined,
    });
  }, "Opgeslagen");
}

export async function toggleRule(fd: FormData) {
  await run(`${B}#regels`, async () => {
    const id = Number(fd.get("rowId"));
    const [r] = await db.select().from(rules).where(eq(rules.id, id));
    if (fstr(fd, "op") === "delete") await db.delete(rules).where(eq(rules.id, id));
    else if (fstr(fd, "op") === "auto") await db.update(rules).set({ autoApply: !r.autoApply }).where(eq(rules.id, id));
    else await db.update(rules).set({ active: !r.active }).where(eq(rules.id, id));
  });
}

export async function addRule(fd: FormData) {
  await run(`${B}#regels`, async () => {
    const match = { counterpartyContains: fstr(fd, "counterparty") || undefined, descriptionContains: fstr(fd, "description") || undefined, iban: fstr(fd, "iban") ? normalizeIban(fstr(fd, "iban")) : undefined, direction: (fstr(fd, "direction") || undefined) as "in" | "out" | undefined };
    if (!match.counterpartyContains && !match.descriptionContains && !match.iban) throw new Error("Geef minstens één voorwaarde op");
    const kind = fstr(fd, "kind");
    const action = kind === "sale" ? { kind: "sale", accountCode: fstr(fd, "accountCode") || "8300" } : { kind: "book", accountCode: fstr(fd, "accountCode"), vatCode: fstr(fd, "vatCode") };
    await db.insert(rules).values({ name: fstr(fd, "name") || "Regel", match, action, autoApply: fbool(fd, "autoApply") });
  }, "Regel toegevoegd");
}

export async function saveParam(fd: FormData) {
  await run(`${B}#fiscaal`, async () => {
    const year = Number(fd.get("year")), key = fstr(fd, "key");
    let value: unknown;
    try { value = JSON.parse(fstr(fd, "value")); } catch { throw new Error("Waarde moet geldige JSON zijn (getal of object)"); }
    await db.insert(fiscalParams).values({ year, key, value, note: fstr(fd, "note") || null })
      .onConflictDoUpdate({ target: [fiscalParams.year, fiscalParams.key], set: { value, note: fstr(fd, "note") || null } });
    clearVatCache();
  }, "Parameter opgeslagen");
}

export async function copyParams(fd: FormData) {
  await run(`${B}#fiscaal`, async () => {
    const from = Number(fd.get("from")), to = from + 1;
    const rows = await db.select().from(fiscalParams).where(eq(fiscalParams.year, from));
    for (const r of rows) {
      if (r.key === "other_income_cents") continue; // per jaar invullen op het jaaroverzicht
      const [ex] = await db.select().from(fiscalParams).where(and(eq(fiscalParams.year, to), eq(fiscalParams.key, r.key)));
      if (!ex) await db.insert(fiscalParams).values({ year: to, key: r.key, value: r.value, note: `Overgenomen van ${from}, controleren` });
    }
  }, "Parameters gekopieerd, controleer ze");
}

export async function addAccount(fd: FormData) {
  await run(`${B}#grootboek`, async () => {
    const code = fstr(fd, "code");
    if (!/^\d{4}$/.test(code)) throw new Error("Code moet 4 cijfers zijn");
    await db.insert(accounts).values({ code, name: fstr(fd, "name"), type: fstr(fd, "type") as "expense", ibCategory: fstr(fd, "ib") || null, defaultVatCode: fstr(fd, "vat") || null });
  }, "Rekening toegevoegd");
}
