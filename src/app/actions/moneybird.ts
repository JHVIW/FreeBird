"use server";
import { run, fstr, fbool } from "@/lib/action";
import { requestFetch } from "@/lib/moneybird-fetch";
import { suggestMapping, saveMapping, runOvername, undoOvername } from "@/lib/moneybird-overname";

const B = "/moneybird";

export async function mbFetchAction() {
  await run(B, async () => ({ ok: (await requestFetch()) ? "Ophalen gestart. Dit loopt op de achtergrond; je kunt de pagina sluiten." : "Het ophalen loopt al" }));
}

export async function mbSuggestMapping() {
  await run(`${B}#koppeling`, async () => {
    const r = await suggestMapping();
    return { ok: r.ledger || r.tax ? `AI koppelde ${r.ledger} rekening(en) en ${r.tax} tarief/tarieven. Controleer ze.` : "Alles was al gekoppeld" };
  });
}

export async function mbSaveMapping(fd: FormData) {
  await run(`${B}#koppeling`, async () => {
    const ledger: Record<string, string> = {}, tax: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v !== "string" || !v) continue;
      if (k.startsWith("ledger_")) ledger[k.slice(7)] = v;
      if (k.startsWith("tax_")) tax[k.slice(4)] = v;
    }
    await saveMapping(ledger, tax);
  }, "Koppeling opgeslagen");
}

export async function mbRunOvername(fd: FormData) {
  await run(`${B}#overnemen`, async () => {
    if (!fbool(fd, "confirm")) throw new Error("Vink aan dat je het voorbeeld hebt gecontroleerd");
    const r = await runOvername({ takeYear: fbool(fd, "takeYear"), fileQuarters: fd.getAll("quarters").map(String) });
    return { ok: `Overgenomen: ${r.entries} boekingen, ${r.invoices} facturen, ${r.receipts} inkoopdocumenten${r.evidence ? `, ${r.evidence} als bewijs gekoppeld` : ""}${r.skipped ? `, ${r.skipped} overgeslagen` : ""}` };
  });
}

export async function mbUndo(fd: FormData) {
  await run(`${B}#overnemen`, async () => {
    if (fstr(fd, "confirm") !== "on") throw new Error("Vink aan dat je de overname ongedaan wilt maken");
    await undoOvername();
  }, "Overname ongedaan gemaakt. Het archief blijft bewaard.");
}
