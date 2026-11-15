import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { recurringInvoices, contacts } from "@/db/schema";
import { Top, Flash, Pill, Money, Empty } from "@/components/ui";
import { InvoiceEditor } from "@/components/invoice-editor";
import { editorData } from "@/lib/editor-data";
import { saveRecurring, toggleRecurring } from "../../../actions/invoices";
import { fmtDate, today } from "@/lib/dates";
import { lineBase } from "@/lib/money";
import type { LineInput } from "@/lib/invoices";
import type { SP } from "@/lib/sp";

export const metadata = { title: "Terugkerende facturen" };

export default async function RecurringPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const rows = await db.select({ r: recurringInvoices, name: contacts.name }).from(recurringInvoices).innerJoin(contacts, eq(contacts.id, recurringInvoices.contactId)).orderBy(asc(recurringInvoices.nextDate));
  const d = await editorData();
  const every = (m: number) => (m === 1 ? "maandelijks" : m === 3 ? "per kwartaal" : m === 12 ? "jaarlijks" : `elke ${m} maanden`);
  return (
    <>
      <Top title="Terugkerende facturen" sub={<><Link href="/facturen">Facturen</Link> / schema&apos;s · de worker maakt ze elke ochtend aan</>} />
      <Flash sp={sp} />
      <div className="split even">
        <section className="card">
          <div className="ch"><h2>Schema&apos;s</h2></div>
          {rows.length ? (
            <table className="t"><tbody>
              {rows.map(({ r, name }) => (
                <tr key={r.id}>
                  <td><div style={{ fontWeight: 600 }}>{r.description}</div><div className="small muted">{name} · {every(r.intervalMonths)} · volgende {fmtDate(r.nextDate)}{r.autoSend ? " · automatisch versturen" : ""}</div></td>
                  <td className="r"><Money cents={(r.lines as LineInput[]).reduce((s, l) => s + lineBase(l.quantity, l.unitPriceCents), 0)} /><div className="small muted">excl. BTW</div></td>
                  <td className="r"><form action={toggleRecurring}><input type="hidden" name="rowId" value={r.id} /><button type="submit" className="btn sm">{r.active ? <Pill tone="g">Actief</Pill> : <Pill>Gepauzeerd</Pill>}</button></form></td>
                </tr>
              ))}
            </tbody></table>
          ) : <Empty>Nog geen terugkerende facturen.</Empty>}
        </section>
        <section>
          <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Nieuw schema</h2>
          <InvoiceEditor action={saveRecurring} mode="recurring" {...d} initial={{ issueDate: today() }} />
        </section>
      </div>
    </>
  );
}
