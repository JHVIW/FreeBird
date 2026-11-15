import Link from "next/link";
import { Top, Flash } from "@/components/ui";
import { InvoiceEditor } from "@/components/invoice-editor";
import { editorData } from "@/lib/editor-data";
import { saveInvoice, aiDraftInvoice } from "../../../actions/invoices";
import { aiConfigured } from "@/lib/ai";
import { Icon } from "@/components/icons";
import { today } from "@/lib/dates";
import { type SP, int } from "@/lib/sp";

export const metadata = { title: "Nieuwe factuur" };

export default async function NewInvoice({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [d, ai] = await Promise.all([editorData(), aiConfigured()]);
  return (
    <>
      <Top title="Nieuwe factuur" sub={<><Link href="/facturen">Facturen</Link> / nieuw · het nummer wordt toegekend bij definitief maken</>} />
      <Flash sp={sp} />
      {!d.contacts.length ? <div className="flash err">Je hebt nog geen klanten. <Link href="/klanten?new=1">Maak eerst een klant aan</Link>.</div> : null}
      {ai && d.contacts.length ? (
        <form action={aiDraftInvoice} className="card cb stack" style={{ marginBottom: 18 }}>
          <label htmlFor="ai-text" style={{ fontWeight: 600 }}>Snel een concept maken</label>
          <textarea id="ai-text" name="text" rows={2} className="inp" placeholder="bijv. 12 uur à €85 voor Bakkerij Jansen, website onderhoud september" />
          <div className="row"><button className="btn" type="submit"><Icon name="spark" />Maak concept</button><span className="small muted">Je controleert het concept voordat het definitief wordt.</span></div>
        </form>
      ) : null}
      <InvoiceEditor action={saveInvoice} {...d} initial={{ contactId: int(sp.klant), issueDate: today() }} />
    </>
  );
}
