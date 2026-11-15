import { Fragment } from "react";
import { asc, between, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { journalEntries, journalLines, accounts } from "@/db/schema";
import { Top, Flash, Money, Empty } from "@/components/ui";
import { fmtDate, today } from "@/lib/dates";
import { type SP, str } from "@/lib/sp";
import { addMemorial, reverseMemorial } from "../../actions/year";

export const metadata = { title: "Journaal" };

const SOURCE: Record<string, string> = {
  invoice: "Factuur", bank: "Bank", receipt: "Inkoop", memorial: "Memoriaal", vat_close: "BTW-afsluiting", depreciation: "Afschrijving", opening: "Beginbalans", sale: "Verkoop",
};

export default async function JournalPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const month = str(sp.m) ?? today().slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const entries = await db.select().from(journalEntries).where(between(journalEntries.date, from, to)).orderBy(desc(journalEntries.date), desc(journalEntries.id));
  const lines = entries.length ? await db.select({ l: journalLines, code: accounts.code, name: accounts.name }).from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId)).where(inArray(journalLines.entryId, entries.map((e) => e.id))).orderBy(asc(journalLines.id)) : [];
  const accs = await db.select().from(accounts).where(eq(accounts.active, true)).orderBy(asc(accounts.code));
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);

  return (
    <>
      <Top title="Journaal" sub={`Alle boekingen in ${fmtDate(from).slice(2)}`}>
        <a className="btn" href={`/journaal?m=${prev}`}>← Vorige maand</a>
        <a className="btn" href={`/journaal?m=${next}`}>Volgende maand →</a>
      </Top>
      <Flash sp={sp} />
      <div className="split">
        <section className="card">
          {entries.length ? (
            <table className="t">
              <thead><tr><th>Datum</th><th>Boeking</th><th className="r">Debet</th><th className="r">Credit</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr style={{ background: "var(--soft)" }}>
                      <td className="muted">{fmtDate(e.date)}</td>
                      <td colSpan={3}><span style={{ fontWeight: 600 }}>#{e.id} {e.description}</span> <span className="small muted">· {SOURCE[e.sourceType] ?? e.sourceType}{e.reversalOf ? ` · tegenboeking van #${e.reversalOf}` : ""}</span>
                        {e.sourceType === "memorial" || e.sourceType === "opening" ? (
                          <form action={reverseMemorial} style={{ display: "inline", marginLeft: 8 }}><input type="hidden" name="rowId" value={e.id} /><button className="linkbtn small" type="submit">tegenboeken</button></form>
                        ) : null}
                      </td>
                    </tr>
                    {lines.filter((x) => x.l.entryId === e.id).map(({ l, code, name }) => (
                      <tr key={`l${l.id}`}><td /><td className="small">{code} {name}{l.memo ? <span className="muted"> · {l.memo}</span> : null}</td>
                        <td className="r small">{l.amountCents > 0 ? <Money cents={l.amountCents} /> : null}</td><td className="r small">{l.amountCents < 0 ? <Money cents={-l.amountCents} /> : null}</td></tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : <Empty>Geen boekingen in deze maand.</Empty>}
        </section>
        <form action={addMemorial} className="card sticky">
          <div className="ch"><h2>Memoriaalboeking</h2></div>
          <div className="cb stack">
            <div className="grid2">
              <div className="field"><label htmlFor="md">Datum</label><input id="md" name="date" type="date" defaultValue={today()} required /></div>
              <div className="field"><label htmlFor="mk">Soort</label><select id="mk" name="kind"><option value="memorial">Memoriaal</option><option value="opening">Beginbalans</option></select></div>
            </div>
            <div className="field"><label htmlFor="mdesc">Omschrijving</label><input id="mdesc" name="description" required /></div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px 90px", gap: 6 }}>
                <select name={`acc${i}`} className="inp" aria-label={`Rekening ${i + 1}`}><option value="">Rekening…</option>{accs.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
                <input name={`d${i}`} className="inp num" placeholder="Debet" aria-label={`Debet ${i + 1}`} inputMode="decimal" />
                <input name={`c${i}`} className="inp num" placeholder="Credit" aria-label={`Credit ${i + 1}`} inputMode="decimal" />
              </div>
            ))}
            <div className="small muted">Debet en credit moeten gelijk zijn. Beginbalans: bank debet, ondernemingsvermogen credit, op de startdatum.</div>
            <button className="btn pri" type="submit">Boeken</button>
          </div>
        </form>
      </div>
    </>
  );
}
