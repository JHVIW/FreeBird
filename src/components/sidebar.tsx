"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { Wordmark } from "./logo";

type Item = { href: string; label: string; icon: string; key: string };

// Gegroepeerd naar hoe je werkt: dagelijks, per kwartaal/jaar, en de rest.
const GROUPS: Item[][] = [
  [
    { href: "/", label: "Overzicht", icon: "home", key: "" },
    { href: "/bank", label: "Bank", icon: "bank", key: "bank" },
    { href: "/facturen", label: "Facturen", icon: "inv", key: "" },
    { href: "/inkoop", label: "Inkoop & bonnen", icon: "inbox", key: "inkoop" },
    { href: "/klanten", label: "Klanten", icon: "users", key: "" },
  ],
  [
    { href: "/btw", label: "BTW-aangifte", icon: "pct", key: "" },
    { href: "/jaar", label: "Jaaroverzicht", icon: "chart", key: "" },
    { href: "/journaal", label: "Journaal", icon: "book", key: "" },
  ],
  [
    { href: "/vraag", label: "Vraag het FreeBird", icon: "chat", key: "" },
    { href: "/instellingen", label: "Instellingen", icon: "gear", key: "" },
  ],
];

export function Sidebar({ counts, footer, logout }: { counts: Record<string, number>; footer: React.ReactNode; logout: () => Promise<void> }) {
  const path = usePathname();
  return (
    <nav className="side" aria-label="Hoofdmenu">
      <Link href="/" className="brand" aria-label="FreeBird, naar het overzicht"><Wordmark size={30} /></Link>
      {GROUPS.map((g, gi) => (
        <div key={gi} style={{ display: "contents" }}>
          {gi > 0 ? <div className="sep" role="presentation" /> : null}
          {g.map((n) => {
            const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
            const c = n.key ? counts[n.key] : 0;
            return (
              <Link key={n.href} href={n.href} className={`nav ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>
                <Icon name={n.icon} /><span className="nav-lbl">{n.label}</span>{c ? <span className="ct" aria-label={`${c} te doen`}>{c}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
      <div className="foot">
        {footer}
        <form action={logout} style={{ marginTop: 10 }}><button type="submit">Uitloggen</button></form>
      </div>
    </nav>
  );
}
