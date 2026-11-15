import Link from "next/link";
import { and, desc, eq, ilike, inArray, or, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { mbItems } from "@/db/schema";
import { Top, Money, Pill, Tabs, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { DOC_KINDS, KIND_LABEL, type MbFile } from "@/lib/moneybird-fetch";
import { fmtDateShort } from "@/lib/dates";
import { type SP, str, int } from "@/lib/sp";

export const metadata = { title: "Moneybird-archief" };

function importedLink(v: string | null) {
  if (!v) return null;
  const [k, id] = v.split(":");
  if (k === "invoice") return <Link href={`/facturen/${id}`}>factuur</Link>;
  if (k === "receipt") return <Link href={`/inkoop?tab=all&id=${id}`}>inkoop</Link>;
  if (k === "evidence") return <Link href={`/bank?filter=booked&tx=${id}`}>bewijs bij bank</Link>;
  if (k === "entry") return <Link href="/journaal">journaal</Link>;
  return <span className="muted">overgeslagen</span>;
}

export default async function ArchivePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const kind = str(sp.kind) ?? "sales_invoice";
  const q = str(sp.q) ?? "";
  const year = int(sp.y);
  const conds = [eq(mbItems.kind, kind)];
  if (q) conds.push(or(ilike(mbItems.number, `%${q}%`), ilike(mbItems.contactName, `%${q}%`))!);
  if (year) conds.push(dsql`extract(year from ${mbItems.date}) = ${year}`);
  const [rows, years] = await Promise.all([
    db.select().from(mbItems).where(and(...conds)).orderBy(desc(mbItems.date), desc(mbItems.id)).limit(500),
    db.selectDistinct({ y: dsql<number>`extract(year from ${mbItems.date})::int` }).from(mbItems).where(inArray(mbItems.kind, DOC_KINDS.map((k) => k.kind))),
  ]);
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ kind, q, y: year, ...o })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/moneybird/archief?${p}`;
  };
  return (
    <>
      <Top title="Moneybird-archief" sub={<><Link href="/moneybird">Moneybird</Link> / archief · alles wat uit Moneybird is opgehaald, voor de bewaarplicht van 7 jaar</>}>
        <a className="btn" href="/api/moneybird/archief"><Icon name="down" />Alles downloaden (ZIP)</a>
      </Top>
      <section className="card">
        <div className="ch">
          <Tabs items={DOC_KINDS.map((k) => ({ href: qs({ kind: k.kind }), label: k.label, on: kind === k.kind }))} />
          <form className="row" action="/moneybird/archief">
            <input type="hidden" name="kind" value={kind} />
            <select name="y" defaultValue={year ?? ""} className="inp" aria-label="Jaar" style={{ width: 100 }}>
              <option value="">Alle jaren</option>
              {years.map((y) => y.y).filter(Boolean).sort((a, b) => b - a).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <input name="q" defaultValue={q} placeholder="Zoek nummer of relatie" className="inp" aria-label="Zoeken" style={{ width: 200 }} />
            <button className="btn sm" type="submit">Zoek</button>
          </form>
        </div>
        {rows.length ? (
          <table className="t">
            <thead><tr><th>Datum</th><th>{KIND_LABEL[kind]}</th><th className="r">Bedrag</th><th className="hide-sm">Status</th><th>Bestanden</th><th className="hide-sm">In FreeBird</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{fmtDateShort(r.date)}</td>
                  <td><div style={{ fontWeight: 600 }}>{r.number ?? "—"}</div><div className="small muted">{r.contactName ?? ""}</div>{r.importNote ? <div className="small muted">{r.importNote}</div> : null}</td>
                  <td className="r"><Money cents={r.totalCents} /></td>
                  <td className="hide-sm">{r.state ? <Pill tone={r.state === "paid" ? "g" : r.state === "open" || r.state === "late" ? "a" : "n"}>{r.state}</Pill> : null}</td>
                  <td className="small">{(r.files as MbFile[]).map((f, i) => f.fileId ? <div key={i}><a href={`/api/files/${f.fileId}`} target="_blank" rel="noreferrer">{f.name}</a></div> : <div key={i} className="muted">{f.name}{f.error ? " (mislukt)" : " (nog niet opgehaald)"}</div>)}</td>
                  <td className="hide-sm small">{importedLink(r.importedAs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>Niets gevonden.</Empty>}
      </section>
    </>
  );
}
