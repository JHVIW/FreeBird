"use client";
import { useMemo, useState } from "react";
import { determineSaleVat } from "@/lib/vat-rules";
import { formatEur, parseEur, vatOf, lineBase } from "@/lib/money";
import { Icon } from "./icons";

export type EditorContact = {
  id: number; name: string; kind: "business" | "consumer"; country: string; vatNumber: string | null; viesValid: boolean | null;
  defaultAccountCode: string | null; defaultVatCode: string | null; paymentTermDays: number | null; language: "nl" | "en"; layoutId: number | null;
};
export type EditorTemplate = { id: number; name: string; language: string | null; reference: string | null; notes: string | null; lines: { description: string; quantity: number; unitPriceCents: number; accountCode?: string }[] };
export type EditorLine = { description: string; quantity: string; price: string; vatCode: string; accountCode: string };
type Option = { code: string; name: string; rateBp: number | null; kind?: string };

export function InvoiceEditor(props: {
  action: (fd: FormData) => Promise<void>;
  id?: number;
  contacts: EditorContact[];
  accounts: Option[];
  vatCodes: Option[];
  euRates: Record<string, number>;
  ossActive: boolean;
  defaultTerm: number;
  mode?: "invoice" | "recurring";
  layouts: { id: number; name: string; isDefault: boolean }[];
  templates: EditorTemplate[];
  initial?: { contactId?: number; issueDate?: string; deliveryDate?: string; reference?: string; notes?: string; paymentTermDays?: number | null; lines?: EditorLine[]; language?: "nl" | "en"; layoutId?: number | null };
}) {
  const init = props.initial ?? {};
  const [contactId, setContactId] = useState<number | "">(init.contactId ?? "");
  const contact = props.contacts.find((c) => c.id === contactId);
  const suggestion = useMemo(() => {
    if (!contact) return null;
    return determineSaleVat({ kind: contact.kind, country: contact.country, vatNumber: contact.vatNumber, viesValid: contact.viesValid }, "services", props.ossActive);
  }, [contact, props.ossActive]);
  const defVat = contact?.defaultVatCode ?? suggestion?.vatCode ?? "V21";
  const defAcc = contact?.defaultAccountCode ?? props.accounts.find((a) => a.code === "8000")?.code ?? props.accounts[0]?.code;
  const blank = (): EditorLine => ({ description: "", quantity: "1", price: "", vatCode: defVat, accountCode: defAcc ?? "8000" });
  const [lines, setLines] = useState<EditorLine[]>(init.lines?.length ? init.lines : [blank()]);
  const [language, setLanguage] = useState<"nl" | "en">(init.language ?? contact?.language ?? "nl");
  const [layoutId, setLayoutId] = useState<number | "">(init.layoutId ?? contact?.layoutId ?? "");
  const [reference, setReference] = useState(init.reference ?? "");
  const [notesText, setNotesText] = useState(init.notes ?? "");
  const [tplName, setTplName] = useState("");

  const insertTemplate = (id: string) => {
    const tp = props.templates.find((x) => String(x.id) === id);
    if (!tp) return;
    const fresh = tp.lines.map((l) => ({
      description: l.description, quantity: String(l.quantity).replace(".", ","), price: (l.unitPriceCents / 100).toFixed(2).replace(".", ","),
      vatCode: defVat, accountCode: l.accountCode ?? defAcc ?? "8000",
    }));
    setLines((ls) => [...ls.filter((l) => l.description.trim() || l.price.trim()), ...fresh]);
    if (!reference && tp.reference) setReference(tp.reference);
    if (!notesText && tp.notes) setNotesText(tp.notes);
    if (tp.language === "nl" || tp.language === "en") setLanguage(tp.language);
  };

  const rate = (code: string) => {
    const v = props.vatCodes.find((x) => x.code === code);
    if (!v) return 0;
    if (v.kind === "oss") return props.euRates[contact?.country ?? ""] ?? 0;
    return v.rateBp ?? 0;
  };
  const computed = lines.map((l) => {
    const q = Number(l.quantity.replace(",", ".")) || 0;
    const p = parseEur(l.price) ?? 0;
    const base = lineBase(q, p);
    return { base, vat: vatOf(base, rate(l.vatCode)) };
  });
  const sub = computed.reduce((s, c) => s + c.base, 0);
  const vat = computed.reduce((s, c) => s + c.vat, 0);

  const pickContact = (id: number | "") => {
    setContactId(id);
    const c = props.contacts.find((x) => x.id === id);
    if (!c) return;
    const s = determineSaleVat({ kind: c.kind, country: c.country, vatNumber: c.vatNumber, viesValid: c.viesValid }, "services", props.ossActive);
    const code = c.defaultVatCode ?? s.vatCode;
    const acc = c.defaultAccountCode ?? (code === "ICP_S" ? "8100" : code === "NONEU_S" ? "8200" : "8000");
    setLines((ls) => ls.map((l) => ({ ...l, vatCode: code, accountCode: acc })));
    setLanguage(c.language);
    setLayoutId(c.layoutId ?? "");
  };
  const upd = (i: number, k: keyof EditorLine, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  const payload = JSON.stringify(lines.map((l) => ({
    description: l.description, quantity: Number(l.quantity.replace(",", ".")) || 0, unitPriceCents: parseEur(l.price) ?? 0, vatCode: l.vatCode, accountCode: l.accountCode,
  })));
  const notes = [...new Set(lines.map((l) => l.vatCode))];

  return (
    <form action={props.action} className="card cb stack">
      {props.id ? <input type="hidden" name="rowId" value={props.id} /> : null}
      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="language" value={language} />
      <div className="field">
        <label htmlFor="contactId">Klant</label>
        <select id="contactId" name="contactId" required value={contactId} onChange={(e) => pickContact(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Kies een klant…</option>
          {props.contacts.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.country}{c.kind === "consumer" ? " · particulier" : ""}</option>)}
        </select>
      </div>
      {contact ? (
        <div className="row wrap small">
          {contact.vatNumber ? (
            contact.viesValid ? <span className="pill g"><Icon name="check" size={14} />VIES geldig · {contact.vatNumber}</span>
              : <span className="pill a">{contact.vatNumber} · niet gecontroleerd in VIES</span>
          ) : <span className="pill n">Geen BTW-nummer</span>}
          {suggestion ? <span className="pill b">Advies: {props.vatCodes.find((v) => v.code === suggestion.vatCode)?.name}</span> : null}
          {contact.kind === "consumer" && contact.country !== "NL" && props.ossActive ? <span className="pill a">OSS actief: tarief {contact.country} {((props.euRates[contact.country] ?? 0) / 100).toLocaleString("nl-NL")}%</span> : null}
        </div>
      ) : null}

      <div className="grid3">
        <div className="field"><label htmlFor="lang">Taal van factuur en mail</label>
          <select id="lang" value={language} onChange={(e) => setLanguage(e.target.value as "nl" | "en")}><option value="nl">Nederlands</option><option value="en">Engels</option></select>
        </div>
        <div className="field"><label htmlFor="layoutId">Opmaak</label>
          <select id="layoutId" name="layoutId" value={layoutId} onChange={(e) => setLayoutId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Standaard ({props.layouts.find((l) => l.isDefault)?.name ?? "Standaard"})</option>
            {props.layouts.filter((l) => !l.isDefault).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {props.templates.length ? (
          <div className="field"><label htmlFor="tpl">Sjabloon invoegen</label>
            <select id="tpl" value="" onChange={(e) => insertTemplate(e.target.value)}>
              <option value="">Kies een sjabloon…</option>
              {props.templates.filter((tp) => !tp.language || tp.language === language).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
            </select>
          </div>
        ) : <div />}
      </div>

      <div className="grid3">
        <div className="field"><label htmlFor="issueDate">{props.mode === "recurring" ? "Eerste factuurdatum" : "Factuurdatum"}</label><input id="issueDate" name="issueDate" type="date" defaultValue={init.issueDate} /></div>
        {props.mode === "recurring" ? (
          <div className="field"><label htmlFor="intervalMonths">Elke</label>
            <select id="intervalMonths" name="intervalMonths" defaultValue="1"><option value="1">maand</option><option value="3">kwartaal</option><option value="12">jaar</option></select>
          </div>
        ) : (
          <div className="field"><label htmlFor="deliveryDate">Leverdatum</label><input id="deliveryDate" name="deliveryDate" type="date" defaultValue={init.deliveryDate} /></div>
        )}
        <div className="field"><label htmlFor="paymentTermDays">Betaaltermijn (dagen)</label><input id="paymentTermDays" name="paymentTermDays" type="number" min={0} defaultValue={init.paymentTermDays ?? contact?.paymentTermDays ?? props.defaultTerm} /></div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="lines-head"><span>Omschrijving</span><span className="r">Aantal</span><span className="r">Prijs excl.</span><span>BTW</span><span>Omzetrekening</span><span /></div>
        {lines.map((l, i) => (
          <div className="line-row" key={i}>
            <input className="inp" aria-label={`Omschrijving regel ${i + 1}`} value={l.description} onChange={(e) => upd(i, "description", e.target.value)} placeholder="Wat heb je geleverd?" />
            <input className="inp num r" aria-label={`Aantal regel ${i + 1}`} value={l.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} inputMode="decimal" />
            <input className="inp num r" aria-label={`Prijs regel ${i + 1}`} value={l.price} onChange={(e) => upd(i, "price", e.target.value)} inputMode="decimal" placeholder="0,00" />
            <select className="inp" aria-label={`BTW regel ${i + 1}`} value={l.vatCode} onChange={(e) => upd(i, "vatCode", e.target.value)}>
              {props.vatCodes.map((v) => <option key={v.code} value={v.code}>{v.name}</option>)}
            </select>
            <select className="inp" aria-label={`Omzetrekening regel ${i + 1}`} value={l.accountCode} onChange={(e) => upd(i, "accountCode", e.target.value)}>
              {props.accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
            <button type="button" className="btn sm" aria-label={`Regel ${i + 1} verwijderen`} onClick={() => setLines((ls) => ls.length > 1 ? ls.filter((_, j) => j !== i) : [blank()])}><Icon name="x" /></button>
          </div>
        ))}
        <button type="button" className="btn sm" style={{ width: "fit-content" }} onClick={() => setLines((ls) => [...ls, { ...blank(), vatCode: ls.at(-1)?.vatCode ?? defVat, accountCode: ls.at(-1)?.accountCode ?? defAcc ?? "8000" }])}><Icon name="plus" />Regel toevoegen</button>
      </div>

      <div className="field"><label htmlFor="reference">{props.mode === "recurring" ? "Omschrijving schema" : "Referentie (optioneel)"}</label><input id="reference" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
      {props.mode !== "recurring" ? <div className="field"><label htmlFor="notes">Opmerking op factuur</label><textarea id="notes" name="notes" value={notesText} onChange={(e) => setNotesText(e.target.value)} style={{ minHeight: 64 }} /></div> : (
        <label className="check"><input type="checkbox" name="autoSend" /> Automatisch definitief maken en versturen</label>
      )}

      <div style={{ borderTop: "1px solid var(--head-line)", paddingTop: 14, display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 24px" }}>
        <span className="muted">Subtotaal</span><span className="num r">{formatEur(sub)}</span>
        <span className="muted">BTW</span><span className="num r">{formatEur(vat)}</span>
        <span style={{ fontWeight: 600 }}>Totaal</span><span className="num r" style={{ fontWeight: 600 }}>{formatEur(sub + vat)}</span>
      </div>
      {notes.some((n) => ["ICP_S", "ICP_G", "VERL_NL"].includes(n)) ? <div className="small muted">Op de factuur komt de vermelding &quot;BTW verlegd&quot; met het BTW-nummer van de klant.</div> : null}

      <div className="row wrap" style={{ justifyContent: "flex-end" }}>
        {props.mode === "recurring" ? (
          <button className="btn pri" type="submit">Schema opslaan</button>
        ) : (
          <>
            <input className="inp" name="templateName" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Naam sjabloon" aria-label="Naam sjabloon" style={{ width: 180 }} />
            <button className="btn" type="submit" name="intent" value="template" disabled={!tplName.trim()}>Opslaan als sjabloon</button>
            <button className="btn" type="submit" name="intent" value="draft">Opslaan als concept</button>
            <button className="btn pri" type="submit" name="intent" value="finalize"><Icon name="lock" />Definitief maken</button>
          </>
        )}
      </div>
    </form>
  );
}
