import Link from "next/link";
import { and, desc, eq, ilike, or, sql as dsql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { invoices, contacts } from "@/db/schema";
import { Top, Kpi, Money, Pill, Flash, Tabs, Empty, INVOICE_STATUS } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmtDateShort, today, daysBetween } from "@/lib/dates";
import { formatEur } from "@/lib/money";
import { type SP, str } from "@/lib/sp";

export const metadata = { title: "Facturen" };

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = str(sp.status) ?? "all";
  const q = str(sp.q) ?? "";
  const year = Number(str(sp.y) ?? today().slice(0, 4));
  const t = today();
  const conds: SQL[] = [];
  if (status === "late") conds.push(eq(invoices.status, "open"), dsql`${invoices.dueDate} < ${t}`);
  else if (status !== "all") conds.push(eq(invoices.status, status as "draft"));
  if (status !== "draft") conds.push(or(dsql`extract(year from ${invoices.issueDate}::date) = ${year}`, eq(invoices.status, "draft"))!);
  if (q) conds.push(or(ilike(invoices.number, `%${q}%`), ilike(contacts.name, `%${q}%`))!);
  const rows = await db.select({ i: invoices, name: contacts.name, country: contacts.country }).from(invoices)
    .innerJoin(contacts, eq(contacts.id, invoices.contactId)).where(conds.length ? and(...conds) : undefined)
    .orderBy(dsql`${invoices.number} is null desc`, desc(invoices.number)).limit(500);

  const [k] = await db.select({
    billed: dsql<string>`coalesce(sum(${invoices.subtotalCents}) filter (where ${invoices.status} <> 'draft' and extract(year from ${invoices.issueDate}::date) = ${year}),0)`,
    count: dsql<number>`count(*) filter (where ${invoices.status} <> 'draft' and extract(year from ${invoices.issueDate}::date) = ${year})`,
    open: dsql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}) filter (where ${invoices.status} = 'open'),0)`,
    openN: dsql<number>`count(*) filter (where ${invoices.status} = 'open')`,
    late: dsql<string>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}) filter (where ${invoices.status} = 'open' and ${invoices.dueDate} < ${t}),0)`,
    lateN: dsql<number>`count(*) filter (where ${invoices.status} = 'open' and ${invoices.dueDate} < ${t})`,
  }).from(invoices);

  const qs = (o: Record<string, string>) => `/facturen?${new URLSearchParams({ status, ...(q ? { q } : {}), y: String(year), ...o })}`;
  return (
    <>
      <Top title="Facturen" sub={`Verkoopfacturen ${year}`}>
        <Link className="btn" href="/facturen/sjablonen"><Icon name="inv" />Sjablonen</Link>
        <Link className="btn" href="/facturen/terugkerend"><Icon name="refresh" />Terugkerend</Link>
        <a className="btn" href={`/api/export/facturen?year=${year}`}><Icon name="down" />CSV {year}</a>
        <Link className="btn pri" href="/facturen/nieuw"><Icon name="plus" />Nieuwe factuur</Link>
      </Top>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label={`Gefactureerd ${year}`} value={formatEur(Number(k.billed))} detail={`${k.count} facturen excl. BTW`} />
        <Kpi label="Openstaand" value={formatEur(Number(k.open))} detail={`${k.openN} facturen`} />
        <Kpi label="Te laat" value={formatEur(Number(k.late))} tone={Number(k.late) ? "neg" : undefined} detail={`${k.lateN} facturen`} />
        <Kpi label="Jaar" value={<span className="row" style={{ fontSize: 18 }}><Link href={qs({ y: String(year - 1) })}>← {year - 1}</Link>{year < Number(t.slice(0, 4)) ? <Link href={qs({ y: String(year + 1) })}>{year + 1} →</Link> : null}</span>} />
      </div>
      <section className="card">
        <div className="ch">
          <Tabs items={[["all", "Alle"], ["draft", "Concept"], ["open", "Openstaand"], ["late", "Te laat"], ["paid", "Betaald"]].map(([v, l]) => ({ href: qs({ status: v }), label: l, on: status === v }))} />
          <form action="/facturen" className="row"><input type="hidden" name="status" value={status} /><input type="hidden" name="y" value={year} /><input name="q" defaultValue={q} className="inp" placeholder="Zoek klant of nummer" aria-label="Zoeken" style={{ width: 240 }} /></form>
        </div>
        {rows.length ? (
          <table className="t">
            <thead><tr><th>Nummer</th><th>Klant</th><th className="hide-sm">Datum</th><th className="hide-sm">Vervalt</th><th className="r">Totaal</th><th className="r">Status</th></tr></thead>
            <tbody>
              {rows.map(({ i, name, country }) => {
                const st = INVOICE_STATUS[i.status];
                const late = i.status === "open" && i.dueDate && i.dueDate < t;
                return (
                  <tr key={i.id} className="click">
                    <td><Link href={`/facturen/${i.id}`} className="num" style={{ fontWeight: 500 }}>{i.number ?? "concept"}</Link>{i.creditOf ? <span className="small muted"> credit</span> : null}</td>
                    <td><div style={{ fontWeight: 600 }}>{name}</div><div className="small muted">{country}{i.language === "en" ? " · Engels" : ""}</div></td>
                    <td className="muted hide-sm">{fmtDateShort(i.issueDate)}</td>
                    <td className="muted hide-sm">{fmtDateShort(i.dueDate)}</td>
                    <td className="r"><Money cents={i.totalCents} /></td>
                    <td className="r">{late ? <Pill tone="r">Te laat · {daysBetween(i.dueDate!, t)} d{i.remindersSent ? ` · herinnering ${i.remindersSent}` : ""}</Pill> : <Pill tone={st.tone}>{i.status === "open" && i.sentAt ? "Verstuurd" : st.label}</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Empty>Geen facturen gevonden.</Empty>}
      </section>
    </>
  );
}
