import { eq } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { settings } from "@/db/schema";
import { encrypt, decrypt } from "./crypto";

export type Company = {
  name: string; address: string; postcode: string; city: string; country: string;
  kvk: string; vatNumber: string; iban: string; bic: string; email: string; phone: string; website: string;
};

export type InvoiceSettings = {
  paymentTermDays: number;
  /** Dagen na vervaldatum voor herinnering 1, 2, ... */
  reminderDays: number[];
  footer: string;
  emailSubject: string;
  emailBody: string;
  reminderSubject: string;
  reminderBody: string;
  bunqmeLinks: boolean;
  attachUbl: boolean;
};

export type MailSettings = {
  smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPass?: string;
  imapHost: string; imapPort: number; imapSecure: boolean; imapUser: string; imapPass?: string;
  fromName: string; fromAddress: string;
  receiptsFolder: string; processedFolder: string; sentFolder: string;
  watchBounces: boolean;
  /** Facturen uit de bonnenmap automatisch boeken als de app zeker genoeg is. */
  autoBook: boolean;
};

export type BunqState = {
  apiKey?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
  installationToken?: string;
  serverPublicKeyPem?: string;
  deviceRegistered?: boolean;
  sessionToken?: string;
  sessionCreatedAt?: string;
  sessionTimeoutSec?: number;
  userId?: number;
  monetaryAccountId?: number;
  callbackRegisteredUrl?: string;
  lastSyncAt?: string;
  permittedIp?: string;
};

export type GeneralSettings = { openingDate?: string; deepseekApiKey?: string; moneybirdToken?: string; moneybirdAdministrationId?: string };

export type MoneybirdState = {
  /** Moneybird-grootboekrekening-id → FreeBird-code, of "new" om een eigen rekening aan te maken. */
  ledgerMap?: Record<string, string>;
  /** Moneybird-btw-tarief-id → FreeBird BTW-code. */
  taxMap?: Record<string, string>;
  importedAt?: string;
};

type Map = {
  company: Company;
  invoice: InvoiceSettings;
  mail: MailSettings;
  bunq: BunqState;
  general: GeneralSettings;
  moneybird: MoneybirdState;
};

const SECRET_FIELDS: Record<keyof Map, string[]> = {
  company: [],
  invoice: [],
  mail: ["smtpPass", "imapPass"],
  bunq: ["apiKey", "privateKeyPem", "installationToken", "sessionToken"],
  general: ["deepseekApiKey", "moneybirdToken"],
  moneybird: [],
};

export const DEFAULTS: Map = {
  company: { name: "", address: "", postcode: "", city: "", country: "NL", kvk: "", vatNumber: "", iban: "", bic: "", email: "", phone: "", website: "" },
  invoice: {
    paymentTermDays: 30,
    reminderDays: [7, 21],
    footer: "",
    emailSubject: "Factuur {nummer} van {bedrijf}",
    emailBody: "Hallo,\n\nIn de bijlage vind je factuur {nummer} van {totaal}. Graag betaald vóór {vervaldatum}.\n{betaallink}\nGroet,\n{bedrijf}",
    reminderSubject: "Herinnering: factuur {nummer}",
    reminderBody: "Hallo,\n\nFactuur {nummer} van {totaal} stond op {vervaldatum} open en heb ik nog niet ontvangen. Wil je hem alsnog betalen?\n{betaallink}\nGroet,\n{bedrijf}",
    bunqmeLinks: true,
    attachUbl: true,
  },
  mail: {
    smtpHost: "", smtpPort: 465, smtpSecure: true, smtpUser: "",
    imapHost: "", imapPort: 993, imapSecure: true, imapUser: "",
    fromName: "", fromAddress: "",
    receiptsFolder: "INBOX/Bonnen", processedFolder: "INBOX/Bonnen/Verwerkt", sentFolder: "Sent",
    watchBounces: true,
    autoBook: true,
  },
  bunq: {},
  general: {},
  moneybird: {},
};

export async function getSetting<K extends keyof Map>(key: K, ex: Executor = db): Promise<Map[K]> {
  const [row] = await ex.select().from(settings).where(eq(settings.key, key));
  const raw = (row?.value ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(DEFAULTS[key] as object), ...raw };
  for (const f of SECRET_FIELDS[key]) {
    const v = raw[f];
    out[f] = typeof v === "string" && v.startsWith("v1:") ? decrypt(v) : v;
  }
  return out as Map[K];
}

/** Merge-update. Een secret-veld met lege string of undefined laat de bestaande waarde staan; null wist hem. */
export async function setSetting<K extends keyof Map>(key: K, patch: Partial<Map[K]>, ex: Executor = db): Promise<void> {
  const [row] = await ex.select().from(settings).where(eq(settings.key, key));
  const current = (row?.value ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const [f, v] of Object.entries(patch as Record<string, unknown>)) {
    if (SECRET_FIELDS[key].includes(f)) {
      if (v === undefined || v === "") continue;
      next[f] = v === null ? null : encrypt(String(v));
    } else if (v !== undefined) {
      next[f] = v;
    }
  }
  await ex.insert(settings).values({ key, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
}

export function hasSecret(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

export async function resetSetting(key: keyof Map, ex: Executor = db): Promise<void> {
  await ex.delete(settings).where(eq(settings.key, key));
}
