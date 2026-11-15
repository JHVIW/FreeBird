import Link from "next/link";
import { and, asc, between, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { vatEntries, journalEntries, contacts } from "@/db/schema";
import { Top, Flash, Kpi, Money, Pill, Tabs, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { vatReturn, icpReport, ossReport, periodChecklist } from "@/lib/reports";
import { quarterOf, today, fmtDate, fmtDateShort, quarterRange } from "@/lib/dates";
import { formatEur, formatPct, formatWholeEur } from "@/lib/money";
import { countryName } from "@/lib/eu";
import { type SP, str, int } from "@/lib/sp";
import { fileVat, vatReviewAction } from "../../actions/vat";
import { vatFindings, lastVatReview, type Finding } from "@/lib/ai-review";
import { aiConfigured } from "@/lib/ai";

export const metadata = { title: "BTW" };

const RUBRIEK_CODES: Record<string, string[]> = {
  "1a": ["V21"], "1b": ["V9"], "1e": ["V0", "VERL_NL", "NONEU_S"], "2a": ["RC_NL"], "3a": ["EXPORT"], "3b": ["ICP_S", "ICP_G"],
  "4a": ["RC_NONEU"], "4b": ["RC_EU"], "5b": ["I21", "I9", "RC_EU", "RC_NONEU", "RC_NL"],
};

export default async function VatPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const cur = quarterOf(today());
  const def = cur.quarter === 1 ? { year: cur.year - 1, quarter: 4 } : { year: cur.year, quarter: cur.quarter - 1 };
  const yq = str(sp.yq)?.split("-").map(Number);
  const year = yq?.[0] ?? int(sp.y) ?? def.year;
  const quarter = yq?.[1] ?? int(sp.q) ?? def.quarter;
  const tab = str(sp.tab) ?? "aangifte";
  const drill = str(sp.r);
  const [ret, icp, oss, checks, findings, review, ai] = await Promise.all([vatReturn(year, quarter), icpReport(year, quarter), ossReport(year, quarter), periodChecklist(year, quarter), vatFindings(year, quarter), lastVatReview(year, quarter), aiConfigured()]);
  const filed = ret.status === "filed";
  const base = `/btw?y=${year}&q=${quarter}`;
  const quarters = [];
  for (let i = 0; i < 6; i++) {
    let q = cur.quarter - i, y = cur.year;
    while (q < 1) { q += 4; y--; }
    quarters.push({ y, q });
  }
  const { from, to } = quarterRange(year, quarter);
  const drillRows = drill && RUBRIEK_CODES[drill]
    ? await db.select({ v: vatEntries, e: journalEntries, name: contacts.name }).from(vatEntries).innerJoin(journalEntries, eq(journalEntries.id, vatEntries.entryId)).leftJoin(contacts, eq(contacts.id, vatEntries.contactId))
      .where(and(between(vatEntries.date, from, to), inArray(vatEntries.vatCode, RUBRIEK_CODES[drill]))).orderBy(asc(vatEntries.date))
    : [];
  const ossPct = Math.min(100, (oss.status.currentYear / oss.status.threshold) * 100);

  return (
    <>
      <Top title={`BTW Q${quarter} ${year}`} sub={`${fmtDate(from)} t/m ${fmtDate(to)} · aangifte en betaling uiterlijk ${fmtDate(ret.deadline, true)}`}>
        <form action="/btw" className="row">
          <label htmlFor="per" className="lbl" style={{ position: "absolute", left: -9999 }}>Kwartaal</label>
          <select id="per" name="yq" className="inp" defaultValue={`${year}-${quarter}`} style={{ width: 140 }}>
            {quarters.map(({ y, q }) => <option key={`${y}-${q}`} value={`${y}-${q}`}>Q{q} {y}</option>)}
          </select>
          <button className="btn" type="submit">Toon</button>
        </form>
      </Top>
      <Flash sp={sp} />
      {filed ? <div className="flash ok">Deze periode is aangegeven en vergrendeld op {ret.filedAt?.toLocaleDateString("nl-NL")}. Correcties boek je in een open periode.</div> : null}

      <div className="kpis">
        <Kpi label={ret.payableRounded >= 0 ? "Te betalen (5g)" : "Terug te vragen (5g)"} value={`€ ${formatWholeEur(Math.abs(ret.payableRounded))}`} detail={`Exact ${formatEur(ret.payableExactCents)}`} />
        <Kpi label="Verschuldigd (5a)" value={`€ ${formatWholeEur(ret.rubrieken.find((r) => r.code === "5a")!.vat!)}`} detail="Incl. verlegde BTW 2a/4a/4b" />
        <Kpi label="Voorbelasting (5b)" value={`€ ${formatWholeEur(ret.rubrieken.find((r) => r.code === "5b")!.vat!)}`} detail={`${ret.inputCount} inkoopboekingen`} />
        <Kpi label="OSS-drempel" value={`${Math.round(ossPct)}%`} detail={`${formatEur(oss.status.currentYear)} van ${formatEur(oss.status.threshold)}`} />
      </div>

      <div className="split">
        <section className="card">
          <div className="ch">
            <Tabs items={[["aangifte", "Aangifte"], ["icp", "ICP-opgaaf"], ["oss", "OSS"]].map(([v, l]) => ({ href: `${base}&tab=${v}`, label: l, on: tab === v }))} />
            <span className="small muted">Klik een rubriek voor de boekingen</span>
          </div>

          {tab === "aangifte" ? (
            <>
              <table className="t">
                <thead><tr><th>Rubriek</th><th>Omschrijving</th><th className="r hide-sm">Omzet</th><th className="r hide-sm">BTW</th><th className="r">Invullen</th><th className="r">BTW</th></tr></thead>
                <tbody>
                  {ret.rubrieken.map((r) => (
                    <tr key={r.code} className={`${RUBRIEK_CODES[r.code] ? "click" : ""} ${drill === r.code ? "sel" : ""} ${r.code === "5g" ? "total" : ""}`}>
                      <td className="num">{RUBRIEK_CODES[r.code] ? <Link href={`${base}&tab=aangifte&r=${r.code}`}>{r.code}</Link> : r.code}</td>
                      <td>{r.label}</td>
                      <td className="r num hide-sm">{r.baseCents != null ? formatEur(r.baseCents) : ""}</td>
                      <td className="r num hide-sm">{r.vatCents != null ? formatEur(r.vatCents) : ""}</td>
                      <td className="r num" style={{ fontWeight: 600 }}>{r.base != null ? formatWholeEur(r.base) : ""}</td>
                      <td className="r num" style={{ fontWeight: 600 }}>{r.vat != null ? formatWholeEur(r.vat) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small muted" style={{ padding: "12px 20px", borderTop: "1px solid var(--head-line)" }}>&quot;Invullen&quot; is in hele euro&apos;s, afgerond in je voordeel: verschuldigd omlaag, voorbelasting omhoog. Het verschil wordt bij vergrendelen als afronding geboekt.</div>
              {drill ? (
                <div style={{ borderTop: "1px solid var(--head-line)" }}>
                  <div className="ch"><h2>Boekingen in {drill}</h2><Link href={`${base}&tab=aangifte`} className="btn sm">Sluiten</Link></div>
                  {drillRows.length ? (
                    <table className="t"><tbody>
                      {drillRows.map(({ v, e, name }) => (
                        <tr key={v.id}><td className="muted">{fmtDateShort(v.date)}</td><td>{e.description}<div className="small muted">{name ?? ""} · {v.vatCode} {formatPct(v.rateBp)}</div></td><td className="r"><Money cents={v.baseCents} /></td><td className="r"><Money cents={v.vatCents} /></td></tr>
                      ))}
                    </tbody></table>
                  ) : <Empty>Geen boekingen.</Empty>}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "icp" ? (
            icp.lines.length ? (
              <table className="t">
                <thead><tr><th>Afnemer</th><th>Land</th><th>BTW-nummer</th><th>Soort</th><th className="r">Bedrag</th><th className="r">VIES</th></tr></thead>
                <tbody>
                  {icp.lines.map((l, i) => (
                    <tr key={i}><td style={{ fontWeight: 600 }}>{l.name}</td><td>{l.country}</td><td className="num">{l.vatNumber}</td><td>{l.type}</td><td className="r"><Money cents={l.base} /></td><td className="r">{l.viesValid ? <Pill tone="g">Geldig</Pill> : <Pill tone="r">Controleren</Pill>}</td></tr>
                  ))}
                  <tr className="total"><td colSpan={4}>Totaal (moet gelijk zijn aan rubriek 3b)</td><td className="r"><Money cents={icp.totalCents} /></td><td className="r">{icp.totalCents === (ret.rubrieken.find((r) => r.code === "3b")!.baseCents ?? 0) ? <Pill tone="g">Klopt</Pill> : <Pill tone="r">Verschil</Pill>}</td></tr>
                </tbody>
              </table>
            ) : <Empty>Geen intracommunautaire prestaties in dit kwartaal, dus geen ICP-opgaaf nodig.</Empty>
          ) : null}

          {tab === "oss" ? (
            <>
              <div className="cb" style={{ borderBottom: "1px solid var(--head-line)" }}>
                <div className="spread"><span style={{ fontWeight: 600 }}>EU-drempel digitale diensten aan particulieren {year}</span><span className="num">{formatEur(oss.status.currentYear)} / {formatEur(oss.status.threshold)}</span></div>
                <div className={`bar ${ossPct >= 80 ? "warn" : ""}`} style={{ marginTop: 10 }}><div style={{ width: `${ossPct}%` }} /></div>
                <div className="small muted" style={{ marginTop: 8 }}>
                  Vorig jaar: {formatEur(oss.status.previousYear)}. {oss.status.activeAllYear ? "Vorig jaar overschreden: dit hele jaar BTW van het land van de klant." : oss.status.currentYear > oss.status.threshold ? "Drempel dit jaar overschreden: vanaf de overschrijdende verkoop BTW van het land van de klant." : "Onder de drempel reken je Nederlandse BTW (zit in 1a)."}
                </div>
              </div>
              {oss.lines.length ? (
                <>
                  <div className="ch"><h2>OSS-aangifte Q{quarter} (uiterlijk {fmtDate(oss.deadline)})</h2></div>
                  <table className="t">
                    <thead><tr><th>Land</th><th className="r">Tarief</th><th className="r">Omzet</th><th className="r">BTW</th></tr></thead>
                    <tbody>
                      {oss.lines.map((l) => <tr key={`${l.country}${l.rateBp}`}><td style={{ fontWeight: 600 }}>{countryName(l.country)}</td><td className="r">{formatPct(l.rateBp)}</td><td className="r"><Money cents={l.base} /></td><td className="r"><Money cents={l.vat} /></td></tr>)}
                    </tbody>
                  </table>
                </>
              ) : null}
              <div className="ch"><h2>Particulieren in andere EU-landen, {year}</h2></div>
              {oss.perCountry.length ? (
                <table className="t">
                  <thead><tr><th>Land</th><th className="r">Tarief</th><th className="r">Verkopen</th><th className="r">Omzet</th><th className="r">Bewijs land</th></tr></thead>
                  <tbody>
                    {oss.perCountry.map((l) => <tr key={l.country}><td style={{ fontWeight: 600 }}>{countryName(l.country)}</td><td className="r muted">{formatPct(l.rateBp)}</td><td className="r num">{l.n}</td><td className="r"><Money cents={l.base} /></td><td className="r">{l.mismatches ? <Pill tone="a">{l.mismatches}× IBAN-land wijkt af</Pill> : <Pill tone="g">IBAN klopt</Pill>}</td></tr>)}
                  </tbody>
                </table>
              ) : <Empty>Nog geen verkopen aan particulieren in andere EU-landen.</Empty>}
            </>
          ) : null}
        </section>

        <aside className="stack">
          <section className="card">
            <div className="ch"><h2>Controle vóór indienen</h2></div>
            <div className="cb" style={{ paddingTop: 6, paddingBottom: 10 }}>
              {checks.map((c, i) => (
                <div key={i} className="row" style={{ padding: "9px 0", borderBottom: i < checks.length - 1 ? "1px solid var(--line-soft)" : 0 }}>
                  <span style={{ color: c.ok ? "var(--accent-ink)" : "var(--warn)" }}><Icon name={c.ok ? "check" : "alert"} /></span>
                  <span>{c.ok ? c.label : <Link href={c.href}>{c.label}</Link>}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="card" id="controle">
            <div className="ch"><h2>Controle op fouten</h2></div>
            <div className="cb stack">
              {findings.length ? findings.map((f, i) => <FindingBox key={i} f={f} />) : <div className="small muted"><Icon name="check" /> De vaste controles vinden niets.</div>}
              {review ? (
                <>
                  <div className="small muted">AI-controle van {new Date(review.at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}: {review.summary}</div>
                  {review.findings.map((f, i) => <FindingBox key={`ai${i}`} f={f} />)}
                </>
              ) : null}
              {ai ? (
                <form action={vatReviewAction}>
                  <input type="hidden" name="year" value={year} /><input type="hidden" name="quarter" value={quarter} />
                  <button className="btn sm" type="submit"><Icon name="spark" />{review ? "AI-controle opnieuw" : "AI-controle uitvoeren"}</button>
                </form>
              ) : null}
            </div>
          </section>
          {!filed ? (
            <form action={fileVat} className="card cb stack">
              <input type="hidden" name="year" value={year} /><input type="hidden" name="quarter" value={quarter} />
              <div style={{ fontWeight: 600 }}>Na indienen in Mijn Belastingdienst Zakelijk</div>
              <div className="small muted">FreeBird vergrendelt Q{quarter} en boekt de BTW-saldi naar &quot;af te dragen&quot;. De betaling aan de Belastingdienst wordt daarna in Bank herkend.</div>
              <label className="check small"><input type="checkbox" name="confirm" /> Ik heb deze aangifte ingediend</label>
              <button className="btn pri" type="submit"><Icon name="lock" />Vergrendel Q{quarter} {year}</button>
            </form>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function FindingBox({ f }: { f: Finding }) {
  return (
    <div className={`box ${f.severity === "laag" ? "plain" : "warn"}`}>
      <div className="t">{f.severity === "hoog" ? "Belangrijk" : f.severity === "middel" ? "Controleren" : "Ter info"}{f.source === "ai" ? " · AI" : ""}</div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>{f.href ? <Link href={f.href}>{f.title}</Link> : f.title}</div>
      <div className="small">{f.detail}</div>
    </div>
  );
}
