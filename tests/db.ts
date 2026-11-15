import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "@/db";
import { seed } from "@/db/seed";
import { setSetting } from "@/lib/settings";
import { clearVatCache } from "@/lib/vat";
import { contacts } from "@/db/schema";

export async function resetDb() {
  await sql.unsafe(`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seed();
  clearVatCache();
  await setSetting("company", {
    name: "Studio Zwaluw", address: "Teststraat 1", postcode: "3511 AA", city: "Utrecht", country: "NL",
    kvk: "12345678", vatNumber: "NL001234567B01", iban: "NL59BUNQ2000000002",
  });
  await setSetting("general", { openingDate: "2026-01-01" });
}

export async function makeContact(v: Partial<typeof contacts.$inferInsert> & { name: string }) {
  const [c] = await db.insert(contacts).values({ address: "Straat 1", postcode: "1000", city: "Stad", ...v }).returning();
  return c;
}
