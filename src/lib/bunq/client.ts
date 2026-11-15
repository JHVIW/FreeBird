import { generateKeyPairSync, createSign, createVerify, randomUUID } from "node:crypto";
import { getSetting, setSetting, resetSetting, type BunqState } from "../settings";

/**
 * Minimale bunq API-client voor eigen gebruik met een API key.
 * Flow: installation → device-server → session-server. Requests worden ondertekend met onze RSA-sleutel,
 * responses geverifieerd met de publieke sleutel van bunq.
 */

export class BunqError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) { super(message); }
}

function baseUrl() {
  return process.env.BUNQ_ENV === "sandbox" ? "https://public-api.sandbox.bunq.com/v1" : "https://api.bunq.com/v1";
}

type Json = Record<string, unknown>;

function sign(body: string, privateKeyPem: string): string {
  const s = createSign("RSA-SHA256");
  s.update(body);
  return s.sign(privateKeyPem, "base64");
}

function verify(body: string, signature: string | null, serverPublicKeyPem: string | undefined): boolean {
  if (!serverPublicKeyPem || !signature) return false;
  const v = createVerify("RSA-SHA256");
  v.update(body);
  return v.verify(serverPublicKeyPem, signature, "base64");
}

async function rawRequest(method: string, path: string, opts: { body?: unknown; token?: string; state: BunqState; verifyResponse?: boolean }) {
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    "Cache-Control": "no-cache",
    "User-Agent": "FreeBird/1.0",
    "X-Bunq-Client-Request-Id": randomUUID(),
    "X-Bunq-Geolocation": "0 0 0 0 000",
    "X-Bunq-Language": "nl_NL",
    "X-Bunq-Region": "nl_NL",
    "Content-Type": "application/json",
  };
  if (opts.token) headers["X-Bunq-Client-Authentication"] = opts.token;
  if (opts.state.privateKeyPem && path !== "/installation") headers["X-Bunq-Client-Signature"] = sign(body, opts.state.privateKeyPem);

  const url = path.startsWith("http") ? path : `${baseUrl()}${path}`;
  const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : body, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (opts.verifyResponse && res.ok && !verify(text, res.headers.get("x-bunq-server-signature"), opts.state.serverPublicKeyPem)) {
    throw new BunqError("Handtekening van bunq-response klopt niet");
  }
  let json: Json = {};
  try { json = JSON.parse(text); } catch { /* leeg */ }
  if (!res.ok) {
    const err = (json.Error as Array<{ error_description?: string }> | undefined)?.[0]?.error_description ?? text.slice(0, 200);
    throw new BunqError(`bunq ${method} ${path}: ${res.status} ${err}`, res.status, json);
  }
  return json;
}

/** Zoekt in een bunq "Response"-array het object met deze sleutel. */
export function pick<T = Json>(json: Json, key: string): T | undefined {
  const arr = (json.Response as Json[] | undefined) ?? [];
  for (const item of arr) if (item && key in item) return item[key] as T;
  return undefined;
}

export function pickAny<T = Json>(json: Json, keys: string[]): T | undefined {
  for (const k of keys) { const v = pick<T>(json, k); if (v) return v; }
  return undefined;
}

/** Eenmalige setup met een API key. Idempotent: slaat stappen over die al gedaan zijn. */
export async function setupBunq(apiKey: string, permittedIp?: string): Promise<BunqState> {
  let st = await getSetting("bunq");
  if (st.apiKey !== apiKey) {
    await resetSetting("bunq");
    st = {};
  }

  if (!st.privateKeyPem || !st.publicKeyPem) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    st.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    st.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  }
  if (!st.installationToken) {
    const r = await rawRequest("POST", "/installation", { body: { client_public_key: st.publicKeyPem }, state: st });
    st.installationToken = pick<{ token: string }>(r, "Token")!.token;
    st.serverPublicKeyPem = pick<{ server_public_key: string }>(r, "ServerPublicKey")!.server_public_key;
  }
  if (!st.deviceRegistered) {
    await rawRequest("POST", "/device-server", {
      body: { description: "FreeBird", secret: apiKey, permitted_ips: permittedIp ? [permittedIp] : ["*"] },
      token: st.installationToken, state: st,
    });
    st.deviceRegistered = true;
    st.permittedIp = permittedIp;
  }
  await setSetting("bunq", { ...st, apiKey });
  await createSession();
  return getSetting("bunq");
}

export async function createSession(): Promise<BunqState> {
  const st = await getSetting("bunq");
  if (!st.apiKey || !st.installationToken) throw new BunqError("bunq is nog niet gekoppeld");
  const r = await rawRequest("POST", "/session-server", { body: { secret: st.apiKey }, token: st.installationToken, state: st, verifyResponse: true });
  const token = pick<{ token: string }>(r, "Token")!.token;
  const user = pickAny<{ id: number; session_timeout?: number }>(r, ["UserCompany", "UserPerson", "UserApiKey", "UserPaymentServiceProvider"]);
  if (!user) throw new BunqError("Geen gebruiker in session-response");
  await setSetting("bunq", {
    sessionToken: token, sessionCreatedAt: new Date().toISOString(), userId: user.id,
    sessionTimeoutSec: user.session_timeout ?? 604800,
  });
  return getSetting("bunq");
}

async function ensureSession(): Promise<BunqState> {
  let st = await getSetting("bunq");
  if (!st.apiKey) throw new BunqError("bunq is nog niet gekoppeld. Voer je API key in bij Instellingen.");
  const age = st.sessionCreatedAt ? (Date.now() - Date.parse(st.sessionCreatedAt)) / 1000 : Infinity;
  if (!st.sessionToken || age > (st.sessionTimeoutSec ?? 3600) * 0.8) st = await createSession();
  return st;
}

/** Geauthenticeerd verzoek; vernieuwt de sessie één keer bij 401. */
export async function bunq(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Json> {
  let st = await ensureSession();
  try {
    return await rawRequest(method, path, { body, token: st.sessionToken, state: st, verifyResponse: true });
  } catch (e) {
    if (e instanceof BunqError && e.status === 401) {
      st = await createSession();
      return rawRequest(method, path, { body, token: st.sessionToken, state: st, verifyResponse: true });
    }
    throw e;
  }
}

export type BunqAccount = { id: number; description: string; iban: string; balanceCents: number; status: string };

export async function listAccounts(): Promise<BunqAccount[]> {
  const st = await ensureSession();
  const r = await bunq("GET", `/user/${st.userId}/monetary-account?count=50`);
  const out: BunqAccount[] = [];
  for (const item of (r.Response as Json[]) ?? []) {
    const acc = Object.values(item)[0] as Json;
    const aliases = (acc.alias as Array<{ type: string; value: string }>) ?? [];
    const iban = aliases.find((a) => a.type === "IBAN")?.value ?? "";
    const bal = acc.balance as { value: string } | undefined;
    out.push({ id: acc.id as number, description: String(acc.description ?? ""), iban, balanceCents: Math.round(Number(bal?.value ?? 0) * 100), status: String(acc.status) });
  }
  return out;
}

export type BunqPayment = {
  id: number; created: string; amount: { value: string; currency: string }; description: string; type: string; sub_type?: string;
  counterparty_alias?: { iban?: string | null; display_name?: string; label_monetary_account?: { iban?: string; display_name?: string } };
  monetary_account_id: number;
};

/** Haalt betalingen op, nieuwste eerst, pagineert met older_id. */
export async function listPayments(accountId: number, opts: { olderId?: number; newerId?: number; count?: number } = {}) {
  const st = await ensureSession();
  const q = new URLSearchParams({ count: String(opts.count ?? 200) });
  if (opts.olderId) q.set("older_id", String(opts.olderId));
  if (opts.newerId) q.set("newer_id", String(opts.newerId));
  const r = await bunq("GET", `/user/${st.userId}/monetary-account/${accountId}/payment?${q}`);
  const payments = ((r.Response as Json[]) ?? []).map((x) => x.Payment as BunqPayment).filter(Boolean);
  const pag = r.Pagination as { older_url?: string | null; newer_url?: string | null } | undefined;
  return { payments, hasOlder: !!pag?.older_url };
}

export async function getPayment(accountId: number, paymentId: number): Promise<BunqPayment> {
  const st = await ensureSession();
  const r = await bunq("GET", `/user/${st.userId}/monetary-account/${accountId}/payment/${paymentId}`);
  const p = pick<BunqPayment>(r, "Payment");
  if (!p) throw new BunqError("Betaling niet gevonden");
  return p;
}

export async function registerCallback(url: string) {
  const st = await ensureSession();
  await bunq("POST", `/user/${st.userId}/notification-filter-url`, {
    notification_filters: [{ category: "MUTATION", notification_target: url }],
  });
  await setSetting("bunq", { callbackRegisteredUrl: url });
}

/** Maakt een bunq.me-betaalverzoek en geeft de deel-URL terug. */
export async function createBunqmeTab(accountId: number, amountCents: number, description: string, redirectUrl?: string) {
  const st = await ensureSession();
  const r = await bunq("POST", `/user/${st.userId}/monetary-account/${accountId}/bunqme-tab`, {
    bunqme_tab_entry: {
      amount_inquired: { value: (amountCents / 100).toFixed(2), currency: "EUR" },
      description,
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    },
  });
  const id = pick<{ id: number }>(r, "Id")!.id;
  const tab = await bunq("GET", `/user/${st.userId}/monetary-account/${accountId}/bunqme-tab/${id}`);
  const t = pick<{ bunqme_tab_share_url: string }>(tab, "BunqMeTab");
  return { id, url: t?.bunqme_tab_share_url ?? null };
}
