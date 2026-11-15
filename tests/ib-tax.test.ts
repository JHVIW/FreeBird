import { describe, it, expect } from "vitest";
import { estimateIncomeTax, type IbRates } from "@/lib/ib-tax";

const R: IbRates = {
  brackets: [{ uptoCents: 3_888_300, bp: 3575 }, { uptoCents: 7_842_600, bp: 3756 }, { uptoCents: null, bp: 4950 }],
  deductionCapBp: 3756,
  generalCredit: { maxCents: 311_500, phaseOutFromCents: 2_973_600, phaseOutBp: 639.8 },
  labourCredit: { steps: [{ uptoCents: 1_196_500, bp: 832.4 }, { uptoCents: 2_584_500, bp: 3100.9 }, { uptoCents: 4_559_200, bp: 195 }], phaseOutFromCents: 4_559_200, phaseOutBp: 651 },
  zvw: { bp: 485, maxBaseCents: 7_940_900 },
};

describe("schatting inkomstenbelasting", () => {
  it("geeft nul bij verlies", () => {
    const e = estimateIncomeTax(R, -500_000, 0, 0);
    expect(e.totalCents).toBe(0);
  });
  it("rekent schijven, kortingen en Zvw bij modale winst", () => {
    // winst 50.000, na aftrekken 42.618,40
    const e = estimateIncomeTax(R, 5_000_000, 738_160, 4_261_840);
    expect(e.combined.bracketTax.map((b) => b.taxCents)).toEqual([1_390_067, 140_302, 0]);
    expect(e.combined.deductionCapCents).toBe(0);
    expect(e.combined.labourCreditCents).toBe(562_710);
    expect(e.combined.generalCreditCents).toBe(311_500 - Math.round((4_261_840 - 2_973_600) * 0.06398));
    expect(e.zvwCents).toBe(Math.round(4_261_840 * 0.0485));
    expect(e.totalCents).toBe(e.incomeTaxCents + e.zvwCents);
  });
  it("past de aftrekbeperking toe in de hoogste schijf", () => {
    const e = estimateIncomeTax(R, 12_000_000, 1_500_000, 10_500_000);
    expect(e.combined.deductionCapCents).toBe(Math.round(1_500_000 * 0.1194));
    expect(e.combined.generalCreditCents).toBe(0);
    expect(e.zvwCents).toBe(Math.round(7_940_900 * 0.0485));
  });
  it("rekent de extra belasting bovenop loon", () => {
    const alleen = estimateIncomeTax(R, 0, 0, 0, 4_000_000);
    expect(alleen.totalCents).toBe(0);
    const e = estimateIncomeTax(R, 2_000_000, 0, 2_000_000, 4_000_000);
    // 60.000 totaal: winst valt deels in schijf 2, kortingen bouwen af
    expect(e.combined.incomeTaxCents - e.otherIncomeTaxCents).toBe(e.incomeTaxCents);
    expect(e.incomeTaxCents).toBeGreaterThan(Math.round(2_000_000 * 0.3756));
    // Zvw alleen tot het resterende maximum
    const hoog = estimateIncomeTax(R, 2_000_000, 0, 2_000_000, 7_000_000);
    expect(hoog.zvwCents).toBe(Math.round((7_940_900 - 7_000_000) * 0.0485));
  });
});
