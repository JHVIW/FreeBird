"use server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { run, fstr, fnum, fbool } from "@/lib/action";
import { checkVies } from "@/lib/vies";
import { isEU, normalizeIban } from "@/lib/eu";
import { importMoneybirdContacts } from "@/lib/moneybird";

async function vies(id: number) {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!c?.vatNumber) return null;
  const r = await checkVies(c.vatNumber, c.country);
  if (r.error) return r.error;
  await db.update(contacts).set({ viesValid: r.valid, viesCheckedAt: r.checkedAt, viesName: r.name ?? null }).where(eq(contacts.id, id));
  return r.valid ? null : "BTW-nummer is volgens VIES niet geldig";
}

export async function saveContact(fd: FormData) {
  const id = fnum(fd, "rowId");
  await run(id ? `/klanten?id=${id}&edit=1` : "/klanten?new=1", async () => {
    const name = fstr(fd, "name");
    if (!name) throw new Error("Naam is verplicht");
    const country = (fstr(fd, "country") || "NL").toUpperCase().slice(0, 2);
    const vatNumber = fstr(fd, "vatNumber").replace(/[\s.]/g, "").toUpperCase() || null;
    const values = {
      name, kind: (fstr(fd, "kind") === "consumer" ? "consumer" : "business") as "business" | "consumer",
      isCustomer: fbool(fd, "isCustomer"), isSupplier: fbool(fd, "isSupplier"),
      contactPerson: fstr(fd, "contactPerson") || null, email: fstr(fd, "email") || null, invoiceEmail: fstr(fd, "invoiceEmail") || null,
      address: fstr(fd, "address") || null, postcode: fstr(fd, "postcode") || null, city: fstr(fd, "city") || null, country,
      vatNumber, kvk: fstr(fd, "kvk") || null,
      ibans: fstr(fd, "ibans").split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map(normalizeIban),
      paymentTermDays: fnum(fd, "paymentTermDays"),
      defaultAccountCode: fstr(fd, "defaultAccountCode") || null, defaultVatCode: fstr(fd, "defaultVatCode") || null,
      notes: fstr(fd, "notes") || null,
      language: ["nl", "en"].includes(fstr(fd, "language")) ? fstr(fd, "language") : null,
      layoutId: fnum(fd, "layoutId"),
    };
    let cid = id;
    if (id) {
      const [old] = await db.select().from(contacts).where(eq(contacts.id, id));
      const vatChanged = old.vatNumber !== vatNumber || old.country !== country;
      await db.update(contacts).set({ ...values, ...(vatChanged ? { viesValid: null, viesCheckedAt: null } : {}) }).where(eq(contacts.id, id));
    } else {
      const [c] = await db.insert(contacts).values(values).returning();
      cid = c.id;
    }
    let msg = "Opgeslagen";
    if (vatNumber && isEU(country)) {
      const err = await vies(cid!);
      msg = err ? `Opgeslagen. Let op: ${err}` : "Opgeslagen, BTW-nummer geldig in VIES";
    }
    return { to: `/klanten?id=${cid}`, ok: msg };
  });
}

export async function checkViesAction(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/klanten?id=${id}`, async () => {
    const err = await vies(id);
    if (err) throw new Error(err);
  }, "BTW-nummer geldig in VIES");
}

export async function archiveContact(fd: FormData) {
  const id = Number(fd.get("rowId"));
  await run(`/klanten`, async () => { await db.update(contacts).set({ archived: true }).where(eq(contacts.id, id)); }, "Gearchiveerd");
}

export async function importMoneybird() {
  await run("/klanten", async () => {
    const r = await importMoneybirdContacts();
    return { ok: `${r.imported} contacten geïmporteerd, ${r.updated} bijgewerkt` };
  });
}
