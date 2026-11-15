import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./index";
import { seed } from "./seed";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seed();
  await sql.end();
  console.log("Database bijgewerkt");
}

main().catch((e) => { console.error(e); process.exit(1); });
