/** Schatting inkomstenbelasting box 1 en Zvw-bijdrage over winst uit onderneming. Bedragen in centen. */

export type IbRates = {
  /** Schijven box 1; de laatste heeft uptoCents null. */
  brackets: { uptoCents: number | null; bp: number }[];
  /** Tarief waartegen ondernemersaftrek en MKB-winstvrijstelling maximaal aftrekbaar zijn. */
  deductionCapBp: number;
  generalCredit: { maxCents: number; phaseOutFromCents: number; phaseOutBp: number };
  /** Arbeidskorting: oplopend per traject, daarna afbouw. */
  labourCredit: { steps: { uptoCents: number; bp: number }[]; phaseOutFromCents: number; phaseOutBp: number };
  zvw: { bp: number; maxBaseCents: number };
};

type IbCalc = {
  bracketTax: { fromCents: number; toCents: number | null; bp: number; taxCents: number }[];
  deductionCapCents: number;
  generalCreditCents: number;
  labourCreditCents: number;
  incomeTaxCents: number;
};

export type IbEstimate = {
  taxableCents: number;
  otherIncomeCents: number;
  /** Berekening over het totale box 1-inkomen (ander inkomen + belastbare winst). */
  combined: IbCalc;
  /** Inkomstenbelasting over alleen het andere inkomen: de loonheffing dekt dit ongeveer. */
  otherIncomeTaxCents: number;
  /** Extra inkomstenbelasting door de winst. */
  incomeTaxCents: number;
  zvwCents: number;
  totalCents: number;
  effectiveBp: number;
};

const pct = (cents: number, bp: number) => Math.round((cents * bp) / 10000);

function calcIb(r: IbRates, income: number, deductions: number): IbCalc {
  let from = 0;
  const bracketTax: IbCalc["bracketTax"] = [];
  for (const b of r.brackets) {
    const to = b.uptoCents;
    const part = Math.max(0, Math.min(income, to ?? Infinity) - from);
    bracketTax.push({ fromCents: from, toCents: to, bp: b.bp, taxCents: pct(part, b.bp) });
    if (to == null) break;
    from = to;
  }
  // Aftrekbeperking: aftrekposten die in de hoogste schijf vallen, leveren alleen het lagere tarief op.
  const top = r.brackets[r.brackets.length - 1];
  const topFrom = r.brackets[r.brackets.length - 2]?.uptoCents ?? 0;
  const inTop = Math.min(deductions, Math.max(0, income + deductions - topFrom));
  const deductionCapCents = pct(inTop, Math.max(0, top.bp - r.deductionCapBp));

  const g = r.generalCredit;
  const generalCreditCents = Math.max(0, g.maxCents - pct(Math.max(0, income - g.phaseOutFromCents), g.phaseOutBp));

  const l = r.labourCredit;
  let labour = 0;
  let lFrom = 0;
  for (const s of l.steps) {
    labour += pct(Math.max(0, Math.min(income, s.uptoCents) - lFrom), s.bp);
    lFrom = s.uptoCents;
  }
  const labourCreditCents = Math.max(0, labour - pct(Math.max(0, income - l.phaseOutFromCents), l.phaseOutBp));

  const gross = bracketTax.reduce((s, b) => s + b.taxCents, 0) + deductionCapCents;
  return { bracketTax, deductionCapCents, generalCreditCents, labourCreditCents, incomeTaxCents: Math.max(0, gross - generalCreditCents - labourCreditCents) };
}

/**
 * Wat de winst extra kost bovenop ander box 1-inkomen (loon). Gaat ervan uit dat de loonheffing
 * de belasting over het loon al dekt, inclusief de heffingskortingen.
 */
export function estimateIncomeTax(r: IbRates, profitCents: number, deductionsCents: number, taxableCents: number, otherIncomeCents = 0): IbEstimate {
  const taxable = Math.max(0, taxableCents);
  const other = Math.max(0, otherIncomeCents);
  const deductions = profitCents > 0 ? Math.max(0, deductionsCents) : 0;
  const combined = calcIb(r, other + taxable, deductions);
  const otherIncomeTaxCents = calcIb(r, other, 0).incomeTaxCents;
  const incomeTaxCents = Math.max(0, combined.incomeTaxCents - otherIncomeTaxCents);
  // De Zvw-bijdrage over loon betaalt de werkgever; over de winst alleen tot het resterende maximum.
  const zvwCents = pct(Math.min(taxable, Math.max(0, r.zvw.maxBaseCents - other)), r.zvw.bp);
  const totalCents = incomeTaxCents + zvwCents;
  return {
    taxableCents: taxable, otherIncomeCents: other, combined, otherIncomeTaxCents, incomeTaxCents, zvwCents, totalCents,
    effectiveBp: profitCents > 0 ? Math.round((totalCents / profitCents) * 10000) : 0,
  };
}
