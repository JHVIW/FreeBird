import Link from "next/link";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { receipts, contacts, accounts, vatCodes, bankTransactions, files } from "@/db/schema";
import { Top, Flash, Money, Pill, Tabs, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmtDateShort, daysBetween } from "@/lib/dates";
import { formatEur } from "@/lib/money";
import { getSetting } from "@/lib/settings";
import { type SP, str, int } from "@/lib/sp";
import { guessVatCode, type ParsedReceipt } from "@/lib/receipts";
import { uploadReceipts, bookReceiptAction, markReceiptPrivateAction, reparse, ignoreReceipt, pollNow, draftReceiptMail } from "../../actions/receipts";
import { attachEvidence } from "../../actions/bank";
import { missingReceipts } from "@/lib/ai-bank";
import { lastMailDraft } from "@/lib/ai-review";
import { aiConfigured } from "@/lib/ai";
import { quarterRange, today } from "@/lib/dates";

export const metadata = { title: "Inkoop en bonnen" };

const STATUS: Record<string, { label: string; tone: "g" | "a" | "b" | "n" | "r" }> = {
  new: { label: "Nieuw", tone: "n" }, parsed: { label: "Uitgelezen", tone: "b" }, booked: { label: "Geboekt", tone: "g" },
  ignored: { label: "Genegeerd", tone: "n" }, error: { label: "Fout", tone: "r" },
};

export default async function ReceiptsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tab = str(sp.tab) ?? "inbox";
  const selId = int(sp.id);
  if (tab === "ontbrekend") return <Missing sp={sp} />;
  const statuses = tab === "inbox" ? ["new", "parsed", "error"] : tab === "booked" ? ["booked"] : ["new", "parsed", "error", "booked", "ignored"];
  const list = await db.select({ r: receipts, sup: contacts.name }).from(receipts).leftJoin(contacts, eq(contacts.id, receipts.supplierContactId))
    .where(inArray(receipts.status, statuses as ("new" | "parsed" | "booked" | "ignored" | "error")[])).orderBy(desc(receipts.receivedAt)).limit(300);
  const sel = selId ? (await db.select().from(receipts).where(eq(receipts.id, selId)))[0] : list[0]?.r;
  const mail = await getSetting("mail");

  return (
    <>
      <Top title="Inkoop en bonnen" sub={mail.imapHost ? <>Mails in je map <span className="num">{mail.receiptsFolder}</span> worden elke 2 minuten opgehaald en uitgelezen</> : <>IMAP nog niet ingesteld. <Link href="/instellingen#mail">Stel e-mail in</Link> of upload bonnen hier.</>}>
        {mail.imapHost ? <form action={pollNow}><button className="btn" type="submit"><Icon name="refresh" />Nu ophalen</button></form> : null}
      </Top>
      <Flash sp={sp} />
      <div className="split even">
        <div className="stack">
          <form action={uploadReceipts} className="card cb row wrap">
            <label htmlFor="files" className="lbl">Bonnen uploaden</label>
            <input id="files" name="files" type="file" multiple accept="application/pdf,image/*" className="inp" style={{ flex: 1, minWidth: 200 }} />
            <button className="btn" type="submit"><Icon name="up" />Uploaden</button>
          </form>
          <section className="card">
            <div className="ch"><Tabs items={[["inbox", "Te verwerken"], ["booked", "Geboekt"], ["all", "Alles"], ["ontbrekend", "Ontbrekend"]].map(([v, l]) => ({ href: `/inkoop?tab=${v}`, label: l, on: tab === v }))} /></div>
            {list.length ? (
              <table className="t">
                <thead><tr><th>Leverancier</th><th className="hide-sm">Datum</th><th className="r">Bedrag</th><th className="r">Status</th></tr></thead>
                <tbody>
                  {list.map(({ r, sup }) => {
                    const p = r.parsed as ParsedReceipt | null;
                    const open = r.status === "booked" && (r.totalCents ?? 0) - r.paidCents > 0;
                    return (
                      <tr key={r.id} className={`click ${sel?.id === r.id ? "sel" : ""}`}>
                        <td><Link className="rowlink" href={`/inkoop?tab=${tab}&id=${r.id}`}><div style={{ fontWeight: 600 }}>{sup ?? p?.supplierName ?? r.subject ?? "Onbekend"}</div><div className="small muted">{r.source === "mail" ? `mail van ${r.fromAddress ?? "?"}` : r.source === "moneybird" ? "uit Moneybird" : "upload"}{r.invoiceNumber ? ` · ${r.invoiceNumber}` : ""}</div></Link></td>
                        <td className="muted hide-sm">{fmtDateShort(r.date ?? p?.date)}</td>
                        <td className="r"><Money cents={r.totalCents ?? p?.totalCents} /></td>
                        <td className="r">{open ? <Pill tone="a">Wacht op betaling</Pill> : <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill>}{r.autoNote && r.status === "booked" ? <div className="small muted">automatisch</div> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <Empty>{tab === "inbox" ? "Geen bonnen te verwerken." : "Geen bonnen."}</Empty>}
          </section>
        </div>
        {sel ? <ReceiptDetail r={sel} /> : <aside className="card"><Empty>Selecteer een bon.</Empty></aside>}
      </div>
    </>
  );
}

async function ReceiptDetail({ r }: { r: typeof receipts.$inferSelect }) {
  const p = (r.parsed as ParsedReceipt | null) ?? {};
  const [file] = r.fileId ? await db.select().from(files).where(eq(files.id, r.fileId)) : [];
  const [accs, codes, suppliers, openOut] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.type, "expense")).orderBy(asc(accounts.code)),
    db.select().from(vatCodes).where(eq(vatCodes.direction, "purchase")),
    db.select().from(contacts).where(eq(contacts.archived, false)).orderBy(asc(contacts.name)),
    db.select().from(bankTransactions).where(eq(bankTransactions.status, "open")).orderBy(desc(bankTransactions.date)).limit(200),
  ]);
  const total = r.totalCents ?? p.totalCents ?? null;
  const vatSum = p.vatLines?.reduce((s, v) => s + v.vatCents, 0);
  const sup = suppliers.find((s) => s.id === r.supplierContactId);
  const guessVat = guessVatCode(p, sup?.country);
  const defAccount = p.suggestedAccountCode ?? accs.find((a) => a.code === "4800")?.code;
  const candidates = openOut.filter((t) => t.amountCents < 0).map((t) => {
    let score = 0;
    if (total && -t.amountCents === total) score += 50;
    if (r.date && Math.abs(daysBetween(r.date, t.date)) <= 10) score += 20;
    const name = (sup?.name ?? p.supplierName ?? "").toLowerCase().split(" ")[0];
    if (name && t.counterpartyName?.toLowerCase().includes(name)) score += 30;
    return { t, score };
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0]?.score >= 50 ? candidates[0].t : null;
  const isImg = file?.mime.startsWith("image/");

  return (
    <aside className="card sticky">
      <div className="ch"><h2>{sup?.name ?? p.supplierName ?? "Bon"}{p.invoiceNumber ? ` · ${p.invoiceNumber}` : ""}</h2><Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill></div>
      <div className="cb stack">
        {file ? (isImg ? <img src={`/api/files/${file.id}`} alt={`Bon ${file.filename}`} style={{ width: "100%", maxHeight: 420, objectFit: "contain", background: "var(--soft)", borderRadius: 8 }} />
          : <iframe src={`/api/files/${file.id}`} title={`Bon ${file.filename}`} style={{ width: "100%", height: 420, border: "1px solid var(--line)", borderRadius: 8 }} />) : null}
        {r.autoNote ? <div className={`box ${r.status === "booked" ? "ok" : "plain"}`}><div className="t">Inbox</div><div className="small">{r.autoNote}</div></div> : null}
        {r.error ? <div className="box warn"><div className="t">Uitlezen mislukt</div><div className="small">{r.error}</div></div> : null}

        {r.status === "booked" ? (
          <div className="box plain small">
            Geboekt op {fmtDateShort(r.date)} · {formatEur(r.totalCents)} · betaald {formatEur(r.paidCents)}
            {(r.totalCents ?? 0) - r.paidCents > 0 ? (
              <>
                <div className="muted">De betaling wordt automatisch voorgesteld in Bank zodra hij binnenkomt.</div>
                <form action={markReceiptPrivateAction} className="stack" style={{ marginTop: 8 }}>
                  <input type="hidden" name="rowId" value={r.id} />
                  <div className="field"><label htmlFor="privDate">Betaaldatum</label><input id="privDate" name="date" type="date" required defaultValue={r.date ?? ""} /></div>
                  <button className="btn" type="submit">Privé betaald</button>
                  <span className="hint">Boekt crediteuren aan 0910 Privé-stortingen, zonder bank.</span>
                </form>
              </>
            ) : null}
          </div>
        ) : (
          <form action={bookReceiptAction} className="stack">
            <input type="hidden" name="rowId" value={r.id} />
            <div className="field"><label htmlFor="sup">Leverancier</label>
              <select id="sup" name="supplierContactId" defaultValue={sup?.id ?? ""}><option value="">Nieuwe leverancier: {p.supplierName ?? "…"}</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <input type="hidden" name="supplierName" value={p.supplierName ?? ""} />
            </div>
            <div className="grid2">
              <div className="field"><label htmlFor="date">Datum</label><input id="date" name="date" type="date" required defaultValue={r.date ?? p.date ?? ""} /></div>
              <div className="field"><label htmlFor="invoiceNumber">Factuurnr.</label><input id="invoiceNumber" name="invoiceNumber" defaultValue={r.invoiceNumber ?? p.invoiceNumber ?? ""} /></div>
            </div>
            <div className="grid2">
              <div className="field"><label htmlFor="total">Totaal betaald</label><input id="total" name="total" className="num" required inputMode="decimal" defaultValue={total != null ? (total / 100).toFixed(2).replace(".", ",") : ""} /></div>
              <div className="field"><label htmlFor="vat">BTW-bedrag</label><input id="vat" name="vat" className="num" inputMode="decimal" defaultValue={vatSum != null ? (vatSum / 100).toFixed(2).replace(".", ",") : ""} /><span className="hint">Leeg = berekenen uit tarief</span></div>
            </div>
            <div className="field"><label htmlFor="vatCode">BTW-code</label><select id="vatCode" name="vatCode" defaultValue={guessVat}>{codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
            <div className="field"><label htmlFor="accountCode">Grootboek</label><select id="accountCode" name="accountCode" defaultValue={defAccount}>{accs.filter((a) => a.code !== "4900").map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></div>
            <div className="field"><label htmlFor="description">Omschrijving</label><input id="description" name="description" defaultValue={p.description ?? ""} /></div>
            <details className="more"><summary>Bedrijfsmiddel (afschrijven)</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <label className="check"><input type="checkbox" name="isAsset" /> Activeren op Inventaris en afschrijven</label>
                <div className="grid2">
                  <div className="field"><label htmlFor="assetMonths">Looptijd (maanden)</label><input id="assetMonths" name="assetMonths" type="number" defaultValue={36} min={1} /></div>
                  <div className="field"><label htmlFor="assetResidual">Restwaarde</label><input id="assetResidual" name="assetResidual" inputMode="decimal" defaultValue="0" /></div>
                </div>
              </div>
            </details>
            <div className="field"><label htmlFor="bankTxId">Betaald via bank</label>
              <select id="bankTxId" name="bankTxId" defaultValue={best?.id ?? ""}>
                <option value="">Nog niet betaald / later koppelen</option>
                {candidates.slice(0, 30).map(({ t }) => <option key={t.id} value={t.id}>{fmtDateShort(t.date)} · {t.counterpartyName} · {formatEur(t.amountCents)}</option>)}
              </select>
              {best ? <span className="hint">Match gevonden op bedrag{best.counterpartyName ? ` en ${best.counterpartyName}` : ""}</span> : null}
            </div>
            <button className="btn pri" type="submit"><Icon name="check" />Boeken{best ? " en koppelen" : ""}</button>
          </form>
        )}
        {r.status !== "booked" ? (
          <div className="row">
            <form action={reparse}><input type="hidden" name="rowId" value={r.id} /><button className="btn sm" type="submit">Opnieuw uitlezen</button></form>
            <form action={ignoreReceipt}><input type="hidden" name="rowId" value={r.id} /><button className="btn sm" type="submit">Negeren</button></form>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** Uitgaven die direct op een kostenrekening zijn geboekt zonder bon: bijvoegen of opvragen. */
async function Missing({ sp }: { sp: Awaited<SP> }) {
  const y = int(sp.y), q = int(sp.q);
  const general = await getSetting("general");
  const { from, to } = y && q ? quarterRange(y, q) : { from: general.openingDate ?? `${today().slice(0, 4)}-01-01`, to: today() };
  const [rows, ai] = await Promise.all([missingReceipts(from, to), aiConfigured()]);
  const mailFor = int(sp.mail);
  const draft = mailFor ? await lastMailDraft(mailFor) : null;
  const back = `/inkoop?tab=ontbrekend${y && q ? `&y=${y}&q=${q}` : ""}`;
  const deductible = ["I21", "I9", "RC_EU", "RC_NONEU", "RC_NL"];
  return (
    <>
      <Top title="Ontbrekende bonnen" sub={`Uitgaven van ${fmtDateShort(from)} t/m ${fmtDateShort(to)} die direct op een kostenrekening zijn geboekt zonder bon of factuur`} />
      <Flash sp={sp} />
      <section className="card">
        <div className="ch"><Tabs items={[["inbox", "Te verwerken"], ["booked", "Geboekt"], ["all", "Alles"], ["ontbrekend", "Ontbrekend"]].map(([v, l]) => ({ href: `/inkoop?tab=${v}`, label: l, on: v === "ontbrekend" }))} /></div>
        {rows.length ? (
          <table className="t">
            <thead><tr><th>Datum</th><th>Tegenpartij</th><th className="hide-sm">Geboekt op</th><th className="r">Bedrag</th><th className="r">Actie</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} id={`mail-${r.id}`}>
                  <td className="muted">{fmtDateShort(r.date)}</td>
                  <td><div style={{ fontWeight: 600 }}>{r.contact_name ?? r.counterparty_name ?? "Onbekend"}</div><div className="small muted">{r.description.slice(0, 70)}</div>
                    {deductible.includes(r.vat_code) ? <Pill tone="a">BTW afgetrokken ({r.vat_code})</Pill> : null}
                    {draft && mailFor === r.id ? (
                      <div className="box plain stack" style={{ marginTop: 8 }}>
                        <div className="t">Concept-mail{draft.to ? ` aan ${draft.to}` : ""}</div>
                        <div style={{ fontWeight: 600 }}>{draft.subject}</div>
                        <textarea readOnly defaultValue={draft.body} rows={8} className="inp" aria-label="Tekst van de mail" style={{ width: "100%" }} />
                        <a className="btn sm" href={`mailto:${draft.to ?? ""}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}><Icon name="mail" />Openen in mail</a>
                      </div>
                    ) : null}
                  </td>
                  <td className="hide-sm small">{r.account_code} {r.account_name}</td>
                  <td className="r"><Money cents={r.amountCents} /></td>
                  <td className="r">
                    <div className="stack" style={{ alignItems: "flex-end" }}>
                      <form action={attachEvidence} className="row">
                        <input type="hidden" name="txId" value={r.id} /><input type="hidden" name="back" value={back} />
                        <input name="file" type="file" accept="application/pdf,image/*" aria-label="Bon kiezen" className="inp" style={{ maxWidth: 190 }} />
                        <button className="btn sm" type="submit"><Icon name="up" />Bijvoegen</button>
                      </form>
                      {ai ? (
                        <form action={draftReceiptMail}>
                          <input type="hidden" name="txId" value={r.id} /><input type="hidden" name="back" value={back} />
                          <button className="linkbtn small" type="submit">Mail opstellen om de factuur op te vragen</button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>Voor alle uitgaven in deze periode is een bon.</Empty>}
      </section>
    </>
  );
}
