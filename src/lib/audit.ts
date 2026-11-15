import { db, type Executor } from "@/db";
import { auditLog } from "@/db/schema";

export async function audit(tableName: string, rowId: string | number, action: string, before: unknown, after: unknown, ex: Executor = db) {
  await ex.insert(auditLog).values({ tableName, rowId: String(rowId), action, before: before ?? null, after: after ?? null });
}
