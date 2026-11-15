import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { getSetting } from "./settings";
import { isEU } from "./eu";

/**
 * Moneybird API v2. Moneybird staat 150 verzoeken per 5 minuten toe (50 voor /reports/).
 * We blijven daar ruim onder en wachten bij een 429 tot de limiet weer vrij is.
 */

export class MoneybirdError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

const WINDOW_MS = 5 * 60_000;
const LIMITS = { api: 140, reports: 45 };
const sent: Record<keyof typeof LIMITS, number[]> = { api: [], reports: [] };
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Alleen voor tests: wachten overslaan. */
export function setMoneybirdSleep(fn: (ms: number) => Promise<void>) { sleep = fn; }

async function throttle(bucket: keyof typeof LIMITS) {
  for (;;) {
    const now = Date.now();
    const list = sent[bucket];
    while (list.length && now - list[0] > WINDOW_MS) list.shift();
    if (list.length < LIMITS[bucket]) { list.push(now); return; }
    await sleep(WINDOW_MS - (now - list[0]) + 500);
  }
}

export async function mbConfig() {
  const g = await getSetting("general");
  if (!g.moneybirdToken || !g.moneybirdAdministrationId) throw new MoneybirdError("Vul eerst Moneybird-token en administratie-id in (Instellingen › Algemeen)");
  return { token: g.moneybirdToken, base: `https://moneybird.com/api/v2/${g.moneybirdAdministrationId}` };
}

/** Eén verzoek, met wachten op de rate limit en een paar nieuwe pogingen bij 429 of 5xx. */
async function mbRequest(path: string, opts: { redirect?: "manual" } = {}): Promise<Response> {
  const { token, base } = await mbConfig();
  const bucket = path.startsWith("reports/") ? "reports" : "api";
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle(bucket);
    const res = await fetch(`${base}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: opts.redirect ?? "follow",
      signal: AbortSignal.timeout(60_000),
    }).catch((e: Error) => { throw new MoneybirdError(`Moneybird niet bereikbaar: ${e.message}`); });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("ratelimit-reset"));
      const wait = retry > 0 ? retry * 1000 : reset > 0 ? reset * 1000 - Date.now() : 60_000;
      await sleep(Math.max(1000, Math.min(wait, WINDOW_MS)));
      continue;
    }
    if (res.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    if (res.status === 401) throw new MoneybirdError("Moneybird-token ongeldig of verlopen", 401);
    if (res.status === 403) throw new MoneybirdError(`Geen toegang tot ${path.split("?")[0]}: geef het token meer rechten (scopes) in Moneybird`, 403);
    return res;
  }
  throw new MoneybirdError(`Moneybird bleef weigeren voor ${path.split("?")[0]}`);
}

export async function mbGet<T>(path: string): Promise<T> {
  const res = await mbRequest(path);
  if (!res.ok) throw new MoneybirdError(`Moneybird ${res.status} bij ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`, res.status);
  return (await res.json()) as T;
}

/** Haalt alle pagina's op (100 per pagina). */
export async function mbGetAll<T>(path: string, onPage?: (n: number) => void): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page < 1000; page++) {
    const list = await mbGet<T[]>(`${path}${sep}per_page=100&page=${page}`);
    out.push(...list);
    onPage?.(out.length);
    if (list.length < 100) break;
  }
  return out;
}

/** Downloadt een bestand. Moneybird stuurt een 302 naar een tijdelijke URL; die halen we op zonder token. */
export async function mbDownload(path: string): Promise<{ buf: Buffer; mime: string }> {
  const res = await mbRequest(path, { redirect: "manual" });
  let file = res;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new MoneybirdError(`Geen downloadlink bij ${path}`);
    file = await fetch(loc, { signal: AbortSignal.timeout(120_000) });
  }
  if (!file.ok) throw new MoneybirdError(`Download mislukt (${file.status})`, file.status);
  return { buf: Buffer.from(await file.arrayBuffer()), mime: (file.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
}

/** Bedrag uit Moneybird ("123.45") naar centen. */
export function mbCents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type MbContact = {
  id: string; company_name: string | null; firstname: string | null; lastname: string | null; address1: string | null; zipcode: string | null;
  city: string | null; country: string | null; email: string | null; send_invoices_to_email: string | null; tax_number: string | null;
  chamber_of_commerce: string | null; sepa_iban?: string | null;
};

export function mbContactName(m: Pick<MbContact, "company_name" | "firstname" | "lastname">): string {
  return m.company_name || [m.firstname, m.lastname].filter(Boolean).join(" ") || "Onbekend";
}

/** Zet een Moneybird-contact om naar FreeBird en slaat het op (bijwerken als het er al is). Geeft het FreeBird-id. */
export async function upsertMoneybirdContact(m: MbContact): Promise<{ id: number; created: boolean }> {
  const country = (m.country || "NL").toUpperCase().slice(0, 2);
  const values = {
    name: mbContactName(m), kind: (m.company_name ? "business" : "consumer") as "business" | "consumer", address: m.address1, postcode: m.zipcode, city: m.city, country,
    email: m.email, invoiceEmail: m.send_invoices_to_email || null, vatNumber: m.tax_number || null, kvk: m.chamber_of_commerce || null,
    ibans: m.sepa_iban ? [m.sepa_iban.replace(/\s/g, "").toUpperCase()] : [], externalRef: `moneybird:${m.id}`,
    defaultVatCode: m.tax_number && isEU(country) && country !== "NL" ? "ICP_S" : null,
  };
  const [ex] = await db.select().from(contacts).where(eq(contacts.externalRef, `moneybird:${m.id}`));
  if (ex) {
    // IBAN's die FreeBird zelf heeft geleerd niet weggooien
    await db.update(contacts).set({ ...values, ibans: [...new Set([...ex.ibans, ...values.ibans])] }).where(eq(contacts.id, ex.id));
    return { id: ex.id, created: false };
  }
  const [c] = await db.insert(contacts).values(values).returning({ id: contacts.id });
  return { id: c.id, created: true };
}

/** Importeert contacten uit Moneybird. Bestaande (zelfde externe id) worden bijgewerkt. */
export async function importMoneybirdContacts() {
  const list = await mbGetAll<MbContact>("contacts.json?include_archived=true");
  let imported = 0, updated = 0;
  for (const m of list) {
    const r = await upsertMoneybirdContact(m);
    if (r.created) imported++; else updated++;
  }
  return { imported, updated };
}
