import Link from "next/link";
import { asc, eq, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, mbItems, vatCodes } from "@/db/schema";
import { Top, Flash, Pill, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { AutoRefresh } from "@/components/live";
import { getSetting } from "@/lib/settings";
import { aiConfigured } from "@/lib/ai";
import { fetchStatus, DOC_KINDS } from "@/lib/moneybird-fetch";
import { buildPlan, overnameDone } from "@/lib/moneybird-overname";
import { formatEur } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import type { SP } from "@/lib/sp";
import { mbFetchAction, mbSuggestMapping, mbSaveMapping, mbRunOvername, mbUndo } from "../../actions/moneybird";

export const metadata = { title: "Moneybird" };

const TYPE_LABEL: Record<string, string> = {
  non_current_assets: "vaste activa", current_assets: "vlottende activa", equity: "eigen vermogen", non_current_liabilities: "langlopende schulden",
  current_liabilities: "kortlopende schulden", revenue: "omzet", direct_costs: "inkoopkosten", expenses: "kosten", other_income_expenses: "overige baten/lasten",
  other: "overig", temporary: "tussenrekening", provisions: "voorzieningen",
};

export default async function MoneybirdPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [g, status, ai, counts, accs, codes, done] = await Promise.all([
    getSetting("general"), fetchStatus(), aiConfigured(),
    db.select({
      kind: mbItems.kind, n: dsql<number>`count(*)`,
      files: dsql<number>`coalesce(sum(jsonb_array_length(${mbItems.files})),0)`,
      stored: dsql<number>`coalesce(sum((select count(*) from jsonb_array_elements(${mbItems.files}) f where f->>'fileId' is not null)),0)`,
      first: dsql<string | null>`min(${mbItems.date})::text`, last: dsql<string | null>`max(${mbItems.date})::text`,
    }).from(mbItems).groupBy(mbItems.kind),
    db.select().from(accounts).where(eq(accounts.active, true)).orderBy(asc(accounts.code)),
    db.select().from(vatCodes).where(eq(vatCodes.active, true)),
    overnameDone(),
  ]);
  const hasToken = !!g.moneybirdToken && !!g.moneybirdAdministrationId;
  const fetched = counts.some((c) => DOC_KINDS.some((k) => k.kind === c.kind));
  const plan = fetched ? await buildPlan() : null;
  const busy = status.running || status.queued;
  const unmapped = plan ? plan.neededLedger.filter((l) => !l.code).length + plan.neededTax.filter((t) => !t.code).length : 0;

  return (
    <>
      <Top title="Overstappen van Moneybird" sub="Alles uit Moneybird ophalen, bewaren en overnemen, zodat je je abonnement kunt opzeggen" />
      <Flash sp={sp} />

      <section className="card" style={{ marginBottom: 18 }}>
        <div className="ch"><h2>1. Ophalen</h2>{status.status === "ok" ? <Pill tone="g">Klaar</Pill> : busy ? <Pill tone="b">Bezig</Pill> : status.status === "fout" ? <Pill tone="r">Fout</Pill> : null}</div>
        <div className="cb stack">
          {!hasToken ? (
            <div className="flash err">Vul eerst je Moneybird API-token en administratie-id in bij <Link href="/instellingen#algemeen">Instellingen › Algemeen</Link>. Maak het token in Moneybird onder Instellingen › Externe applicaties en AI-koppelingen, met leesrechten op alles.</div>
          ) : null}
          {busy ? <div className="flash ok" role="status"><AutoRefresh every={4000} />{status.message}</div> : null}
          {status.status === "fout" ? <div className="flash err">{status.message}</div> : null}
          {status.status === "ok" ? <div className="small muted">{status.message} · {status.at?.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}</div> : null}
          <div className="small muted">Haalt contacten, verkoopfacturen (met PDF), inkoopfacturen, bonnen, memoriaalboekingen, overige documenten (met bijlagen) en grootboekrapporten op. Moneybird staat 150 verzoeken per 5 minuten toe, dus bij veel documenten duurt dit even. Het loopt op de achtergrond en gaat na een onderbreking vanzelf verder.</div>
          <form action={mbFetchAction}><button className="btn pri" type="submit" disabled={!hasToken || busy}><Icon name="down" />{fetched ? "Opnieuw ophalen (alleen wijzigingen)" : "Alles ophalen"}</button></form>
          {counts.length ? (
            <table className="t">
              <thead><tr><th>Soort</th><th className="r">Aantal</th><th className="r hide-sm">Periode</th><th className="r">Bestanden</th></tr></thead>
              <tbody>
                {DOC_KINDS.map((k) => {
                  const c = counts.find((x) => x.kind === k.kind);
                  return c ? <tr key={k.kind}><td>{k.label}</td><td className="r num">{c.n}</td><td className="r small muted hide-sm">{c.first ? `${fmtDate(c.first)} – ${fmtDate(c.last)}` : ""}</td><td className="r num">{c.stored}/{c.files}</td></tr> : null;
                })}
              </tbody>
            </table>
          ) : null}
          {fetched ? <Link href="/moneybird/archief" className="btn sm" style={{ alignSelf: "flex-start" }}><Icon name="book" />Archief bekijken en downloaden</Link> : null}
        </div>
      </section>

      {plan ? (
        <>
          <section className="card" id="koppeling" style={{ marginBottom: 18 }}>
            <div className="ch"><h2>2. Koppelen</h2>{unmapped ? <Pill tone="a">{unmapped} open</Pill> : <Pill tone="g">Compleet</Pill>}</div>
            <div className="cb stack">
              <div className="small muted">Welke FreeBird-rekening en BTW-code hoort bij elke Moneybird-rekening en elk tarief? Alleen wat de overname gebruikt staat hier.</div>
              {ai && unmapped ? <form action={mbSuggestMapping}><button className="btn sm" type="submit"><Icon name="spark" />AI laten koppelen</button></form> : null}
              <form action={mbSaveMapping} className="stack">
                {plan.neededLedger.length ? (
                  <table className="t">
                    <thead><tr><th>Moneybird-rekening</th><th>FreeBird</th></tr></thead>
                    <tbody>
                      {plan.neededLedger.map((l) => (
                        <tr key={l.id}>
                          <td><div style={{ fontWeight: 600 }}>{l.name}</div><div className="small muted">{TYPE_LABEL[l.type] ?? l.type}</div></td>
                          <td>
                            <select name={`ledger_${l.id}`} defaultValue={l.code ?? ""} className="inp" aria-label={`FreeBird-rekening voor ${l.name}`} style={{ maxWidth: 260 }}>
                              <option value="">— kies —</option>
                              {["revenue", "direct_costs", "expenses", "other_income_expenses"].includes(l.type) ? <option value="new">Nieuwe rekening „{l.name}”</option> : null}
                              {accs.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {plan.neededTax.length ? (
                  <table className="t">
                    <thead><tr><th>Moneybird-BTW-tarief</th><th>FreeBird</th></tr></thead>
                    <tbody>
                      {plan.neededTax.map((t) => (
                        <tr key={t.id}>
                          <td><div style={{ fontWeight: 600 }}>{t.name}</div><div className="small muted">{t.percentage}% · {t.type === "sales_invoice" ? "verkoop" : t.type === "purchase_invoice" ? "inkoop" : t.type}</div></td>
                          <td>
                            <select name={`tax_${t.id}`} defaultValue={t.code ?? ""} className="inp" aria-label={`BTW-code voor ${t.name}`} style={{ maxWidth: 260 }}>
                              <option value="">— kies —</option>
                              {codes.filter((c) => c.code !== "OSS" && (t.type === "sales_invoice" ? c.direction === "sale" : t.type === "purchase_invoice" ? c.direction === "purchase" : true)).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <button className="btn pri" type="submit" style={{ alignSelf: "flex-start" }}>Koppeling opslaan</button>
              </form>
            </div>
          </section>

          <section className="card" id="overnemen" style={{ marginBottom: 18 }}>
            <div className="ch"><h2>3. Controleren en overnemen</h2>{done ? <Pill tone="g">Overgenomen</Pill> : null}</div>
            <div className="cb stack">
              {plan.warnings.map((w, i) => <div key={i} className="box warn small">{w}</div>)}
              <div className="small">Startdatum van FreeBird: <strong>{fmtDate(plan.start)}</strong> (<Link href="/instellingen#algemeen">wijzigen</Link>).</div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {plan.canTakeYear ? <li>Beginsaldo per 1 januari {plan.year} en {plan.months.length} maandtotaal/-totalen tot de startdatum, zodat het jaaroverzicht {plan.year} compleet is</li> : <li>Beginsaldo per {fmtDate(plan.start)}</li>}
                <li>{plan.openSales} verkoopfactu(u)r(en) en {plan.openPurchases} inkoopdocument(en) die op de startdatum nog openstonden (zonder nieuwe boeking: ze zitten al in het saldo debiteuren/crediteuren)</li>
                <li>Vanaf de startdatum: {plan.salesFromStart} verkoopfactu(u)r(en) met hun originele nummer, {plan.purchasesFromStart} inkoopdocument(en) en {plan.journalsFromStart} memoriaalboeking(en)</li>
                <li>Inkoop die je in FreeBird al direct via de bank hebt geboekt, wordt alleen als bewijs gekoppeld (niet dubbel)</li>
                <li>Overgenomen facturen krijgen geen automatische herinneringen</li>
              </ul>
              {plan.balanceAtStart.length ? (
                <details className="more">
                  <summary>Balans op de startdatum volgens Moneybird (vergelijk met de balans in Moneybird)</summary>
                  <table className="t" style={{ marginTop: 8 }}>
                    <tbody>
                      {plan.balanceAtStart.map((b, i) => (
                        <tr key={i}><td>{b.code ? <span className="num">{b.code}</span> : <Pill tone="a">niet gekoppeld</Pill>} {b.label}</td><td className="r num">{formatEur(b.cents)}</td><td className="small muted">{b.cents >= 0 ? "debet" : "credit"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
              {done ? (
                <form action={mbUndo} className="box plain stack">
                  <div className="t">Opnieuw doen?</div>
                  <div className="small">Ongedaan maken verwijdert alle boekingen, facturen en bonnen van de overname. Het archief blijft. Kan alleen zolang er geen betalingen aan gekoppeld zijn en je in FreeBird nog geen aangifte hebt vergrendeld.</div>
                  <label className="check small"><input type="checkbox" name="confirm" /> Ja, maak de overname ongedaan</label>
                  <button className="btn sm" type="submit"><Icon name="undo" />Ongedaan maken</button>
                </form>
              ) : (
                <form action={mbRunOvername} className="stack">
                  {plan.canTakeYear ? <label className="check small"><input type="checkbox" name="takeYear" defaultChecked /> Neem {plan.year} vanaf 1 januari over (aanbevolen)</label> : null}
                  {plan.quartersBefore.length ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <div className="small" style={{ fontWeight: 600 }}>BTW-aangiftes die je al vanuit Moneybird hebt gedaan (worden vergrendeld):</div>
                      {plan.quartersBefore.map((q) => <label key={q} className="check small"><input type="checkbox" name="quarters" value={q} defaultChecked /> Q{q.split("-")[1]} {q.split("-")[0]}</label>)}
                    </div>
                  ) : null}
                  <label className="check small"><input type="checkbox" name="confirm" /> Ik heb de balans en de koppeling gecontroleerd</label>
                  <button className="btn pri" type="submit" disabled={!!unmapped || busy} style={{ alignSelf: "flex-start" }}><Icon name="check" />Overnemen</button>
                  {unmapped ? <span className="small muted">Koppel eerst alle rekeningen en tarieven.</span> : null}
                </form>
              )}
            </div>
          </section>
        </>
      ) : hasToken && !busy ? <Empty>Haal eerst alles op uit Moneybird.</Empty> : null}
    </>
  );
}
