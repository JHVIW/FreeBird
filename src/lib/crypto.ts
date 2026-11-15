import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function key(): Buffer {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new Error("APP_ENCRYPTION_KEY ontbreekt");
  const b = Buffer.from(k, "base64");
  if (b.length !== 32) throw new Error("APP_ENCRYPTION_KEY moet 32 bytes (base64) zijn");
  return b;
}

/** AES-256-GCM. Formaat: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(":");
  if (v !== "v1") throw new Error("Onbekend versleutelformaat");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}
