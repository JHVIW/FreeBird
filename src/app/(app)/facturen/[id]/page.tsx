import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reconciliations, bankTransactions, invoices } from "@/db/schema";
import { Top, Flash, Money, Pill, INVOICE_STATUS } from "@/components/ui";
import { Icon } from "@/components/icons";
import { InvoiceEditor } from "@/components/invoice-editor";
import { editorData } from "@/lib/editor-data";
import { getInvoice, isOverdue } from "@/lib/invoices";
import { defaultEmail, mailKindFor } from "@/lib/invoice-delivery";
import { listEmailTemplates } from "@/lib/templates";
import { fmtDate, fmtDateShort } from "@/lib/dates";
import { formatEur, formatPct } from "@/lib/money";
import { type SP, str, int } from "@/lib/sp";
import { saveInvoice, sendInvoiceAction, creditInvoice, deleteInvoice, regenerate } from "../../../actions/invoices";

export const metadata = { title: "Factuur" };

const EVENT: Record<string, string> = {
  finalized: "Definitief gemaakt", sent: "Verstuurd", reminder: "Herinnering verstuurd", paid: "Betaald", payment: "Deelbetaling",
  bounced: "Mail kwam niet aan (bounce)", credited: "Gecrediteerd",
};

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id: idS } = await params;
  const sp = await searchParams;
  const id = Number(idS);
  const data = await getInvoice(id);
  if (!data) notFound();
  const { inv, lines, contact, events } = data;

  if (inv.status === "draft") {
    const d = await editorData();
    return (
      <>
        <Top title={inv.creditOf ? "Creditnota (concept)" : "Factuur (concept)"} sub={<><Link href="/facturen">Facturen</Link> / concept · wordt definitief met een doorlopend nummer</>}>
          <form action={deleteInvoice}><input type="hidden" name="rowId" value={id} /><button className="btn danger" type="submit"><Icon name="trash" />Concept verwijderen</button></form>
        </Top>
        <Flash sp={sp} />
        <InvoiceEditor action={saveInvoice} id={id} {...d} initial={{
          contactId: inv.contactId, issueDate: inv.issueDate ?? undefined, deliveryDate: inv.deliveryDate ?? undefined, reference: inv.reference ?? undefined, notes: inv.notes ?? undefined,
          language: inv.language === "en" ? "en" : "nl", layoutId: inv.layoutId,
          lines: lines.map((l) => ({ description: l.description, quantity: String(Number(l.quantity)).replace(".", ","), price: (l.unitPriceCents / 100).toFixed(2).replace(".", ","), vatCode: l.vatCode, accountCode: l.accountCode })),
        }} />
      </>
    );
  }

  const st = INVOICE_STATUS[inv.status];
  const late = isOverdue(inv);
  const payments = await db.select({ r: reconciliations, t: bankTransactions }).from(reconciliations)
    .innerJoin(bankTransactions, eq(bankTransactions.id, reconciliations.bankTransactionId))
    .where(and(eq(reconciliations.targetType, "invoice"), eq(reconciliations.targetId, id)));
  const creditNotes = await db.select().from(invoices).where(eq(invoices.creditOf, id));
  const showSend = str(sp.send) === "1" || str(sp.send) === "reminder";
  const mailKind = str(sp.send) === "reminder" ? "reminder" : "invoice";
  const mail = showSend ? await defaultEmail(id, mailKind, int(sp.tpl)) : null;
  const mailOptions = showSend ? await listEmailTemplates(mailKindFor(inv, mailKind), inv.language === "en" ? "en" : "nl") : [];
  const open = inv.totalCents - inv.paidCents;

  return (
    <>
      <Top title={`${inv.creditOf ? "Creditnota" : "Factuur"} ${inv.number}`} sub={<><Link href="/facturen">Facturen</Link> / {contact.name} · {fmtDate(inv.issueDate)}</>}>
        {inv.pdfFileId ? <a className="btn" href={`/api/files/${inv.pdfFileId}?download=1`}><Icon name="down" />PDF</a> : null}
        {inv.ublFileId ? <a className="btn" href={`/api/files/${inv.ublFileId}?download=1`}><Icon name="down" />UBL</a> : null}
        {inv.status === "open" && !inv.creditOf ? <form action={creditInvoice}><input type="hidden" name="rowId" value={id} /><button className="btn" type="submit">Crediteren</button></form> : null}
        {late ? <Link className="btn" href={`/facturen/${id}?send=reminder`}><Icon name="mail" />Herinnering</Link> : null}
        <Link className="btn pri" href={`/facturen/${id}?send=1`}><Icon name="send" />{inv.sentAt ? "Opnieuw versturen" : "Versturen"}</Link>
      </Top>
      <Flash sp={sp} />
      <div className="split">
        <section>
          {inv.pdfFileId ? <iframe className="pdf-frame" src={`/api/files/${inv.pdfFileId}`} title={`PDF van factuur ${inv.number}`} /> : (
            <div className="card cb stack">
              <div>De PDF is nog niet gemaakt.</div>
              <form action={regenerate}><input type="hidden" name="rowId" value={id} /><button className="btn" type="submit">PDF en UBL maken</button></form>
            </div>
          )}
        </section>
        <aside className="stack sticky">
          <section className="card">
            <div className="ch"><h2>Status</h2>{late ? <Pill tone="r">Te laat</Pill> : <Pill tone={st.tone}>{st.label}</Pill>}</div>
            <div className="cb">
              <dl className="kv">
                <dt>Totaal</dt><dd><Money cents={inv.totalCents} /></dd>
                <dt>Betaald</dt><dd><Money cents={inv.paidCents} /></dd>
                <dt>Open</dt><dd><Money cents={open} /></dd>
                <dt>Vervaldatum</dt><dd>{fmtDate(inv.dueDate)}</dd>
                <dt>Klant</dt><dd><Link href={`/klanten?id=${contact.id}`}>{contact.name}</Link></dd>
                <dt>Taal</dt><dd>{inv.language === "en" ? "Engels" : "Nederlands"}</dd>
                {inv.paymentUrl ? <><dt>Betaallink</dt><dd><a href={inv.paymentUrl} target="_blank" rel="noreferrer">{inv.paymentUrl.replace(/^https?:\/\//, "")}</a></dd></> : null}
              </dl>
            </div>
          </section>
          <section className="card">
            <div className="ch"><h2>Regels</h2></div>
            <table className="t"><tbody>
              {lines.map((l) => (
                <tr key={l.id}><td>{l.description}<div className="small muted">{Number(l.quantity)} × {formatEur(l.unitPriceCents)} · {l.vatCode} {formatPct(l.rateBp)} · {l.accountCode}</div></td><td className="r"><Money cents={l.baseCents} /></td></tr>
              ))}
              <tr className="total"><td>BTW</td><td className="r"><Money cents={inv.vatCents} /></td></tr>
            </tbody></table>
          </section>
          <section className="card">
            <div className="ch"><h2>Geschiedenis</h2></div>
            <div className="cb stack" style={{ gap: 8 }}>
              {events.map((e) => (
                <div key={e.id} className="spread small"><span>{EVENT[e.type] ?? e.type}{(e.meta as { to?: string } | null)?.to ? ` aan ${(e.meta as { to: string }).to}` : ""}</span><span className="muted">{e.at.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>
              ))}
              {payments.map(({ r, t }) => <div key={r.id} className="spread small"><Link href={`/bank?tx=${t.id}&filter=all`}>Betaling {fmtDateShort(t.date)} · {t.counterpartyName}</Link><Money cents={r.amountCents} /></div>)}
              {creditNotes.map((c) => <div key={c.id} className="small"><Link href={`/facturen/${c.id}`}>Creditnota {c.number ?? "(concept)"}</Link></div>)}
            </div>
          </section>
          <form action={regenerate} className="noprint"><input type="hidden" name="rowId" value={id} /><button className="linkbtn small" type="submit">PDF en UBL opnieuw maken</button></form>
        </aside>
      </div>

      {showSend && mail ? (
        <div className="dialog">
          <form action={sendInvoiceAction} className="card" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
            <input type="hidden" name="rowId" value={id} /><input type="hidden" name="kind" value={mailKind} />
            <div className="ch"><h2 id="dlg-t">{mailKind === "reminder" ? "Herinnering" : "Factuur"} {inv.number} versturen</h2><Link href={`/facturen/${id}`} className="btn sm" aria-label="Sluiten"><Icon name="x" /></Link></div>
            <div className="cb stack">
              {mailOptions.length > 1 ? (
                <div className="row wrap small"><span className="lbl">Mailtekst</span>
                  {mailOptions.map((m) => <Link key={m.id} href={`/facturen/${id}?send=${mailKind === "reminder" ? "reminder" : "1"}&tpl=${m.id}`} className={`pill ${m.id === mail.templateId ? "g" : "n"}`}>{m.name}</Link>)}
                </div>
              ) : null}
              <div className="field"><label htmlFor="to">Aan</label><input id="to" name="to" type="email" required defaultValue={mail.to} /></div>
              <div className="field"><label htmlFor="subject">Onderwerp</label><input key={`s${mail.templateId}`} id="subject" name="subject" defaultValue={mail.subject} /></div>
              <div className="field"><label htmlFor="body">Bericht</label><textarea key={`b${mail.templateId}`} id="body" name="body" rows={9} defaultValue={mail.body} /></div>
              <div className="row wrap small muted"><Pill>{inv.number}.pdf</Pill><Pill>{inv.number}.xml (UBL)</Pill><span>{mail.language === "en" ? "Engels" : "Nederlands"} · verstuurd vanaf je eigen adres via SMTP · <Link href="/facturen/sjablonen#mail">teksten beheren</Link></span></div>
            </div>
            <div className="row" style={{ justifyContent: "flex-end", padding: "0 20px 20px" }}>
              <Link className="btn" href={`/facturen/${id}`}>Annuleren</Link>
              <button className="btn pri" type="submit"><Icon name="send" />Versturen</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
