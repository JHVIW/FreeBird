"use server";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

const attempts = new Map<string, { n: number; until: number }>();

export async function login(fd: FormData) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) redirect("/login?error=" + encodeURIComponent("Te veel pogingen, probeer het over een paar minuten opnieuw"));
  const pw = String(fd.get("password") ?? "");
  const b64 = process.env.ADMIN_PASSWORD_HASH_B64;
  const hash = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
  const ok = !!hash && (await bcrypt.compare(pw, hash));
  if (!ok) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
    redirect("/login?error=" + encodeURIComponent(hash ? "Wachtwoord klopt niet" : "ADMIN_PASSWORD_HASH_B64 is niet ingesteld"));
  }
  attempts.delete(ip);
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions);
  const next = String(fd.get("next") ?? "/");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
