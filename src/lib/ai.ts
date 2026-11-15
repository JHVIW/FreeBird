import { getSetting } from "./settings";

/**
 * DeepSeek via de OpenAI-compatibele Chat Completions API, altijd in JSON-modus.
 * Eén plek voor key, model, timeouts en het parsen van het antwoord.
 */

const BASE_URL = "https://api.deepseek.com";

export class AiError extends Error {}

export type AiImage = { mime: string; data: Buffer };

export async function aiKey(): Promise<string | null> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const g = await getSetting("general");
  return g.deepseekApiKey || null;
}

export async function aiConfigured(): Promise<boolean> {
  return !!(await aiKey());
}

export function aiModel(): string {
  return process.env.DEEPSEEK_MODEL || "deepseek-flash";
}

type Message = { role: "system" | "user" | "assistant"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] };

/**
 * Vraagt een JSON-object op. De prompt moet het gewenste formaat beschrijven (en het woord "json" bevatten,
 * dat eist DeepSeek in JSON-modus). Bij een leeg of onleesbaar antwoord wordt één keer opnieuw geprobeerd.
 *
 * DeepSeek denkt standaard eerst lang na (thinking mode). Voor classificeren en uitlezen is dat alleen traag,
 * dus het staat uit tenzij `think` is gezet; dan met lage inspanning.
 */
export async function aiJson<T>(opts: { system: string; user: string; images?: AiImage[]; maxTokens?: number; temperature?: number; timeoutMs?: number; think?: boolean }): Promise<T> {
  const key = await aiKey();
  if (!key) throw new AiError("Geen DeepSeek API key ingesteld (Instellingen › Algemeen)");
  const userContent: Message["content"] = opts.images?.length
    ? [...opts.images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mime};base64,${i.data.toString("base64")}` } })), { type: "text" as const, text: opts.user }]
    : opts.user;
  const body = {
    model: aiModel(),
    messages: [{ role: "system", content: opts.system }, { role: "user", content: userContent }] satisfies Message[],
    response_format: { type: "json_object" },
    max_tokens: (opts.maxTokens ?? 2000) + (opts.think ? 4000 : 0),
    temperature: opts.temperature ?? 0,
    thinking: { type: opts.think ? "enabled" : "disabled" },
    ...(opts.think ? { reasoning_effort: "low" } : {}),
  };

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    }).catch((e: Error) => { throw new AiError(`DeepSeek niet bereikbaar: ${e.message}`); });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        // de env-variabele wint stil van Instellingen; zeg welke key er werd gebruikt
        const from = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY op de server (gaat vóór Instellingen)" : "Instellingen › Algemeen";
        throw new AiError(`DeepSeek wijst de API key af (key uit ${from}, eindigt op …${key.slice(-4)}): ${text.slice(0, 200)}`);
      }
      if (res.status === 402) throw new AiError("DeepSeek-tegoed is op");
      if (res.status === 429 || res.status >= 500) { lastError = `DeepSeek ${res.status}`; await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw new AiError(`DeepSeek ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) { lastError = "leeg antwoord"; continue; }
    try {
      return parseJsonObject<T>(content);
    } catch {
      lastError = json.choices?.[0]?.finish_reason === "length" ? "antwoord afgekapt" : "geen geldige JSON";
    }
  }
  throw new AiError(`DeepSeek gaf geen bruikbaar antwoord (${lastError})`);
}

/** Leest een JSON-object, ook als het model er toch codeblok-tekens omheen zet. */
export function parseJsonObject<T>(s: string): T {
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("geen JSON-object");
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

/** Begrenst een getal tot een geheel percentage 0..100. */
export function clampPct(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}
