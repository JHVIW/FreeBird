import Link from "next/link";
import { Top, Flash, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { aiConfigured } from "@/lib/ai";
import { recentQuestions } from "@/lib/ai-ask";
import type { SP } from "@/lib/sp";
import { askAction } from "../../actions/ask";

export const metadata = { title: "Vragen" };

const EXAMPLES = [
  "Wat heb ik in Q3 aan software uitgegeven?",
  "Welke klant betaalt gemiddeld het traagst?",
  "Wat is mijn omzet per maand dit jaar?",
  "Welke facturen staan nog open en hoe lang al?",
];

export default async function AskPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [ai, history] = await Promise.all([aiConfigured(), recentQuestions(10)]);
  return (
    <>
      <Top title="Vragen aan je boekhouding" sub="De AI zoekt het antwoord op in je administratie. Hij kan alleen lezen, nooit iets wijzigen." />
      <Flash sp={sp} />
      {!ai ? <div className="flash err">Er is nog geen DeepSeek API key. <Link href="/instellingen#algemeen">Stel hem in</Link>.</div> : (
        <form action={askAction} className="card cb stack" style={{ marginBottom: 18 }}>
          <label htmlFor="question" style={{ fontWeight: 600 }}>Je vraag</label>
          <textarea id="question" name="question" rows={2} className="inp" placeholder={EXAMPLES[0]} required />
          <div className="row wrap"><button className="btn pri" type="submit"><Icon name="chat" />Vraag</button><span className="small muted">Bijvoorbeeld: {EXAMPLES.slice(1).join(" · ")}</span></div>
        </form>
      )}
      {history.length ? history.map((h, i) => (
        <section key={i} className="card" style={{ marginBottom: 14 }}>
          <div className="ch"><h2>{h.question}</h2><span className="small muted">{new Date(h.at).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
          <div className="cb stack">
            <div style={{ whiteSpace: "pre-wrap" }}>{h.answer}</div>
            {h.rows.length ? (
              <details className="more">
                <summary>Gegevens ({h.rows.length} rij{h.rows.length === 1 ? "" : "en"})</summary>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table className="t">
                    <thead><tr>{h.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>{h.rows.slice(0, 20).map((r, j) => <tr key={j}>{h.columns.map((c) => <td key={c} className="small">{String(r[c] ?? "")}</td>)}</tr>)}</tbody>
                  </table>
                </div>
                {h.sql ? <pre className="small muted" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{h.sql}</pre> : null}
              </details>
            ) : null}
          </div>
        </section>
      )) : <Empty>Nog geen vragen gesteld.</Empty>}
    </>
  );
}
