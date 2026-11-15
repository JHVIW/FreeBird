import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

export function withParam(path: string, key: string, value: string) {
  const [beforeHash, hash] = path.split("#");
  const [p, q = ""] = beforeHash.split("?");
  const sp = new URLSearchParams(q);
  sp.delete("error"); sp.delete("ok");
  sp.set(key, value);
  return `${p}?${sp.toString()}${hash ? `#${hash}` : ""}`;
}

/**
 * Voert een server action uit en stuurt terug met ?ok= of ?error=.
 * fn mag een nieuw pad teruggeven (bijv. na aanmaken).
 */
export async function run(back: string, fn: () => Promise<string | { to?: string; ok?: string } | void>, okMsg?: string): Promise<never> {
  let target: string;
  try {
    const r = await fn();
    const to = typeof r === "string" ? r : r?.to ?? back;
    const msg = typeof r === "object" && r?.ok ? r.ok : okMsg;
    target = msg ? withParam(to, "ok", msg) : to;
  } catch (e) {
    console.error(e);
    target = withParam(back, "error", (e as Error).message || "Er ging iets mis");
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export function fstr(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}
export function fnum(fd: FormData, k: string): number | null {
  const s = fstr(fd, k);
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
export function fbool(fd: FormData, k: string): boolean {
  const v = fd.get(k);
  return v === "on" || v === "true" || v === "1";
}
