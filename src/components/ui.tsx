import Link from "next/link";
import { formatEur } from "@/lib/money";

export function Money({ cents, sign, className }: { cents: number | null | undefined; sign?: boolean; className?: string }) {
  if (cents == null) return null;
  return <span className={`num ${className ?? ""} ${sign && cents > 0 ? "pos" : ""}`}>{formatEur(cents, { sign })}</span>;
}

export function Pill({ tone = "n", children }: { tone?: "g" | "a" | "b" | "n" | "r"; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Top({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="top">
      <div><h1>{title}</h1>{sub ? <div className="sub">{sub}</div> : null}</div>
      {children ? <div className="row wrap noprint">{children}</div> : null}
    </div>
  );
}

export function Kpi({ label, value, detail, tone }: { label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: "neg" | "pos" }) {
  return (
    <div className="card kpi">
      <div className="l">{label}</div>
      <div className={`v num ${tone ?? ""}`}>{value}</div>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const err = typeof sp.error === "string" ? sp.error : null;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  if (!err && !ok) return null;
  return <div role={err ? "alert" : "status"} className={`flash ${err ? "err" : "ok"}`}>{err ?? ok}</div>;
}

export function Tabs({ items }: { items: { href: string; label: React.ReactNode; on: boolean }[] }) {
  return (
    <nav className="tabs" aria-label="Weergave">
      {items.map((t) => <Link key={t.href} href={t.href} className={`tab ${t.on ? "on" : ""}`} aria-current={t.on ? "page" : undefined}>{t.label}</Link>)}
    </nav>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export const INVOICE_STATUS: Record<string, { label: string; tone: "g" | "a" | "b" | "n" | "r" }> = {
  draft: { label: "Concept", tone: "n" },
  open: { label: "Openstaand", tone: "b" },
  paid: { label: "Betaald", tone: "g" },
  credited: { label: "Gecrediteerd", tone: "n" },
  uncollectible: { label: "Oninbaar", tone: "r" },
};
