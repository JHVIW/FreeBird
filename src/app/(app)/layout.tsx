import { eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, receipts } from "@/db/schema";
import { Sidebar } from "@/components/sidebar";
import { getSetting } from "@/lib/settings";
import { logout } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [[b], [r], bunq, company] = await Promise.all([
    db.select({ n: dsql<number>`count(*)` }).from(bankTransactions).where(eq(bankTransactions.status, "open")),
    db.select({ n: dsql<number>`count(*)` }).from(receipts).where(inArray(receipts.status, ["new", "parsed", "error"])),
    getSetting("bunq"),
    getSetting("company"),
  ]);
  const sync = bunq.lastSyncAt ? new Date(bunq.lastSyncAt).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="shell">
      <Sidebar
        counts={{ bank: Number(b.n), inkoop: Number(r.n) }}
        logout={logout}
        footer={<><strong>{company.name || "Jouw bedrijf"}</strong>{bunq.apiKey ? <span className="ok">bunq bijgewerkt {sync ?? "nog niet"}</span> : <span>bunq niet gekoppeld</span>}</>}
      />
      <main className="main">{children}</main>
    </div>
  );
}
