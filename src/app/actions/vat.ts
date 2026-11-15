"use server";
import { run } from "@/lib/action";
import { fileVatPeriod } from "@/lib/reports";
import { formatEur } from "@/lib/money";
import { runVatReview } from "@/lib/ai-review";

export async function fileVat(fd: FormData) {
  const y = Number(fd.get("year")), q = Number(fd.get("quarter"));
  await run(`/btw?y=${y}&q=${q}`, async () => {
    if (fd.get("confirm") !== "on") throw new Error("Bevestig dat je de aangifte hebt ingediend");
    const r = await fileVatPeriod(y, q);
    return { ok: `Q${q} ${y} vergrendeld. Te betalen: ${formatEur(r.payableCents)}` };
  });
}

export async function vatReviewAction(fd: FormData) {
  const y = Number(fd.get("year")), q = Number(fd.get("quarter"));
  await run(`/btw?y=${y}&q=${q}#controle`, async () => {
    const r = await runVatReview(y, q);
    return { ok: r.findings.length ? `AI-controle klaar: ${r.findings.length} aandachtspunt(en)` : "AI-controle klaar: niets gevonden" };
  });
}
