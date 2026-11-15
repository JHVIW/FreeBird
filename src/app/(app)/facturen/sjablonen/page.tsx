import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoiceLayouts, invoiceTemplates, emailTemplates, contacts } from "@/db/schema";
import { Top, Flash, Pill, Money, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { lineBase } from "@/lib/money";
import { MAIL_VARS_HELP } from "@/lib/i18n";
import type { LineInput } from "@/lib/invoices";
import { type SP, int } from "@/lib/sp";
import {
  saveLayout, deleteLayout, saveEmailTemplate, deleteEmailTemplate, deleteInvoiceTemplate, renameInvoiceTemplate, invoiceFromTemplate,
} from "../../../actions/templates";

export const metadata = { title: "Sjablonen" };

const STYLES = [
  { v: "klassiek", l: "Klassiek: zwart-wit, rustig" },
  { v: "modern", l: "Modern: gekleurde kopbalk" },
  { v: "compact", l: "Compact: kleiner, accentlijn" },
];
const FONTS = [{ v: "Helvetica", l: "Helvetica" }, { v: "Times-Roman", l: "Times" }, { v: "Courier", l: "Courier" }];
const KIND: Record<string, string> = { invoice: "Factuur", reminder: "Herinnering", credit: "Creditnota" };

export default async function TemplatesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [layouts, tpls, mails, cs] = await Promise.all([
    db.select().from(invoiceLayouts).orderBy(desc(invoiceLayouts.isDefault), asc(invoiceLayouts.name)),
    db.select().from(invoiceTemplates).orderBy(asc(invoiceTemplates.name)),
    db.select().from(emailTemplates).orderBy(asc(emailTemplates.kind), asc(emailTemplates.language), desc(emailTemplates.isDefault)),
    db.select().from(contacts).where(eq(contacts.isCustomer, true)).orderBy(asc(contacts.name)),
  ]);
  const layoutId = int(sp.layout) ?? layouts[0]?.id;
  const sel = sp.layout === "new" ? undefined : layouts.find((l) => l.id === layoutId);
  const mailId = int(sp.mail);
  const selMail = sp.mail === "new" ? undefined : mails.find((m) => m.id === mailId);
  const editingMail = sp.mail === "new" || !!selMail;

  return (
    <>
      <Top title="Sjablonen" sub={<><Link href="/facturen">Facturen</Link> / opmaak, factuurinhoud en mailteksten</>} />
      <Flash sp={sp} />

      <h2 id="opmaak" style={{ fontSize: 17, margin: "8px 0 12px" }}>Opmaak</h2>
      <div className="split even" style={{ marginBottom: 32 }}>
        <div className="stack">
          <section className="card">
            <div className="ch"><h2>Opmaken</h2><Link className="btn sm" href="/facturen/sjablonen?layout=new#opmaak"><Icon name="plus" />Nieuwe opmaak</Link></div>
            <table className="t"><tbody>
              {layouts.map((l) => (
                <tr key={l.id} className={`click ${sel?.id === l.id ? "sel" : ""}`}>
                  <td><Link className="rowlink" href={`/facturen/sjablonen?layout=${l.id}#opmaak`}>
                    <div className="row" style={{ gap: 8 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: l.accentColor, display: "inline-block" }} /><span style={{ fontWeight: 600 }}>{l.name}</span>{l.isDefault ? <Pill tone="g">Standaard</Pill> : null}</div>
                    <div className="small muted">{STYLES.find((s) => s.v === l.style)?.l} · {l.font}{l.logoFileId ? " · met logo" : ""}</div>
                  </Link></td>
                  <td className="r"><a className="btn sm" href={`/api/layouts/${l.id}/preview?lang=nl`} target="_blank" rel="noreferrer">NL</a> <a className="btn sm" href={`/api/layouts/${l.id}/preview?lang=en`} target="_blank" rel="noreferrer">EN</a></td>
                </tr>
              ))}
            </tbody></table>
          </section>
          <form action={saveLayout} className="card">
            {sel ? <input type="hidden" name="rowId" value={sel.id} /> : null}
            <div className="ch"><h2>{sel ? `Opmaak bewerken: ${sel.name}` : "Nieuwe opmaak"}</h2></div>
            <div className="cb stack">
              <div className="field"><label htmlFor="l-name">Naam</label><input id="l-name" name="name" required defaultValue={sel?.name ?? ""} /></div>
              <div className="grid3">
                <div className="field"><label htmlFor="l-style">Stijl</label><select id="l-style" name="style" defaultValue={sel?.style ?? "klassiek"}>{STYLES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select></div>
                <div className="field"><label htmlFor="l-font">Lettertype</label><select id="l-font" name="font" defaultValue={sel?.font ?? "Helvetica"}>{FONTS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select></div>
                <div className="field"><label htmlFor="l-color">Accentkleur</label><input id="l-color" name="accentColor" type="color" defaultValue={sel?.accentColor ?? "#1E6B47"} style={{ padding: 4 }} /></div>
              </div>
              <div className="field"><label htmlFor="l-logo">Logo (PNG of JPG, max 2 MB)</label><input id="l-logo" name="logo" type="file" accept="image/png,image/jpeg" /></div>
              {sel?.logoFileId ? (
                <div className="row"><img src={`/api/files/${sel.logoFileId}`} alt="Huidig logo" style={{ maxHeight: 40, maxWidth: 160, objectFit: "contain" }} /><label className="check small"><input type="checkbox" name="removeLogo" /> Logo verwijderen</label></div>
              ) : null}
              <div className="grid2">
                <div className="field"><label htmlFor="l-fnl">Voettekst NL</label><input id="l-fnl" name="footerNl" defaultValue={sel?.footerNl ?? ""} placeholder="Leeg = bedrijfsgegevens" /></div>
                <div className="field"><label htmlFor="l-fen">Voettekst EN</label><input id="l-fen" name="footerEn" defaultValue={sel?.footerEn ?? ""} placeholder="Empty = company details" /></div>
              </div>
              <label className="check"><input type="checkbox" name="showPaymentBox" defaultChecked={sel?.showPaymentBox ?? true} /> Blok &quot;Direct betalen&quot; met bunq.me-link tonen</label>
              <label className="check"><input type="checkbox" name="isDefault" defaultChecked={sel?.isDefault ?? false} /> Standaardopmaak</label>
              <div className="row">
                <button className="btn pri" type="submit">Opslaan</button>
                {sel && !sel.isDefault ? <button className="btn danger" type="submit" formAction={deleteLayout}>Verwijderen</button> : null}
              </div>
              <div className="small muted">Een opmaak kies je per klant (Klanten › Bewerken) of per factuur. Facturen die al verstuurd zijn houden hun PDF.</div>
            </div>
          </form>
        </div>
        <section className="card sticky" style={{ overflow: "hidden" }}>
          <div className="ch"><h2>Voorbeeld</h2><span className="small muted">Sla op om te verversen</span></div>
          {sel ? <iframe className="pdf-frame" style={{ border: 0, borderRadius: 0, height: 760 }} src={`/api/layouts/${sel.id}/preview?lang=nl&v=${encodeURIComponent(JSON.stringify([sel.style, sel.accentColor, sel.font, sel.logoFileId, sel.footerNl]))}`} title="Voorbeeld van de opmaak" />
            : <Empty>Sla de opmaak op om een voorbeeld te zien.</Empty>}
        </section>
      </div>

      <h2 id="inhoud" style={{ fontSize: 17, margin: "8px 0 12px" }}>Factuurinhoud</h2>
      <section className="card" style={{ marginBottom: 32 }}>
        <div className="ch"><h2>Opgeslagen facturen</h2><span className="small muted">Maak een sjabloon in de factuureditor met &quot;Opslaan als sjabloon&quot;</span></div>
        {tpls.length ? (
          <table className="t">
            <thead><tr><th>Naam</th><th className="hide-sm">Regels</th><th className="r">Excl. BTW</th><th>Nieuwe factuur voor</th><th /></tr></thead>
            <tbody>
              {tpls.map((tp) => {
                const lines = tp.lines as LineInput[];
                return (
                  <tr key={tp.id}>
                    <td>
                      <form action={renameInvoiceTemplate} className="row" style={{ gap: 6 }}>
                        <input type="hidden" name="rowId" value={tp.id} />
                        <input name="name" defaultValue={tp.name} className="inp" aria-label="Naam sjabloon" style={{ minWidth: 160 }} />
                        <select name="language" defaultValue={tp.language ?? ""} className="inp" aria-label="Taal" style={{ width: 90 }}><option value="">Alle</option><option value="nl">NL</option><option value="en">EN</option></select>
                        <button className="btn sm" type="submit">Opslaan</button>
                      </form>
                    </td>
                    <td className="small muted hide-sm">{lines.map((l) => l.description).join(", ").slice(0, 90)}</td>
                    <td className="r"><Money cents={lines.reduce((s, l) => s + lineBase(Number(l.quantity), Number(l.unitPriceCents)), 0)} /></td>
                    <td>
                      <form action={invoiceFromTemplate} className="row" style={{ gap: 6 }}>
                        <input type="hidden" name="rowId" value={tp.id} />
                        <select name="contactId" className="inp" aria-label="Klant" style={{ minWidth: 160 }} required><option value="">Kies klant…</option>{cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                        <button className="btn sm pri" type="submit">Maak</button>
                      </form>
                    </td>
                    <td className="r"><form action={deleteInvoiceTemplate}><input type="hidden" name="rowId" value={tp.id} /><button className="btn sm" type="submit" aria-label={`Sjabloon ${tp.name} verwijderen`}><Icon name="trash" /></button></form></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Empty>Nog geen sjablonen. Open een factuur, vul de regels in en kies &quot;Opslaan als sjabloon&quot;.</Empty>}
      </section>

      <h2 id="mail" style={{ fontSize: 17, margin: "8px 0 12px" }}>Mailteksten</h2>
      <div className="split even">
        <section className="card">
          <div className="ch"><h2>Teksten</h2><Link className="btn sm" href="/facturen/sjablonen?mail=new#mail"><Icon name="plus" />Nieuwe mailtekst</Link></div>
          <table className="t"><tbody>
            {mails.map((m) => (
              <tr key={m.id} className={`click ${selMail?.id === m.id ? "sel" : ""}`}>
                <td><Link className="rowlink" href={`/facturen/sjablonen?mail=${m.id}#mail`}><div style={{ fontWeight: 600 }}>{m.name}</div><div className="small muted">{m.subject}</div></Link></td>
                <td>{KIND[m.kind]}</td>
                <td><Pill tone="n">{m.language.toUpperCase()}</Pill></td>
                <td className="r">{m.isDefault ? <Pill tone="g">Standaard</Pill> : null}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
        {editingMail ? (
          <form action={saveEmailTemplate} className="card sticky">
            {selMail ? <input type="hidden" name="rowId" value={selMail.id} /> : null}
            <div className="ch"><h2>{selMail ? "Mailtekst bewerken" : "Nieuwe mailtekst"}</h2><Link className="btn sm" href="/facturen/sjablonen#mail">Sluiten</Link></div>
            <div className="cb stack">
              <div className="field"><label htmlFor="m-name">Naam</label><input id="m-name" name="name" required defaultValue={selMail?.name ?? ""} /></div>
              <div className="grid2">
                <div className="field"><label htmlFor="m-kind">Soort</label><select id="m-kind" name="kind" defaultValue={selMail?.kind ?? "invoice"}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field"><label htmlFor="m-lang">Taal</label><select id="m-lang" name="language" defaultValue={selMail?.language ?? "nl"}><option value="nl">Nederlands</option><option value="en">Engels</option></select></div>
              </div>
              <div className="field"><label htmlFor="m-subj">Onderwerp</label><input id="m-subj" name="subject" required defaultValue={selMail?.subject ?? ""} /></div>
              <div className="field"><label htmlFor="m-body">Tekst</label><textarea id="m-body" name="body" rows={10} required defaultValue={selMail?.body ?? ""} /></div>
              <div className="small muted">Variabelen: {MAIL_VARS_HELP}</div>
              <label className="check"><input type="checkbox" name="isDefault" defaultChecked={selMail?.isDefault ?? false} /> Standaard voor deze soort en taal (ook voor automatische herinneringen)</label>
              <div className="row">
                <button className="btn pri" type="submit">Opslaan</button>
                {selMail ? <button className="btn danger" type="submit" formAction={deleteEmailTemplate}>Verwijderen</button> : null}
              </div>
            </div>
          </form>
        ) : <aside className="card"><Empty>Kies een mailtekst om te bewerken.</Empty></aside>}
      </div>
    </>
  );
}
