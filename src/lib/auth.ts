import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "freebird_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET ontbreekt of is korter dan 32 tekens");
  return new TextEncoder().encode(s);
}

export async function createSessionToken() {
  return new SignJWT({ sub: "owner" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(secret());
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.sub === "owner";
  } catch {
    return false;
  }
}

export const sessionCookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: MAX_AGE };
