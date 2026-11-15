import Link from "next/link";
import { and, asc, eq, ilike, or, sql as dsql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { contacts, invoices, accounts, vatCodes, journalLines, journalEntries, invoiceLayouts } from "@/db/schema";
import { contactLanguage } from "@/lib/i18n";
import { Top, Flash, Money, Pill, Tabs, Empty, INVOICE_STATUS } from "@/components/ui";
import { Icon } from "@/components/icons";
import { countryName, formatIban, COUNTRY_NAMES } from "@/lib/eu";
import { fmtDate, fmtDateShort, today } from "@/lib/dates";
import { type SP, str, int } from "@/lib/sp";
import { saveContact, checkViesAction, archiveContact, importMoneybird } from "../../actions/contacts";
import { getSetting } from "@/lib/settings";

export const metadata = { title: "Klanten" };

export default async function ContactsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tab = str(sp.tab) ?? "klanten";
  const q = str(sp.q) ?? "";
  const selId = int(sp.id);
  const editing = str(sp.edit) === "1" || str(sp.new) === "1";
  const year = Number(today().slice(0, 4));

  const conds: SQL[] = [eq(contacts.archived, false)];
  if (tab === "klanten") conds.push(eq(contacts.isCustomer, true));
  if (tab === "leveranciers") conds.push(eq(contacts.isSupplier, true));
  if (q) conds.push(or(ilike(contacts.name, `%${q}%`), ilike(contacts.email, `%${q}%`), ilike(contacts.vatNumber, `%${q}%`))!);

  // omzet dit jaar en openstaand per relatie
  const list = await db.select({
    c: contacts,
    revenue: dsql<string>`(select coalesce(-sum(jl.amount_cents),0) from ${journalLines} jl join ${journalEntries} je on je.id = jl.entry_id join ${accounts} a on a.id = jl.account_id where jl.contact_id = "contacts"."id" and a.type = 'revenue' and extract(year from je.date::date) = ${year})`,
    open: dsql<string>`(select coalesce(sum(i.total_cents - i.paid_cents),0) from ${invoices} i where i.contact_id = "contacts"."id" and i.status = 'open')`,
  }).from(contacts).where(and(...conds)).orderBy(asc(contacts.name)).limit(500);

  const sel = selId ? (await db.select().from(contacts).where(eq(contacts.id, selId)))[0] : undefined;
  const g = await getSetting("general");
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q, ...o })) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/klanten?${p}`;
  };

  return (
    <>
      <Top title="Klanten en leveranciers" sub={`${list.length} relaties`}>
        {g.moneybirdToken ? <form action={importMoneybird}><button className="btn" type="submit"><Icon name="down" />Importeer uit Moneybird</button></form> : null}
        <Link className="btn pri" href="/klanten?new=1"><Icon name="plus" />Nieuwe relatie</Link>
      </Top>
      <Flash sp={sp} />
      <div className="split">
        <section className="card">
          <div className="ch">
            <Tabs items={[["klanten", "Klanten"], ["leveranciers", "Leveranciers"], ["alle", "Alle"]].map(([v, l]) => ({ href: qs({ tab: v }), label: l, on: tab === v }))} />
            <form action="/klanten" className="row"><input type="hidden" name="tab" value={tab} /><input className="inp" name="q" defaultValue={q} placeholder="Zoek naam, e-mail of BTW" aria-label="Zoeken" style={{ width: 240 }} /></form>
          </div>
          {list.length ? (
            <table className="t">
              <thead><tr><th>Naam</th><th className="hide-sm">Land</th><th className="r">Omzet {year}</th><th className="r">Open</th></tr></thead>
              <tbody>
                {list.map(({ c, revenue, open }) => (
                  <tr key={c.id} className={`click ${sel?.id === c.id ? "sel" : ""}`}>
                    <td><Link className="rowlink" href={qs({ id: c.id })}><div style={{ fontWeight: 600 }}>{c.name}</div><div className="small muted">{c.kind === "consumer" ? "Particulier" : "Bedrijf"}{c.vatNumber ? ` · ${c.vatNumber}` : ""}</div></Link></td>
                    <td className="muted hide-sm">{c.country}</td>
                    <td className="r"><Money cents={Number(revenue)} /></td>
                    <td className="r"><Money cents={Number(open)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Geen relaties gevonden.</Empty>}
        </section>
        {editing ? <ContactForm c={str(sp.new) === "1" ? undefined : sel} /> : sel ? <ContactDetail c={sel} /> : <aside className="card"><Empty>Kies een relatie of maak een nieuwe aan.</Empty></aside>}
      </div>
    </>
  );
}

async function ContactDetail({ c }: { c: typeof contacts.$inferSelect }) {
  const invs = await db.select().from(invoices).where(eq(invoices.contactId, c.id)).orderBy(dsql`${invoices.number} desc nulls first`).limit(12);
  return (
    <aside className="card sticky">
      <div className="ch">
        <div><h2>{c.name}</h2><div className="small muted">{c.kind === "consumer" ? "Particulier" : "Bedrijf"} · {countryName(c.country)}</div></div>
        <div className="row"><Link className="btn sm" href={`/klanten?id=${c.id}&edit=1`}>Bewerken</Link>{c.isCustomer ? <Link className="btn sm pri" href={`/facturen/nieuw?klant=${c.id}`}>Factuur</Link> : null}</div>
      </div>
      <div className="cb stack">
        <dl className="kv">
          {c.contactPerson ? <><dt>Contactpersoon</dt><dd>{c.contactPerson}</dd></> : null}
          <dt>Adres</dt><dd>{[c.address, [c.postcode, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "—"}</dd>
          <dt>BTW-nummer</dt><dd className="num">{c.vatNumber ?? "—"}</dd>
          {c.vatNumber ? <><dt>VIES</dt><dd>
            {c.viesValid === true ? <Pill tone="g">Geldig · {fmtDate(c.viesCheckedAt?.toISOString().slice(0, 10))}</Pill> : c.viesValid === false ? <Pill tone="r">Ongeldig</Pill> : <Pill tone="a">Niet gecontroleerd</Pill>}
            <form action={checkViesAction} style={{ display: "inline", marginLeft: 8 }}><input type="hidden" name="rowId" value={c.id} /><button className="linkbtn small" type="submit">Controleer nu</button></form>
            {c.viesName ? <div className="small muted">{c.viesName}</div> : null}
          </dd></> : null}
          <dt>KvK</dt><dd>{c.kvk ?? "—"}</dd>
          <dt>E-mail</dt><dd>{c.email ?? "—"}</dd>
          {c.invoiceEmail ? <><dt>Factuur-e-mail</dt><dd>{c.invoiceEmail}</dd></> : null}
          <dt>Betaaltermijn</dt><dd>{c.paymentTermDays ? `${c.paymentTermDays} dagen` : "Standaard"}</dd>
          <dt>Taal facturen</dt><dd>{contactLanguage(c) === "en" ? "Engels" : "Nederlands"}{c.language ? "" : <span className="muted"> (automatisch op land)</span>}</dd>
          <dt>Standaard BTW</dt><dd>{c.defaultVatCode ?? "Automatisch"}</dd>
          <dt>IBAN&apos;s</dt><dd>{c.ibans.length ? c.ibans.map((i) => <div key={i} className="num small">{formatIban(i)}</div>) : <span className="muted">Worden geleerd bij koppelen</span>}</dd>
          {c.notes ? <><dt>Notities</dt><dd style={{ whiteSpace: "pre-line" }}>{c.notes}</dd></> : null}
        </dl>
        {invs.length ? (
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>Facturen</div>
            {invs.map((i) => <div key={i.id} className="spread small" style={{ padding: "4px 0" }}><Link href={`/facturen/${i.id}`} className="num">{i.number ?? "concept"}</Link><span className="muted">{fmtDateShort(i.issueDate)}</span><Money cents={i.totalCents} /><Pill tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Pill></div>)}
          </div>
        ) : null}
        <form action={archiveContact}><input type="hidden" name="rowId" value={c.id} /><button className="linkbtn small" type="submit">Archiveren</button></form>
      </div>
    </aside>
  );
}

async function ContactForm({ c }: { c?: typeof contacts.$inferSelect }) {
  const [accs, codes, layouts] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.type, "revenue")).orderBy(asc(accounts.code)),
    db.select().from(vatCodes).where(eq(vatCodes.direction, "sale")),
    db.select().from(invoiceLayouts).orderBy(asc(invoiceLayouts.name)),
  ]);
  return (
    <form action={saveContact} className="card sticky">
      {c ? <input type="hidden" name="rowId" value={c.id} /> : null}
      <div className="ch"><h2>{c ? "Relatie bewerken" : "Nieuwe relatie"}</h2><Link className="btn sm" href={c ? `/klanten?id=${c.id}` : "/klanten"}>Annuleren</Link></div>
      <div className="cb stack">
        <div className="field"><label htmlFor="name">Naam</label><input id="name" name="name" required defaultValue={c?.name} /></div>
        <div className="grid2">
          <div className="field"><label htmlFor="kind">Soort</label><select id="kind" name="kind" defaultValue={c?.kind ?? "business"}><option value="business">Bedrijf</option><option value="consumer">Particulier</option></select></div>
          <div className="field"><label htmlFor="country">Land</label>
            <select id="country" name="country" defaultValue={c?.country ?? "NL"}>{Object.entries(COUNTRY_NAMES).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
        </div>
        <div className="row"><label className="check"><input type="checkbox" name="isCustomer" defaultChecked={c?.isCustomer ?? true} /> Klant</label><label className="check"><input type="checkbox" name="isSupplier" defaultChecked={c?.isSupplier ?? false} /> Leverancier</label></div>
        <div className="field"><label htmlFor="contactPerson">Contactpersoon</label><input id="contactPerson" name="contactPerson" defaultValue={c?.contactPerson ?? ""} /></div>
        <div className="field"><label htmlFor="address">Adres</label><input id="address" name="address" defaultValue={c?.address ?? ""} /></div>
        <div className="grid2">
          <div className="field"><label htmlFor="postcode">Postcode</label><input id="postcode" name="postcode" defaultValue={c?.postcode ?? ""} /></div>
          <div className="field"><label htmlFor="city">Plaats</label><input id="city" name="city" defaultValue={c?.city ?? ""} /></div>
        </div>
        <div className="grid2">
          <div className="field"><label htmlFor="vatNumber">BTW-nummer</label><input id="vatNumber" name="vatNumber" defaultValue={c?.vatNumber ?? ""} placeholder="DE123456789" /><span className="hint">Wordt bij opslaan in VIES gecontroleerd</span></div>
          <div className="field"><label htmlFor="kvk">KvK</label><input id="kvk" name="kvk" defaultValue={c?.kvk ?? ""} /></div>
        </div>
        <div className="grid2">
          <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" defaultValue={c?.email ?? ""} /></div>
          <div className="field"><label htmlFor="invoiceEmail">Factuur-e-mail</label><input id="invoiceEmail" name="invoiceEmail" type="email" defaultValue={c?.invoiceEmail ?? ""} /></div>
        </div>
        <div className="grid2">
          <div className="field"><label htmlFor="language">Taal van facturen en mails</label>
            <select id="language" name="language" defaultValue={c?.language ?? ""}><option value="">Automatisch (NL in Nederland, anders Engels)</option><option value="nl">Nederlands</option><option value="en">Engels</option></select>
          </div>
          <div className="field"><label htmlFor="layoutId">Opmaak</label>
            <select id="layoutId" name="layoutId" defaultValue={c?.layoutId ?? ""}><option value="">Standaard</option>{layouts.filter((l) => !l.isDefault).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </div>
        </div>
        <div className="field"><label htmlFor="ibans">IBAN&apos;s (komma-gescheiden)</label><input id="ibans" name="ibans" defaultValue={c?.ibans.join(", ") ?? ""} /></div>
        <div className="grid3">
          <div className="field"><label htmlFor="paymentTermDays">Termijn</label><input id="paymentTermDays" name="paymentTermDays" type="number" min={0} defaultValue={c?.paymentTermDays ?? ""} placeholder="standaard" /></div>
          <div className="field"><label htmlFor="defaultVatCode">Standaard BTW</label><select id="defaultVatCode" name="defaultVatCode" defaultValue={c?.defaultVatCode ?? ""}><option value="">Automatisch</option>{codes.map((v) => <option key={v.code} value={v.code}>{v.name}</option>)}</select></div>
          <div className="field"><label htmlFor="defaultAccountCode">Omzetrekening</label><select id="defaultAccountCode" name="defaultAccountCode" defaultValue={c?.defaultAccountCode ?? ""}><option value="">Automatisch</option>{accs.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></div>
        </div>
        <div className="field"><label htmlFor="notes">Notities</label><textarea id="notes" name="notes" defaultValue={c?.notes ?? ""} /></div>
        <button className="btn pri" type="submit">Opslaan</button>
      </div>
    </form>
  );
}
