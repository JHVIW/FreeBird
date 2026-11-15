import Link from "next/link";
import { asc, desc, eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, invoices, contacts, receipts, bankAccounts } from "@/db/schema";
import { Top, Kpi, Money, Pill, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { today, quarterOf, fmtDateShort, fmtDate, monthLabel, daysBetween } from "@/lib/dates";
import { formatEur } from "@/lib/money";
import { accountBalance, monthlyResults, vatReturn, icpReport } from "@/lib/reports";
import { ossStatus } from "@/lib/vat";
import type { Suggestion } from "@/lib/matching";

export const metadata = { title: "Overzicht" };

export default async function Dashboard() {
  const t = today();
  const { year, quarter } = quarterOf(t);
  const prevQ = quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 };

  const [accs, openInv, todoTx, [rc], months, prevRet, curRet, icp, oss] = await Promise.all([
    db.select().from(bankAccounts).where(eq(bankAccounts.active, true)),
    db.select({ i: invoices, name: contacts.name }).from(invoices).innerJoin(contacts, eq(contacts.id, invoices.contactId)).where(eq(invoices.status, "open")).orderBy(asc(invoices.dueDate)),
    db.select().from(bankTransactions).where(eq(bankTransactions.status, "open")).orderBy(desc(bankTransactions.date)).limit(6),
    db.select({ n: dsql<number>`count(*)` }).from(receipts).where(inArray(receipts.status, ["new", "parsed", "error"])),
    monthlyResults(year),
    vatReturn(prevQ.year, prevQ.quarter),
    vatReturn(year, quarter),
    icpReport(prevQ.year, prevQ.quarter),
    ossStatus(year),
  ]);
  const [{ n: openTxCount }] = await db.select({ n: dsql<number>`count(*)` }).from(bankTransactions).where(eq(bankTransactions.status, "open"));

  const ledgerBank = await accountBalance("1000", t);
  const bunqBalance = accs.reduce((s, a) => s + (a.balanceCents ?? 0), 0);
  const balance = accs.some((a) => a.balanceCents != null) ? bunqBalance : ledgerBank;
  const vatOwed = -(await Promise.all(["1500", "1510", "1520", "1530", "1540", "1550"].map((c) => accountBalance(c, t)))).reduce((s, x) => s + x, 0);
  const openTotal = openInv.reduce((s, x) => s + x.i.totalCents - x.i.paidCents, 0);
  const overdue = openInv.filter((x) => x.i.dueDate && x.i.dueDate < t);
  const rev = months.reduce((s, m) => s + m.revenue, 0);
  const exp = months.reduce((s, m) => s + m.expense, 0);
  const max = Math.max(1, ...months.flatMap((m) => [m.revenue, m.expense]));
  const lastMonth = Number(t.slice(5, 7));
  const ossPct = Math.min(100, Math.round((oss.currentYear / oss.threshold) * 100));

  return (
    <>
      <Top title="Overzicht" sub={`${fmtDate(t, true)} · Q${quarter} ${year}`}>
        <Link className="btn" href="/inkoop"><Icon name="inbox" />Bon toevoegen</Link>
        <Link className="btn pri" href="/facturen/nieuw"><Icon name="plus" />Nieuwe factuur</Link>
      </Top>

      <div className="kpis">
        <Kpi label="Saldo bank" value={formatEur(balance)} detail={`Vrij besteedbaar ${formatEur(balance - Math.max(0, vatOwed))}`} />
        <Kpi label="Openstaande facturen" value={formatEur(openTotal)} detail={overdue.length ? <span className="neg" style={{ fontWeight: 600 }}>{overdue.length} te laat</span> : `${openInv.length} facturen`} />
        <Kpi label="Te verwerken" value={Number(openTxCount) + Number(rc.n)} detail={`${openTxCount} banktransacties · ${rc.n} bonnen`} />
        <Kpi label="BTW gereserveerd" value={formatEur(Math.max(0, vatOwed))} detail="Saldo BTW-rekeningen vandaag" />
      </div>

      <div className="split" style={{ marginBottom: 20 }}>
        <section className="card">
          <div className="ch"><h2>Omzet en kosten {year}</h2>
            <div className="row small muted">
              <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--accent)" }} />Omzet</span>
              <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--cost)" }} />Kosten</span>
            </div>
          </div>
          <div className="bars">
            {months.slice(0, Math.max(lastMonth, 1)).map((m, i) => (
              <div className="m" key={i}>
                <div className="pair">
                  <div title={`Omzet ${formatEur(m.revenue)}`} style={{ height: `${(Math.max(0, m.revenue) / max) * 170}px`, background: "var(--accent)" }} />
                  <div title={`Kosten ${formatEur(m.expense)}`} style={{ height: `${(Math.max(0, m.expense) / max) * 170}px`, background: "var(--cost)" }} />
                </div>
                <span className="small muted">{monthLabel(i)}</span>
              </div>
            ))}
          </div>
          <div className="grid3" style={{ borderTop: "1px solid var(--head-line)", gap: 0 }}>
            <div style={{ padding: "14px 20px" }}><div className="small muted">Omzet</div><div className="num" style={{ fontSize: 18 }}>{formatEur(rev)}</div></div>
            <div style={{ padding: "14px 20px", borderLeft: "1px solid var(--head-line)" }}><div className="small muted">Kosten</div><div className="num" style={{ fontSize: 18 }}>{formatEur(exp)}</div></div>
            <div style={{ padding: "14px 20px", borderLeft: "1px solid var(--head-line)" }}><div className="small muted">Resultaat</div><div className={`num ${rev - exp >= 0 ? "pos" : "neg"}`} style={{ fontSize: 18 }}>{formatEur(rev - exp)}</div></div>
          </div>
        </section>

        <section className="card">
          <div className="ch"><h2>Deadlines</h2></div>
          <div className="cb" style={{ paddingTop: 4, paddingBottom: 8 }}>
            {prevRet.status !== "filed" ? (
              <DeadlineRow date={prevRet.deadline} title={`BTW-aangifte Q${prevQ.quarter} ${prevQ.year}`} detail={<>{formatEur(prevRet.payableExactCents)} · <Link href={`/btw?y=${prevQ.year}&q=${prevQ.quarter}`}>bekijk rubrieken</Link></>} />
            ) : null}
            {icp.lines.length && prevRet.status !== "filed" ? (
              <DeadlineRow date={prevRet.deadline} title={`ICP-opgaaf Q${prevQ.quarter} ${prevQ.year}`} detail={`${icp.lines.length} afnemer(s) · ${formatEur(icp.totalCents)}`} />
            ) : null}
            <DeadlineRow date={curRet.deadline} title={`BTW Q${quarter} ${year} (lopend)`} detail={`Tot nu toe ${formatEur(curRet.payableExactCents)}`} />
            <div className="row" style={{ padding: "12px 0" }}>
              <Pill tone={ossPct >= 80 ? "a" : "n"}>{ossPct}%</Pill>
              <div><div style={{ fontWeight: 600 }}>OSS-drempel {year}</div><div className="small muted">{formatEur(oss.currentYear)} van {formatEur(oss.threshold)} aan particulieren in andere EU-landen{oss.activeAllYear ? " · vorig jaar overschreden: OSS geldt heel dit jaar" : ""}</div></div>
            </div>
          </div>
        </section>
      </div>

      <div className="split">
        <section className="card">
          <div className="ch"><h2>Te verwerken</h2><Link className="btn sm" href="/bank?filter=open">Alles verwerken</Link></div>
          {todoTx.length ? (
            <table className="t"><tbody>
              {todoTx.map((tx) => {
                const s = (tx.suggestions as Suggestion[] | null)?.[0];
                return (
                  <tr key={tx.id} className="click">
                    <td><Link className="rowlink" href={`/bank?tx=${tx.id}`}><div style={{ fontWeight: 600 }}>{tx.counterpartyName ?? "Onbekend"}</div><div className="small muted">{fmtDateShort(tx.date)} · {s ? s.label : tx.description.slice(0, 60)}</div></Link></td>
                    <td className="r"><Money cents={tx.amountCents} sign /></td>
                    <td className="r">{s ? <Pill tone="b">Voorstel</Pill> : <Pill tone="a">Handmatig</Pill>}</td>
                  </tr>
                );
              })}
            </tbody></table>
          ) : <Empty>Niets te verwerken.</Empty>}
        </section>
        <section className="card">
          <div className="ch"><h2>Openstaand</h2><Link className="btn sm" href="/facturen?status=open">Alle facturen</Link></div>
          {openInv.length ? (
            <table className="t"><tbody>
              {openInv.slice(0, 6).map(({ i, name }) => {
                const late = i.dueDate && i.dueDate < t ? daysBetween(i.dueDate, t) : 0;
                return (
                  <tr key={i.id}>
                    <td><Link href={`/facturen/${i.id}`} className="num">{i.number}</Link><div className="small muted">{name}</div></td>
                    <td className="r"><Money cents={i.totalCents - i.paidCents} /></td>
                    <td className="r">{late ? <Pill tone="r">Te laat · {late} d</Pill> : <Pill>Vervalt {fmtDateShort(i.dueDate)}</Pill>}</td>
                  </tr>
                );
              })}
            </tbody></table>
          ) : <Empty>Geen openstaande facturen.</Empty>}
        </section>
      </div>
    </>
  );
}

function DeadlineRow({ date, title, detail }: { date: string; title: string; detail: React.ReactNode }) {
  const d = daysBetween(today(), date);
  return (
    <div className="row" style={{ padding: "12px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <Pill tone={d <= 14 ? "a" : "n"}>{fmtDateShort(date)}</Pill>
      <div><div style={{ fontWeight: 600 }}>{title}</div><div className="small muted">{detail}</div></div>
    </div>
  );
}
