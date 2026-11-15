import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://freebird@localhost:5432/freebird";

const globalForDb = globalThis as unknown as { __freebirdSql?: ReturnType<typeof postgres> };
export const sql = globalForDb.__freebirdSql ?? postgres(url, { max: 10, onnotice: () => {} });
if (process.env.NODE_ENV !== "production") globalForDb.__freebirdSql = sql;

export const db = drizzle(sql, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Executor = DB | Tx;
export { schema };
