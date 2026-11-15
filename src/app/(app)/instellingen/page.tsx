import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { rules, fiscalParams, accounts, vatCodes, bankAccounts, jobRuns } from "@/db/schema";
import { Top, Flash, Pill } from "@/components/ui";
import { Icon } from "@/components/icons";
import { getSetting, hasSecret } from "@/lib/settings";
import { formatIban } from "@/lib/eu";
import { formatEur } from "@/lib/money";
import type { SP } from "@/lib/sp";
import type { RuleAction, RuleMatch } from "@/lib/matching";
import {
  saveCompany, saveInvoiceSettings, saveMail, testMail, connectBunq, bunqFullImport, saveGeneral, toggleRule, addRule, saveParam, copyParams, addAccount,
} from "../../actions/settings";

export const metadata = { title: "Instellingen" };

export default async function SettingsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [company, inv, mail, bunq, general, ruleList, params, accs, codes, banks, jobs] = await Promise.all([
    getSetting("company"), getSetting("invoice"), getSetting("mail"), getSetting("bunq"), getSetting("general"),
    db.select().from(rules).orderBy(desc(rules.hits)),
    db.select().from(fiscalParams).orderBy(desc(fiscalParams.year), asc(fiscalParams.key)),
    db.select().from(accounts).orderBy(asc(accounts.code)),
    db.select().from(vatCodes),
    db.select().from(bankAccounts),
    db.select().from(jobRuns),
  ]);
  const years = [...new Set(params.map((p) => p.year))];
  const aiFromEnv = !!process.env.DEEPSEEK_API_KEY;

  return (
    <>
      <Top title="Instellingen" sub={company.name} />
      <Flash sp={sp} />
      <div className="split even">
        <div className="stack">
          <form id="bedrijf" action={saveCompany} className="card">
            <div className="ch"><h2>Bedrijf</h2><span className="small muted">Komt op elke factuur</span></div>
            <div className="cb stack">
              <div className="field"><label htmlFor="c-name">Naam</label><input id="c-name" name="name" defaultValue={company.name} required /></div>
              <div className="field"><label htmlFor="c-address">Adres</label><input id="c-address" name="address" defaultValue={company.address} /></div>
              <div className="grid3">
                <div className="field"><label htmlFor="c-pc">Postcode</label><input id="c-pc" name="postcode" defaultValue={company.postcode} /></div>
                <div className="field"><label htmlFor="c-city">Plaats</label><input id="c-city" name="city" defaultValue={company.city} /></div>
                <div className="field"><label htmlFor="c-cc">Land</label><input id="c-cc" name="country" defaultValue={company.country} maxLength={2} /></div>
              </div>
              <div className="grid2">
                <div className="field"><label htmlFor="c-kvk">KvK</label><input id="c-kvk" name="kvk" defaultValue={company.kvk} /></div>
                <div className="field"><label htmlFor="c-vat">BTW-id</label><input id="c-vat" name="vatNumber" defaultValue={company.vatNumber} placeholder="NL000000000B01" /></div>
                <div className="field"><label htmlFor="c-iban">IBAN</label><input id="c-iban" name="iban" defaultValue={formatIban(company.iban)} /></div>
                <div className="field"><label htmlFor="c-bic">BIC</label><input id="c-bic" name="bic" defaultValue={company.bic} /></div>
                <div className="field"><label htmlFor="c-email">E-mail</label><input id="c-email" name="email" type="email" defaultValue={company.email} /></div>
                <div className="field"><label htmlFor="c-phone">Telefoon</label><input id="c-phone" name="phone" defaultValue={company.phone} /></div>
              </div>
              <div className="field"><label htmlFor="c-web">Website</label><input id="c-web" name="website" defaultValue={company.website} /></div>
              <button className="btn pri" type="submit">Opslaan</button>
            </div>
          </form>

          <form id="factuur" action={saveInvoiceSettings} className="card">
            <div className="ch"><h2>Facturen en herinneringen</h2></div>
            <div className="cb stack">
              <div className="grid2">
                <div className="field"><label htmlFor="i-term">Standaard betaaltermijn (dagen)</label><input id="i-term" name="paymentTermDays" type="number" defaultValue={inv.paymentTermDays} /></div>
                <div className="field"><label htmlFor="i-rem">Herinneringen na (dagen over vervaldatum)</label><input id="i-rem" name="reminderDays" defaultValue={inv.reminderDays.join(", ")} /></div>
              </div>
              <label className="check"><input type="checkbox" name="bunqmeLinks" defaultChecked={inv.bunqmeLinks} /> bunq.me-betaallink op elke factuur</label>
              <label className="check"><input type="checkbox" name="attachUbl" defaultChecked={inv.attachUbl} /> UBL (e-factuur) meesturen</label>
              <div className="field"><label htmlFor="i-foot">Voettekst PDF</label><input id="i-foot" name="footer" defaultValue={inv.footer} placeholder="Leeg = bedrijfsgegevens" /></div>
              <div className="small muted">Opmaak, factuursjablonen en mailteksten (NL en EN) beheer je bij <Link href="/facturen/sjablonen">Facturen › Sjablonen</Link>.</div>
              <button className="btn pri" type="submit">Opslaan</button>
            </div>
          </form>

          <section id="regels" className="card">
            <div className="ch"><h2>Boekingsregels</h2></div>
            <table className="t">
              <thead><tr><th>Als</th><th>Dan</th><th className="r">Gebruikt</th><th /></tr></thead>
              <tbody>
                {ruleList.map((r) => {
                  const m = r.match as RuleMatch, a = r.action as RuleAction;
                  return (
                    <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                      <td className="small">{[m.counterpartyContains && `naam bevat "${m.counterpartyContains}"`, m.descriptionContains && `omschrijving bevat "${m.descriptionContains}"`, m.iban && `IBAN ${formatIban(m.iban)}`, m.direction && (m.direction === "in" ? "ontvangst" : "uitgave")].filter(Boolean).join(", ")}</td>
                      <td className="small">{a.kind === "sale" ? `Verkoop op ${a.accountCode}` : `${a.accountCode} · ${a.vatCode}`}{r.autoApply ? <> · <Pill tone="g">auto</Pill></> : null}</td>
                      <td className="r num">{r.hits}×</td>
                      <td className="r">
                        <form action={toggleRule} className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <input type="hidden" name="rowId" value={r.id} />
                          <button className="btn sm" name="op" value="auto" type="submit">{r.autoApply ? "Handmatig" : "Auto"}</button>
                          <button className="btn sm" name="op" value="active" type="submit">{r.active ? "Uit" : "Aan"}</button>
                          <button className="btn sm" name="op" value="delete" type="submit" aria-label="Verwijderen"><Icon name="trash" /></button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <details className="more cb"><summary>Regel toevoegen</summary>
              <form action={addRule} className="stack" style={{ marginTop: 8 }}>
                <div className="field"><label htmlFor="r-name">Naam</label><input id="r-name" name="name" /></div>
                <div className="grid2">
                  <div className="field"><label htmlFor="r-cp">Tegenpartij bevat</label><input id="r-cp" name="counterparty" /></div>
                  <div className="field"><label htmlFor="r-ds">Omschrijving bevat</label><input id="r-ds" name="description" /></div>
                  <div className="field"><label htmlFor="r-iban">IBAN</label><input id="r-iban" name="iban" /></div>
                  <div className="field"><label htmlFor="r-dir">Richting</label><select id="r-dir" name="direction"><option value="">Beide</option><option value="in">Ontvangst</option><option value="out">Uitgave</option></select></div>
                  <div className="field"><label htmlFor="r-kind">Actie</label><select id="r-kind" name="kind"><option value="book">Boeken op rekening</option><option value="sale">Verkoop aan bekende klant</option></select></div>
                  <div className="field"><label htmlFor="r-acc">Rekening</label><select id="r-acc" name="accountCode">{accs.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="r-vat">BTW-code</label><select id="r-vat" name="vatCode">{codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
                </div>
                <label className="check"><input type="checkbox" name="autoApply" /> Automatisch toepassen</label>
                <button className="btn" type="submit">Toevoegen</button>
              </form>
            </details>
          </section>
        </div>

        <div className="stack">
          <section id="bunq" className="card">
            <div className="ch"><h2>bunq</h2>{bunq.apiKey ? <Pill tone="g"><Icon name="check" size={14} />Verbonden</Pill> : <Pill tone="a">Niet gekoppeld</Pill>}</div>
            <div className="cb stack">
              {bunq.apiKey ? (
                <dl className="kv small">
                  <dt>Rekening(en)</dt><dd>{banks.map((b) => <div key={b.id}>{b.name} · {formatIban(b.iban)} · {formatEur(b.balanceCents)}</div>)}</dd>
                  <dt>Device</dt><dd>{bunq.permittedIp ? `Vastgezet op ${bunq.permittedIp}` : "Alle IP's (vastzetten aanbevolen)"}</dd>
                  <dt>Sessie</dt><dd>{bunq.sessionCreatedAt ? `Aangemaakt ${new Date(bunq.sessionCreatedAt).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}, vernieuwt automatisch` : "—"}</dd>
                  <dt>Callback</dt><dd className="num">{bunq.callbackRegisteredUrl ?? "niet geregistreerd"}</dd>
                  <dt>Laatste sync</dt><dd>{bunq.lastSyncAt ? new Date(bunq.lastSyncAt).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) : "—"}</dd>
                </dl>
              ) : <div className="small muted">Maak in de bunq-app een API key aan (Profiel › Beveiliging › Developers › API keys). FreeBird leest transacties en maakt bunq.me-betaalverzoeken.</div>}
              <form action={connectBunq} className="stack">
                <div className="field"><label htmlFor="b-key">API key</label><input id="b-key" name="apiKey" type="password" autoComplete="off" placeholder={bunq.apiKey ? "•••••••• (laat leeg om te behouden)" : ""} required={!bunq.apiKey} /></div>
                <div className="field"><label htmlFor="b-ip">Vast IP van je server (optioneel)</label><input id="b-ip" name="permittedIp" defaultValue={bunq.permittedIp ?? ""} /><span className="hint">bunq accepteert de key dan alleen vanaf dit IP</span></div>
                <button className="btn pri" type="submit">{bunq.apiKey ? "Opnieuw koppelen" : "Koppelen"}</button>
              </form>
              {bunq.apiKey ? <form action={bunqFullImport}><button className="btn sm" type="submit">Volledige import vanaf startdatum</button></form> : null}
            </div>
          </section>

          <form id="mail" action={saveMail} className="card">
            <div className="ch"><h2>E-mail</h2>{mail.smtpHost ? <Pill tone="g">Ingesteld</Pill> : <Pill tone="a">Niet ingesteld</Pill>}</div>
            <div className="cb stack">
              <div className="grid2">
                <div className="field"><label htmlFor="m-fn">Afzendernaam</label><input id="m-fn" name="fromName" defaultValue={mail.fromName} /></div>
                <div className="field"><label htmlFor="m-fa">Afzenderadres</label><input id="m-fa" name="fromAddress" type="email" defaultValue={mail.fromAddress} /></div>
              </div>
              <div className="lbl">SMTP (versturen)</div>
              <div className="grid3">
                <div className="field"><label htmlFor="m-sh">Server</label><input id="m-sh" name="smtpHost" defaultValue={mail.smtpHost} /></div>
                <div className="field"><label htmlFor="m-sp">Poort</label><input id="m-sp" name="smtpPort" type="number" defaultValue={mail.smtpPort} /></div>
                <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" name="smtpSecure" defaultChecked={mail.smtpSecure} /> SSL/TLS</label>
                <div className="field"><label htmlFor="m-su">Gebruiker</label><input id="m-su" name="smtpUser" defaultValue={mail.smtpUser} /></div>
                <div className="field" style={{ gridColumn: "span 2" }}><label htmlFor="m-spw">Wachtwoord</label><input id="m-spw" name="smtpPass" type="password" autoComplete="new-password" placeholder={hasSecret(mail.smtpPass) ? "•••••••• (laat leeg om te behouden)" : ""} /></div>
              </div>
              <div className="lbl">IMAP (bonnen, bounces, map Verzonden)</div>
              <div className="grid3">
                <div className="field"><label htmlFor="m-ih">Server</label><input id="m-ih" name="imapHost" defaultValue={mail.imapHost} /></div>
                <div className="field"><label htmlFor="m-ip">Poort</label><input id="m-ip" name="imapPort" type="number" defaultValue={mail.imapPort} /></div>
                <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" name="imapSecure" defaultChecked={mail.imapSecure} /> SSL/TLS</label>
                <div className="field"><label htmlFor="m-iu">Gebruiker</label><input id="m-iu" name="imapUser" defaultValue={mail.imapUser} /></div>
                <div className="field" style={{ gridColumn: "span 2" }}><label htmlFor="m-ipw">Wachtwoord</label><input id="m-ipw" name="imapPass" type="password" autoComplete="new-password" placeholder={hasSecret(mail.imapPass) ? "•••••••• (laat leeg om te behouden)" : ""} /></div>
              </div>
              <div className="grid3">
                <div className="field"><label htmlFor="m-rf">Map bonnen</label><input id="m-rf" name="receiptsFolder" defaultValue={mail.receiptsFolder} /></div>
                <div className="field"><label htmlFor="m-pf">Map verwerkt</label><input id="m-pf" name="processedFolder" defaultValue={mail.processedFolder} /></div>
                <div className="field"><label htmlFor="m-sf">Map verzonden</label><input id="m-sf" name="sentFolder" defaultValue={mail.sentFolder} /></div>
              </div>
              <label className="check"><input type="checkbox" name="watchBounces" defaultChecked={mail.watchBounces} /> Bounces in de inbox herkennen</label>
              <label className="check"><input type="checkbox" name="autoBook" defaultChecked={mail.autoBook} /> Facturen uit de bonnenmap automatisch boeken</label>
              <span className="hint">Tip: maak bij je mailprovider een adres als facturen@jouwbedrijf.nl aan, met een regel die alles naar de bonnenmap verplaatst. Geef dat adres aan je leveranciers. FreeBird boekt een factuur zelf als de leverancier bekend is of de AI heel zeker is, en koppelt hem aan de betaling. Is de betaling al geboekt, dan wordt de factuur alleen als bewijs toegevoegd.</span>
              <div className="row"><button className="btn pri" type="submit">Opslaan</button><button className="btn" type="submit" formAction={testMail}>Verbinding testen</button></div>
            </div>
          </form>

          <form id="algemeen" action={saveGeneral} className="card">
            <div className="ch"><h2>Algemeen</h2></div>
            <div className="cb stack">
              <div className="field"><label htmlFor="g-od">Startdatum administratie</label><input id="g-od" name="openingDate" type="date" defaultValue={general.openingDate} /><span className="hint">Banktransacties vóór deze datum worden niet geïmporteerd. Advies: 1 januari 2027.</span></div>
              <div className="field"><label htmlFor="g-ak">DeepSeek API key</label><input id="g-ak" name="deepseekApiKey" type="password" autoComplete="off" placeholder={aiFromEnv ? "Ingesteld via DEEPSEEK_API_KEY" : hasSecret(general.deepseekApiKey) ? "•••••••• (laat leeg om te behouden)" : ""} /><span className="hint">Voor bonnen uitlezen, boekvoorstellen, controles en vragen. Maak een key op platform.deepseek.com.</span></div>
              <div className="grid2">
                <div className="field"><label htmlFor="g-mt">Moneybird API-token</label><input id="g-mt" name="moneybirdToken" type="password" autoComplete="off" placeholder={hasSecret(general.moneybirdToken) ? "••••••••" : ""} /></div>
                <div className="field"><label htmlFor="g-ma">Moneybird administratie-id</label><input id="g-ma" name="moneybirdAdministrationId" defaultValue={general.moneybirdAdministrationId} /></div>
              </div>
              <Link href="/moneybird" className="small">Overstappen van Moneybird: alles ophalen en overnemen →</Link>
              <button className="btn pri" type="submit">Opslaan</button>
            </div>
          </form>

          <section id="fiscaal" className="card">
            <div className="ch"><h2>Fiscale parameters</h2>
              <form action={copyParams} className="row"><input type="hidden" name="from" value={years[0]} /><button className="btn sm" type="submit">{years[0] + 1} aanmaken</button></form>
            </div>
            <table className="t"><tbody>
              {params.map((p) => (
                <tr key={p.id}><td><span className="num">{p.year}</span> {p.key}<div className="small muted">{p.note}</div></td>
                  <td className="r small num" style={{ maxWidth: 220, overflowWrap: "anywhere" }}>{typeof p.value === "object" ? `${Object.keys(p.value as object).length} landen` : String(p.value)}</td></tr>
              ))}
            </tbody></table>
            <details className="more cb"><summary>Parameter wijzigen</summary>
              <form action={saveParam} className="stack" style={{ marginTop: 8 }}>
                <div className="grid2">
                  <div className="field"><label htmlFor="p-y">Jaar</label><input id="p-y" name="year" type="number" defaultValue={years[0]} /></div>
                  <div className="field"><label htmlFor="p-k">Sleutel</label><select id="p-k" name="key">{[...new Set(params.map((p) => p.key))].map((k) => <option key={k}>{k}</option>)}</select></div>
                </div>
                <div className="field"><label htmlFor="p-v">Waarde (JSON)</label><textarea id="p-v" name="value" className="num" placeholder='120000 of {"DE":1900}' /></div>
                <div className="field"><label htmlFor="p-n">Notitie / bron</label><input id="p-n" name="note" /></div>
                <button className="btn" type="submit">Opslaan</button>
              </form>
            </details>
          </section>

          <section id="grootboek" className="card">
            <div className="ch"><h2>Grootboekrekeningen</h2></div>
            <details className="more cb"><summary>{accs.length} rekeningen tonen</summary>
              <table className="t"><tbody>{accs.map((a) => <tr key={a.code}><td className="num">{a.code}</td><td>{a.name}<div className="small muted">{a.type} · {a.ibCategory ?? "—"}{a.defaultVatCode ? ` · ${a.defaultVatCode}` : ""}</div></td></tr>)}</tbody></table>
            </details>
            <details className="more cb"><summary>Rekening toevoegen</summary>
              <form action={addAccount} className="stack" style={{ marginTop: 8 }}>
                <div className="grid2">
                  <div className="field"><label htmlFor="a-c">Code</label><input id="a-c" name="code" required pattern="\d{4}" /></div>
                  <div className="field"><label htmlFor="a-n">Naam</label><input id="a-n" name="name" required /></div>
                  <div className="field"><label htmlFor="a-t">Soort</label><select id="a-t" name="type"><option value="expense">Kosten</option><option value="revenue">Omzet</option><option value="asset">Activa</option><option value="liability">Passiva</option><option value="equity">Eigen vermogen</option></select></div>
                  <div className="field"><label htmlFor="a-ib">IB-categorie</label><select id="a-ib" name="ib"><option>Andere kosten</option><option>Inkoopkosten</option><option>Auto- en transportkosten</option><option>Huisvestingskosten</option><option>Verkoopkosten</option><option>Afschrijvingen</option><option>Netto-omzet</option><option>Overige opbrengsten</option></select></div>
                  <div className="field"><label htmlFor="a-v">Standaard BTW</label><select id="a-v" name="vat"><option value="">—</option>{codes.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
                </div>
                <button className="btn" type="submit">Toevoegen</button>
              </form>
            </details>
          </section>

          <section className="card">
            <div className="ch"><h2>Achtergrondtaken</h2></div>
            <table className="t"><tbody>
              {jobs.length ? jobs.map((j) => <tr key={j.name}><td>{j.name}<div className="small muted">{j.lastMessage}</div></td><td className="r small">{j.lastRunAt?.toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" })}</td><td className="r">{j.lastStatus === "ok" ? <Pill tone="g">ok</Pill> : <Pill tone="r">{j.lastStatus}</Pill>}</td></tr>)
                : <tr><td className="muted">De worker heeft nog niet gedraaid.</td></tr>}
            </tbody></table>
          </section>
        </div>
      </div>
    </>
  );
}
