import Link from "next/link";
import { between, desc } from "drizzle-orm";
import { db } from "@/db";
import { timeEntries } from "@/db/schema";
import { Top, Flash, Kpi, Money, Pill } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ibOverview, assetOverview } from "@/lib/reports";
import { today, fmtDate, fmtDateShort } from "@/lib/dates";
import { formatEur, formatPct } from "@/lib/money";
import { type SP, int } from "@/lib/sp";
import { addHours, deleteHours, addAsset, depreciate, setOtherIncome } from "../../actions/year";

export const metadata = { title: "Jaaroverzicht" };

export default async function YearPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const t = today();
  const year = int(sp.y) ?? Number(t.slice(0, 4));
  const ongoing = year === Number(t.slice(0, 4));
  const [ib, assetList, hours] = await Promise.all([
    ibOverview(year),
    assetOverview(),
    db.select().from(timeEntries).where(between(timeEntries.date, `${year}-01-01`, `${year}-12-31`)).orderBy(desc(timeEntries.date)).limit(20),
  ]);
  const { pnl, bs } = ib;
  const pct = Math.min(100, (ib.hours / ib.hoursCriterion) * 100);

  return (
    <>
      <Top title={`Jaaroverzicht ${year}`} sub={`Winst uit onderneming${ongoing ? ` · stand ${fmtDate(t)}, jaar nog open` : ""}`}>
        <Link className="btn" href={`/jaar?y=${year - 1}`}>← {year - 1}</Link>
        {!ongoing ? <Link className="btn" href={`/jaar?y=${year + 1}`}>{year + 1} →</Link> : null}
        <a className="btn" href={`/api/export/journaal?year=${year}`}><Icon name="down" />Journaal CSV</a>
      </Top>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label="Omzet" value={formatEur(pnl.revenueCents)} />
        <Kpi label="Kosten" value={formatEur(pnl.expenseCents)} />
        <Kpi label="Winst" value={formatEur(pnl.profitCents)} tone={pnl.profitCents >= 0 ? "pos" : "neg"} detail={ib.tax ? `Belasting ca. ${formatEur(ib.tax.totalCents)}` : "Vóór ondernemersaftrek"} />
        <Kpi label={`Uren ${year}`} value={ib.hours.toLocaleString("nl-NL")} detail={ib.meetsHours ? "Urencriterium gehaald" : `Urencriterium ${ib.hoursCriterion.toLocaleString("nl-NL")} niet gehaald`} />
      </div>

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="ch"><h2>Invulhulp aangifte inkomstenbelasting</h2><span className="small muted">Winst uit onderneming</span></div>
            <table className="t">
              <thead><tr><th>Balans per 31 december</th><th className="r">Bedrag</th></tr></thead>
              <tbody>
                {ib.bsGroups.assets.map((g) => <tr key={g.label}><td>{g.label}</td><td className="r"><Money cents={g.cents} /></td></tr>)}
                <tr className="total"><td>Totaal activa</td><td className="r"><Money cents={bs.totalAssets} /></td></tr>
                <tr><td>Ondernemingsvermogen</td><td className="r"><Money cents={bs.equityTotal} /></td></tr>
                {ib.bsGroups.liabilities.map((g) => <tr key={g.label}><td>{g.label}</td><td className="r"><Money cents={g.cents} /></td></tr>)}
                <tr className="total"><td>Totaal passiva</td><td className="r"><Money cents={bs.totalLiab + bs.equityTotal} /></td></tr>
              </tbody>
            </table>
            <table className="t" style={{ borderTop: "1px solid var(--head-line)" }}>
              <thead><tr><th>Winst-en-verliesrekening</th><th className="r">Bedrag</th></tr></thead>
              <tbody>
                {ib.pnlGroups.revenue.map((g) => <tr key={g.label}><td>{g.label}</td><td className="r"><Money cents={g.cents} /></td></tr>)}
                {ib.pnlGroups.expenses.map((g) => <tr key={g.label}><td>{g.label}</td><td className="r"><Money cents={-g.cents} /></td></tr>)}
                <tr className="total"><td>Winst</td><td className="r"><Money cents={pnl.profitCents} /></td></tr>
                {ib.mixedNonDeductibleCents > 0 ? <>
                  <tr><td>Niet aftrekbaar: 20% van gemengde kosten ({formatEur(ib.mixedCents)} representatie, eten en drinken)</td><td className="r"><Money cents={ib.mixedNonDeductibleCents} /></td></tr>
                  <tr className="total"><td>Fiscale winst</td><td className="r"><Money cents={ib.fiscalProfitCents} /></td></tr>
                </> : null}
                <tr><td>Zelfstandigenaftrek {ib.meetsHours ? "" : "(urencriterium niet gehaald)"}</td><td className="r"><Money cents={-ib.zelfstandigenaftrekCents} /></td></tr>
                <tr><td>MKB-winstvrijstelling {formatPct(ib.mkbBp)}</td><td className="r"><Money cents={-ib.mkbCents} /></td></tr>
                <tr className="total"><td>Belastbare winst (indicatie)</td><td className="r"><Money cents={ib.taxableProfitCents} /></td></tr>
              </tbody>
            </table>
            <div className="small muted" style={{ padding: "12px 20px", borderTop: "1px solid var(--head-line)" }}>
              Indicatie. De aangifte rekent zelf de ondernemersaftrek en MKB-winstvrijstelling uit. Investeringen dit jaar: {formatEur(ib.investmentsCents)}{ib.kiaApplies ? " · mogelijk recht op KIA" : ""}. {bs.check !== 0 ? <span className="neg">Balans sluit niet ({formatEur(bs.check)}).</span> : null}
            </div>
          </section>

          {ib.tax ? (
            <section className="card">
              <div className="ch"><h2>Te betalen belasting (schatting)</h2><span className="num">{formatEur(ib.tax.totalCents)}</span></div>
              <form action={setOtherIncome} className="cb row wrap" style={{ alignItems: "end", borderBottom: "1px solid var(--head-line)" }}>
                <input type="hidden" name="y" value={year} />
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="oi">Ander inkomen {year} (fiscaal loon, jaaropgave)</label>
                  <input id="oi" name="otherIncome" inputMode="decimal" defaultValue={ib.tax.otherIncomeCents ? (ib.tax.otherIncomeCents / 100).toFixed(2).replace(".", ",") : ""} placeholder="0" />
                </div>
                <button className="btn" type="submit">Opslaan</button>
              </form>
              <table className="t">
                <thead><tr><th>Inkomstenbelasting box 1</th><th className="r">Bedrag</th></tr></thead>
                <tbody>
                  {ib.tax.otherIncomeCents > 0 ? <tr><td>Ander inkomen</td><td className="r"><Money cents={ib.tax.otherIncomeCents} /></td></tr> : null}
                  <tr><td>Belastbare winst</td><td className="r"><Money cents={ib.tax.taxableCents} /></td></tr>
                  {ib.tax.combined.bracketTax.filter((b) => b.taxCents > 0).map((b) => (
                    <tr key={b.fromCents}><td>{formatPct(b.bp)} over {formatEur(b.fromCents)}{b.toCents != null ? ` – ${formatEur(b.toCents)}` : " en hoger"}</td><td className="r"><Money cents={b.taxCents} /></td></tr>
                  ))}
                  {ib.tax.combined.deductionCapCents > 0 ? <tr><td>Aftrekbeperking ondernemersaftrek en MKB-vrijstelling</td><td className="r"><Money cents={ib.tax.combined.deductionCapCents} /></td></tr> : null}
                  <tr><td>Algemene heffingskorting</td><td className="r"><Money cents={-ib.tax.combined.generalCreditCents} /></td></tr>
                  <tr><td>Arbeidskorting</td><td className="r"><Money cents={-ib.tax.combined.labourCreditCents} /></td></tr>
                  {ib.tax.otherIncomeCents > 0 ? (
                    <>
                      <tr className="total"><td>Inkomstenbelasting totaal</td><td className="r"><Money cents={ib.tax.combined.incomeTaxCents} /></td></tr>
                      <tr><td>Al betaald via loonheffing (geschat)</td><td className="r"><Money cents={-ib.tax.otherIncomeTaxCents} /></td></tr>
                    </>
                  ) : null}
                  <tr className="total"><td>Inkomstenbelasting over de winst</td><td className="r"><Money cents={ib.tax.incomeTaxCents} /></td></tr>
                  <tr><td>Inkomensafhankelijke bijdrage Zvw</td><td className="r"><Money cents={ib.tax.zvwCents} /></td></tr>
                  <tr className="total"><td>Totaal te betalen</td><td className="r"><Money cents={ib.tax.totalCents} /></td></tr>
                </tbody>
              </table>
              <div className="small muted" style={{ padding: "12px 20px", borderTop: "1px solid var(--head-line)" }}>
                Indicatie{ongoing ? " op basis van de winst tot nu toe" : ""}: {formatPct(ib.tax.effectiveBp)} van de winst. {ib.tax.otherIncomeCents > 0 ? "Gaat ervan uit dat je werkgever de juiste loonheffing inhoudt, met loonheffingskorting. " : ""}Geldt onder de AOW-leeftijd, zonder voorlopige aanslag. Box 3, overige aftrekposten en toeslagen tellen niet mee. Tarieven staan in de fiscale parameters (<code>ib_rates</code>).
              </div>
            </section>
          ) : null}

          <section className="card">
            <div className="ch"><h2>Winst-en-verliesrekening per rekening</h2></div>
            <table className="t">
              <thead><tr><th>Opbrengsten</th><th /></tr></thead>
              <tbody>{pnl.revenue.map((r) => <tr key={r.code}><td>{r.code} {r.name}</td><td className="r"><Money cents={r.cents} /></td></tr>)}</tbody>
            </table>
            <table className="t" style={{ borderTop: "1px solid var(--head-line)" }}>
              <thead><tr><th>Kosten</th><th /></tr></thead>
              <tbody>{pnl.expenses.map((r) => <tr key={r.code}><td>{r.code} {r.name}</td><td className="r"><Money cents={r.cents} /></td></tr>)}</tbody>
            </table>
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="ch"><h2>Urencriterium</h2><span className="num">{ib.hours} / {ib.hoursCriterion}</span></div>
            <div className="cb stack">
              <div className="bar"><div style={{ width: `${pct}%` }} /></div>
              <div className="row wrap small">
                <span>Zelfstandigenaftrek</span>{ib.meetsHours ? <Pill tone="g">Van toepassing</Pill> : <Pill>Niet van toepassing</Pill>}
                <span>MKB-winstvrijstelling</span><Pill tone="g">Van toepassing</Pill>
              </div>
              <form action={addHours} className="grid3" style={{ alignItems: "end" }}>
                <div className="field"><label htmlFor="hd">Datum</label><input id="hd" name="date" type="date" defaultValue={t} required /></div>
                <div className="field"><label htmlFor="hh">Uren</label><input id="hh" name="hours" inputMode="decimal" required /></div>
                <button className="btn" type="submit">Toevoegen</button>
                <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="hn">Notitie</label><input id="hn" name="note" /></div>
              </form>
              {hours.map((h) => (
                <form key={h.id} action={deleteHours} className="spread small">
                  <input type="hidden" name="rowId" value={h.id} /><input type="hidden" name="y" value={year} />
                  <span>{fmtDateShort(h.date)} · {(h.minutes / 60).toLocaleString("nl-NL")} u{h.note ? ` · ${h.note}` : ""}</span>
                  <button className="linkbtn small" type="submit" aria-label="Verwijderen">verwijderen</button>
                </form>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="ch"><h2>Activa</h2><form action={depreciate}><button className="btn sm" type="submit">Afschrijvingen boeken</button></form></div>
            <table className="t"><tbody>
              {assetList.map((a) => (
                <tr key={a.id}><td><div style={{ fontWeight: 600 }}>{a.name}</div><div className="small muted">{fmtDate(a.purchaseDate)} · {a.months} mnd · {formatEur(a.perMonthCents)}/mnd</div></td>
                  <td className="r"><Money cents={a.bookValueCents} /><div className="small muted">van {formatEur(a.costCents)}</div></td></tr>
              ))}
            </tbody></table>
            <details className="more cb"><summary>Bedrijfsmiddel handmatig toevoegen</summary>
              <form action={addAsset} className="stack" style={{ marginTop: 8 }}>
                <div className="field"><label htmlFor="an">Naam</label><input id="an" name="name" required /></div>
                <div className="grid2">
                  <div className="field"><label htmlFor="ad">Aanschafdatum</label><input id="ad" name="date" type="date" required /></div>
                  <div className="field"><label htmlFor="ac">Aanschafwaarde excl. BTW</label><input id="ac" name="cost" inputMode="decimal" required /></div>
                  <div className="field"><label htmlFor="am">Looptijd (maanden)</label><input id="am" name="months" type="number" defaultValue={36} /></div>
                  <div className="field"><label htmlFor="ar">Restwaarde</label><input id="ar" name="residual" inputMode="decimal" defaultValue="0" /></div>
                </div>
                <button className="btn" type="submit">Toevoegen</button>
              </form>
            </details>
          </section>

          <section className="card">
            <div className="ch"><h2>Balans {ongoing ? "vandaag" : "31 dec"}</h2></div>
            <table className="t"><tbody>
              {bs.assets.map((r) => <tr key={r.code}><td>{r.name}</td><td className="r"><Money cents={r.cents} /></td></tr>)}
              {bs.liabilities.map((r) => <tr key={r.code}><td>{r.name}</td><td className="r"><Money cents={-r.cents} /></td></tr>)}
              <tr className="total"><td>Eigen vermogen</td><td className="r"><Money cents={bs.equityTotal} /></td></tr>
            </tbody></table>
          </section>
        </aside>
      </div>
    </>
  );
}
