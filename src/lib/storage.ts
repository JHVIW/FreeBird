import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, type Executor } from "@/db";
import { files } from "@/db/schema";
import { sha256 } from "./crypto";

function dataDir() {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
}

export async function storeFile(buf: Buffer, filename: string, mime: string, ex: Executor = db) {
  const id = randomUUID();
  const year = new Date().getFullYear();
  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(-80) || "bestand";
  const rel = path.join("files", String(year), `${id}-${safe}`);
  const abs = path.join(dataDir(), rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf, { flag: "wx" });
  const [row] = await ex.insert(files).values({ id, path: rel, filename, mime, size: buf.length, sha256: sha256(buf) }).returning();
  return row;
}

export async function readStoredFile(id: string) {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  if (!row) return null;
  const buf = await readFile(path.join(dataDir(), row.path));
  return { ...row, buf };
}
