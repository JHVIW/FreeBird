import Link from "next/link";
import { and, asc, desc, eq, ilike, or, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, bankAccounts, invoices, contacts, receipts, reconciliations, accounts, vatCodes, journalEntries } from "@/db/schema";
import { Top, Kpi, Money, Pill, Flash, Tabs, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmtDateShort, fmtDate } from "@/lib/dates";
import { formatEur } from "@/lib/money";
import { formatIban, ibanCountry, COUNTRY_NAMES, normalizeIban } from "@/lib/eu";
import { getSetting } from "@/lib/settings";
import type { Suggestion } from "@/lib/matching";
import { type SP, str, int } from "@/lib/sp";
import { aiConfigured } from "@/lib/ai";
import { ruleProposals, confidentAiTransactions, bulkStatus, type AiSuggestion } from "@/lib/ai-bank";
import { AutoRefresh, SelectAll } from "@/components/live";
import {
  confirmSuggestion, linkInvoice, linkReceipt, bookAccount, bookAsSale, payVat, undoBooking, syncNow, rematch,
  aiSuggestAll, aiSuggestOne, bookAiConfident, bookSelectedAi, createRuleFromProposal, attachEvidence,
} from "../../actions/bank";

export const metadata = { title: "Bank" };

export default async function BankPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const filter = str(sp.filter) ?? "open";
  const q = str(sp.q) ?? "";
  const selId = int(sp.tx);
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const m = { filter, q, ...o };
    for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/bank?${p}`;
  };

  const conds = [];
  if (filter === "open") conds.push(eq(bankTransactions.status, "open"));
  if (filter === "booked") conds.push(eq(bankTransactions.status, "booked"));
  if (q) conds.push(or(ilike(bankTransactions.counterpartyName, `%${q}%`), ilike(bankTransactions.description, `%${q}%`)));
  const list = await db.select().from(bankTransactions).where(conds.length ? and(...conds) : undefined).orderBy(desc(bankTransactions.date), desc(bankTransactions.id)).limit(300);
  const sel = selId ? (await db.select().from(bankTransactions).where(eq(bankTransactions.id, selId)))[0] : list[0];

  const [accs, bunq, ai, proposals, confident, bulk, ledger, [stats]] = await Promise.all([
    db.select().from(bankAccounts),
    getSetting("bunq"),
    aiConfigured(),
    ruleProposals(),
    confidentAiTransactions(90),
    bulkStatus(),
    db.select({ code: accounts.code, name: accounts.name }).from(accounts),
    db.select({
      open: dsql<number>`count(*) filter (where ${bankTransactions.status} = 'open')`,
      month: dsql<number>`count(*) filter (where ${bankTransactions.date} >= date_trunc('month', now())::date)`,
      monthBooked: dsql<number>`count(*) filter (where ${bankTransactions.date} >= date_trunc('month', now())::date and ${bankTransactions.status} = 'booked')`,
    }).from(bankTransactions),
  ]);
  const balance = accs.reduce((s, a) => s + (a.balanceCents ?? 0), 0);
  const back = qs({ tx: sel?.id });
  const accName = new Map(ledger.map((a) => [a.code, a.name]));
  // aanvinkbaar: open, met AI-voorstel, en geen sterk voorstel van factuur/bon/regel
  const pickable = (t: (typeof list)[number]) => t.status === "open" && !!t.aiSuggestion && ((t.suggestions as Suggestion[] | null)?.[0]?.confidence ?? 0) < 85;
  const anyPickable = list.some(pickable);

  return (
    <>
      <Top title="Bank" sub={accs.length ? `${accs.map((a) => `${a.name} · ${formatIban(a.iban)}`).join(", ")}${bunq.lastSyncAt ? ` · laatste sync ${new Date(bunq.lastSyncAt).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}` : ""}` : "Nog geen bunq-rekening gekoppeld"}>
        <form action={rematch}><input type="hidden" name="back" value={back} /><button className="btn" type="submit"><Icon name="wand" />Opnieuw matchen</button></form>
        {ai ? <form action={aiSuggestAll}><input type="hidden" name="back" value={back} /><button className="btn" type="submit" disabled={bulk.running}><Icon name="spark" />{bulk.running ? "AI is bezig…" : "AI-voorstellen"}</button></form> : null}
        <form action={syncNow}><input type="hidden" name="back" value={back} /><button className="btn" type="submit" disabled={!bunq.apiKey}><Icon name="refresh" />Nu synchroniseren</button></form>
      </Top>
      <Flash sp={sp} />
      {!bunq.apiKey ? <div className="flash err">bunq is nog niet gekoppeld. <Link href="/instellingen#bunq">Voer je API key in</Link>.</div> : null}

      <div className="kpis">
        <Kpi label="Saldo (bunq)" value={formatEur(balance)} detail={accs[0] ? formatIban(accs[0].iban) : ""} />
        <Kpi label="Te verwerken" value={Number(stats.open)} detail="Open banktransacties" />
        <Kpi label="Deze maand" value={Number(stats.month)} detail={`${stats.monthBooked} geboekt`} />
        <Kpi label="Automatisch" value={Number(stats.month) ? `${Math.round((Number(stats.monthBooked) / Number(stats.month)) * 100)}%` : "–"} detail="Geboekt deze maand" />
      </div>

      {bulk.running ? (
        <div className="flash ok" role="status"><AutoRefresh />De AI maakt voorstellen: {bulk.message}. Je kunt gewoon verder werken.</div>
      ) : bulk.status === "fout" && bulk.at && Date.now() - bulk.at.getTime() < 10 * 60_000 ? (
        <div className="flash err">AI-voorstellen mislukt: {bulk.message}</div>
      ) : null}

      {confident.length ? (
        <form action={bookAiConfident} className="card cb row wrap" style={{ marginBottom: 18 }}>
          <input type="hidden" name="back" value={back} />
          <span style={{ fontWeight: 600, flex: 1, minWidth: 220 }}>{confident.length} AI-voorstel(len) met 90%+ zekerheid klaar om te boeken</span>
          <label className="check small"><input type="checkbox" name="confirm" /> Ik heb ze bekeken</label>
          <button className="btn pri" type="submit"><Icon name="check" />Allemaal boeken</button>
        </form>
      ) : null}

      {proposals.length ? (
        <details className="card cb more" style={{ marginBottom: 18 }}>
          <summary>{proposals.length} voorgestelde regel(s): tegenpartijen die je steeds hetzelfde boekt</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {proposals.slice(0, 10).map((p) => (
              <form key={p.key} action={createRuleFromProposal} className="row wrap" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 10 }}>
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="name" value={p.name} /><input type="hidden" name="match" value={JSON.stringify(p.match)} />
                <input type="hidden" name="accountCode" value={p.accountCode} /><input type="hidden" name="vatCode" value={p.vatCode} />
                <input type="hidden" name="contactId" value={p.contactId ?? ""} />
                <span style={{ flex: 1, minWidth: 220 }}><strong>{p.name}</strong> <span className="small muted">· {p.vatCode} · {p.count}× zo geboekt</span></span>
                <label className="check small"><input type="checkbox" name="auto" defaultChecked /> Automatisch boeken</label>
                <button className="btn sm" type="submit">Regel maken</button>
              </form>
            ))}
          </div>
        </details>
      ) : null}

      <div className="split">
        <section className="card">
          <div className="ch">
            <Tabs items={[
              { href: qs({ filter: "open" }), label: "Te verwerken", on: filter === "open" },
              { href: qs({ filter: "booked" }), label: "Geboekt", on: filter === "booked" },
              { href: qs({ filter: "all" }), label: "Alle", on: filter === "all" },
            ]} />
            <form className="row" action="/bank">
              <input type="hidden" name="filter" value={filter} />
              <label htmlFor="q" className="lbl" style={{ position: "absolute", left: -9999 }}>Zoeken</label>
              <input id="q" name="q" defaultValue={q} placeholder="Zoek naam of omschrijving" className="inp" style={{ width: 240 }} />
            </form>
          </div>
          {anyPickable ? (
            <form id="bulk" action={bookSelectedAi} className="row wrap" style={{ padding: "10px 20px", borderBottom: "1px solid var(--head-line)" }}>
              <input type="hidden" name="back" value={back} />
              <SelectAll form="bulk" name="ids" label="Alles met AI-voorstel" />
              <button className="btn pri sm" type="submit"><Icon name="check" />Aangevinkte boeken</button>
            </form>
          ) : null}
          {list.length ? (
            <table className="t">
              <thead><tr>{anyPickable ? <th aria-label="Selecteren" /> : null}<th>Datum</th><th>Tegenpartij</th><th className="r">Bedrag</th><th className="r hide-sm">Status</th></tr></thead>
              <tbody>
                {list.map((t) => {
                  const s = (t.suggestions as Suggestion[] | null)?.[0];
                  const a = t.aiSuggestion as AiSuggestion | null;
                  return (
                    <tr key={t.id} className={`click ${sel?.id === t.id ? "sel" : ""}`}>
                      {anyPickable ? <td style={{ width: 28 }}>{pickable(t) ? <input type="checkbox" name="ids" value={t.id} form="bulk" aria-label={`${t.counterpartyName ?? "Transactie"} selecteren`} style={{ width: 18, height: 18 }} /> : null}</td> : null}
                      <td className="muted" style={{ whiteSpace: "nowrap" }}><Link className="rowlink" href={qs({ tx: t.id })}>{fmtDateShort(t.date)}</Link></td>
                      <td><Link className="rowlink" href={qs({ tx: t.id })}><div style={{ fontWeight: 600 }}>{t.counterpartyName ?? "Onbekend"}</div><div className="small muted">{t.description.slice(0, 70)}</div>{a && pickable(t) ? <div className="small" style={{ color: "var(--accent-ink)" }}>AI: {a.accountCode} {accName.get(a.accountCode) ?? ""} · {a.vatCode}</div> : null}</Link></td>
                      <td className="r"><Money cents={t.amountCents} sign /></td>
                      <td className="r hide-sm">{t.status === "booked" ? <Pill tone="g">Geboekt</Pill> : s ? <Pill tone="b">Voorstel</Pill> : a ? <Pill tone="b">AI {a.confidence}%</Pill> : <Pill tone="a">Handmatig</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty>{filter === "open" ? "Alles is verwerkt." : "Geen transacties."}</Empty>}
        </section>
        {sel ? <Detail tx={sel} back={back} ai={ai} /> : <aside className="card"><Empty>Selecteer een transactie.</Empty></aside>}
      </div>
    </>
  );
}

async function Detail({ tx, back, ai }: { tx: typeof bankTransactions.$inferSelect; back: string; ai: boolean }) {
  const suggestions = (tx.suggestions as Suggestion[] | null) ?? [];
  const aiSug = tx.aiSuggestion as AiSuggestion | null;
  const isIn = tx.amountCents > 0;
  const recs = await db.select({ r: reconciliations, desc: journalEntries.description }).from(reconciliations)
    .leftJoin(journalEntries, eq(journalEntries.id, reconciliations.journalEntryId)).where(eq(reconciliations.bankTransactionId, tx.id));
  const [openInv, bookedReceipts, accs, codes, cs] = await Promise.all([
    isIn ? db.select({ i: invoices, name: contacts.name }).from(invoices).innerJoin(contacts, eq(contacts.id, invoices.contactId)).where(eq(invoices.status, "open")).orderBy(asc(invoices.number)) : Promise.resolve([]),
    !isIn ? db.select().from(receipts).where(eq(receipts.status, "booked")) : Promise.resolve([]),
    db.select().from(accounts).where(eq(accounts.active, true)).orderBy(asc(accounts.code)),
    db.select().from(vatCodes).where(eq(vatCodes.active, true)),
    db.select().from(contacts).where(eq(contacts.archived, false)).orderBy(asc(contacts.name)),
  ]);
  const unpaidReceipts = bookedReceipts.filter((r) => (r.totalCents ?? 0) - r.paidCents > 0);
  const ibanCc = ibanCountry(tx.counterpartyIban);
  const known = tx.counterpartyIban ? cs.find((c) => c.ibans.includes(normalizeIban(tx.counterpartyIban!))) : undefined;
  const dir = isIn ? "sale" : "purchase";
  // een eigen overboeking boek je op de grootboekrekening van de andere bankrekening, dus die mag dan in de lijst
  const bookable = accs.filter((a) => a.code === aiSug?.accountCode || !["1000", "1100", "1600", "1500", "1510", "1520", "1530", "1540"].includes(a.code));
  const aiAccount = aiSug ? accs.find((a) => a.code === aiSug.accountCode) : undefined;
  const aiVat = aiSug ? codes.find((c) => c.code === aiSug.vatCode) : undefined;
  const aiContact = aiSug?.contactId ? cs.find((c) => c.id === aiSug.contactId) : undefined;
  const strong = suggestions.some((s) => s.confidence >= 85);
  const hidden = <><input type="hidden" name="txId" value={tx.id} /><input type="hidden" name="back" value={back} /></>;

  return (
    <aside className="card sticky">
      <div className="ch"><h2>Transactie</h2>{tx.status === "booked" ? <Pill tone="g">Geboekt</Pill> : <Pill tone="a">Te verwerken</Pill>}</div>
      <div className="cb stack">
        <div>
          <div className={`num ${isIn ? "pos" : ""}`} style={{ fontSize: 28 }}>{formatEur(tx.amountCents, { sign: true })}</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{tx.counterpartyName ?? "Onbekend"}</div>
          <div className="small muted">{fmtDate(tx.date)} · {formatIban(tx.counterpartyIban) || "geen IBAN"}{ibanCc ? ` · ${COUNTRY_NAMES[ibanCc] ?? ibanCc}` : ""}</div>
        </div>
        <div className="small" style={{ background: "var(--soft)", borderRadius: 8, padding: "10px 12px" }}><div className="muted">Omschrijving</div><div className="num" style={{ marginTop: 2, overflowWrap: "anywhere" }}>{tx.description || "—"}</div></div>

        {tx.status === "booked" ? (
          <div className="box plain stack">
            <div className="t">Geboekt als</div>
            {recs.map(({ r, desc }) => (
              <div key={r.id} className="spread small">
                <span>{r.targetType === "invoice" ? <Link href={`/facturen/${r.targetId}`}>{desc}</Link> : desc}</span><Money cents={r.amountCents} />
              </div>
            ))}
            <form action={undoBooking}>{hidden}<button className="btn sm" type="submit"><Icon name="undo" />Ontkoppelen</button></form>
            {recs.some(({ r }) => r.targetType === "entry") && tx.amountCents < 0 ? (
              tx.evidenceFileId ? <div className="small"><Icon name="check" /> <a href={`/api/files/${tx.evidenceFileId}`} target="_blank" rel="noreferrer">Bon/factuur bekijken</a></div> : (
                <form action={attachEvidence} className="row wrap">
                  {hidden}
                  <label htmlFor="evf" className="small" style={{ fontWeight: 600 }}>Bon of factuur bijvoegen</label>
                  <input id="evf" name="file" type="file" accept="application/pdf,image/*" className="inp" style={{ flex: 1, minWidth: 160 }} />
                  <button className="btn sm" type="submit"><Icon name="up" />Bijvoegen</button>
                </form>
              )
            ) : null}
          </div>
        ) : (
          <>
            {suggestions.slice(0, 3).map((s, i) => (
              <form key={i} action={confirmSuggestion} className="box ok">
                {hidden}<input type="hidden" name="idx" value={i} />
                <div className="t">Voorstel{s.confidence >= 90 ? "" : ` · ${s.confidence}%`}</div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>{s.label}</div>
                <div className="small muted">{s.reason}</div>
                <button className="btn pri sm" type="submit" style={{ marginTop: 10 }}><Icon name="check" />Bevestigen</button>
              </form>
            ))}

            {isIn && openInv.length ? (
              <details className="more" open={!suggestions.length}>
                <summary>Koppelen aan factuur</summary>
                <form action={linkInvoice} className="stack" style={{ marginTop: 8 }}>
                  {hidden}
                  <div className="field"><label htmlFor="inv">Factuur</label>
                    <select id="inv" name="invoiceId">{openInv.map(({ i, name }) => <option key={i.id} value={i.id}>{i.number} · {name} · {formatEur(i.totalCents - i.paidCents)}</option>)}</select>
                  </div>
                  <div className="field"><label htmlFor="amt">Bedrag (leeg = volledig)</label><input id="amt" name="amount" inputMode="decimal" placeholder={formatEur(tx.amountCents)} /></div>
                  <button className="btn sm" type="submit">Koppelen</button>
                </form>
              </details>
            ) : null}

            {isIn ? (
              <details className="more">
                <summary>Verkoop zonder factuur (webshop, kassa)</summary>
                <form action={bookAsSale} className="stack" style={{ marginTop: 8 }}>
                  {hidden}
                  <div className="field"><label htmlFor="sc">Klant</label>
                    <select id="sc" name="contactId" defaultValue={known?.id ?? ""}>
                      <option value="">Nieuwe particuliere klant…</option>
                      {cs.filter((c) => c.isCustomer).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.country}{c.kind === "consumer" ? ", particulier" : ""})</option>)}
                    </select>
                  </div>
                  <div className="grid2">
                    <div className="field"><label htmlFor="nn">Naam (nieuw)</label><input id="nn" name="newName" defaultValue={tx.counterpartyName ?? ""} /></div>
                    <div className="field"><label htmlFor="ncc">Land (nieuw)</label><input id="ncc" name="newCountry" defaultValue={ibanCc ?? "NL"} maxLength={2} /></div>
                  </div>
                  <div className="field"><label htmlFor="sacc">Omzetrekening</label>
                    <select id="sacc" name="accountCode" defaultValue="8300">{accs.filter((a) => a.type === "revenue").map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
                  </div>
                  <label className="check small"><input type="checkbox" name="remember" /> Voortaan automatisch voor ontvangsten met omschrijving</label>
                  <input name="pattern" className="inp" placeholder="bijv. ORDER-" aria-label="Patroon in omschrijving" />
                  <div className="small muted">BTW volgt uit het land van de klant en de OSS-drempel. Het IBAN-land wordt als bewijs opgeslagen.</div>
                  <button className="btn sm" type="submit">Boeken als verkoop</button>
                </form>
              </details>
            ) : null}

            {!isIn && unpaidReceipts.length ? (
              <details className="more">
                <summary>Koppelen aan geboekte bon</summary>
                <form action={linkReceipt} className="stack" style={{ marginTop: 8 }}>
                  {hidden}
                  <select name="receiptId" className="inp" aria-label="Bon">{unpaidReceipts.map((r) => <option key={r.id} value={r.id}>{(r.parsed as { supplierName?: string } | null)?.supplierName ?? `Bon ${r.id}`} · {formatEur((r.totalCents ?? 0) - r.paidCents)}</option>)}</select>
                  <button className="btn sm" type="submit">Koppelen</button>
                </form>
              </details>
            ) : null}

            {!isIn ? (
              <form action={payVat}>{hidden}<button className="linkbtn small" type="submit">Dit is een BTW-betaling aan de Belastingdienst</button></form>
            ) : null}

            {aiSug && !strong ? (
              <form action={bookAccount} className="box ok">
                {hidden}
                <input type="hidden" name="accountCode" value={aiSug.accountCode} /><input type="hidden" name="vatCode" value={aiSug.vatCode} />
                <input type="hidden" name="contactId" value={aiSug.contactId ?? ""} />
                <div className="t">{aiSug.source === "own_transfer" ? "Voorstel" : `AI-voorstel · ${aiSug.confidence}%`}</div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>{aiAccount ? `${aiAccount.code} ${aiAccount.name}` : aiSug.accountCode} · {aiVat?.name ?? aiSug.vatCode}</div>
                {aiContact ? <div className="small">Relatie: {aiContact.name}</div> : null}
                <div className="small muted">{aiSug.reason}</div>
                <div className="row wrap" style={{ marginTop: 10 }}>
                  <button className="btn pri sm" type="submit"><Icon name="check" />Boeken</button>
                  {aiSug.source === "ai" ? <button className="btn sm" type="submit" formAction={aiSuggestOne}><Icon name="refresh" />Opnieuw</button> : null}
                </div>
              </form>
            ) : ai && !strong ? (
              <form action={aiSuggestOne}>{hidden}<button className="btn sm" type="submit"><Icon name="spark" />AI-voorstel maken</button></form>
            ) : null}

            <details className="more" open={!suggestions.length && !isIn && !aiSug}>
              <summary>{aiSug && !strong ? "Anders boeken" : "Boeken op grootboekrekening"}</summary>
              <form action={bookAccount} className="stack" style={{ marginTop: 8 }}>
                {hidden}
                <div className="field"><label htmlFor="ac">Grootboekrekening</label>
                  <select id="ac" name="accountCode" defaultValue={aiSug?.accountCode ?? (isIn ? "8900" : "4800")}>
                    {bookable.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                </div>
                <div className="field"><label htmlFor="vc">BTW-code</label>
                  <select id="vc" name="vatCode" defaultValue={aiSug?.vatCode ?? (isIn ? "V21" : "I21")}>
                    {codes.filter((c) => c.direction === dir || c.code === "NONE").filter((c) => c.code !== "OSS").map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                  <span className="hint">Privé-opname of -storting: rekening 0920/0910 met &quot;Geen BTW&quot;.</span>
                </div>
                <div className="field"><label htmlFor="ct">Relatie (optioneel)</label>
                  <select id="ct" name="contactId" defaultValue={aiSug?.contactId ?? known?.id ?? ""}><option value="">—</option>{cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </div>
                <label className="check small"><input type="checkbox" name="remember" /> Onthoud als regel voor deze tegenpartij</label>
                <label className="check small"><input type="checkbox" name="auto" /> Regel voortaan automatisch toepassen</label>
                <button className="btn sm" type="submit">Boeken</button>
              </form>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
