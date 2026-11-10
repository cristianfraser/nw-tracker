import { describe, expect, it } from "vitest";
import { form8621RollForward, form8621Year, type Form8621YearInput } from "./form8621.js";

const holding = { accountId: 1, label: "Fund" };

function year(taxYear: number, over: Partial<Form8621YearInput>): Form8621YearInput {
  return { ...holding, taxYear, arrival: null, events: [], unitsYearEnd: 0, fmvYearEndUsd: 0, ...over };
}

describe("Form 8621 Part IV", () => {
  it("starts from the greater of value and cost on arrival, then includes the gain and tracks it", () => {
    // 100 units: cost 1.000, worth 1.200 on the basis day: basis 1.200; year end 1.500: inclusion 300.
    const [y1] = form8621RollForward([year(2024, { arrival: { startUnits: 100, startCostBasisUsd: 1_000, startFmvUsd: 1_200 }, unitsYearEnd: 100, fmvYearEndUsd: 1_500 })]);
    expect(y1).toMatchObject({ startBasisUsd: 1_200, inclusionUsd: 300, deductionUsd: 0, ordinaryIncomeUsd: 300 });
    expect(y1!.stateOut).toEqual({ units: 100, adjustedBasisUsd: 1_500, unreversedInclusionsUsd: 300 });
    expect(y1!.flags.partVPossible).toBe(true);
    // A holding below cost on arrival starts at cost: no loss is recognised.
    expect(form8621Year(year(2024, { arrival: { startUnits: 100, startCostBasisUsd: 1_000, startFmvUsd: 800 }, unitsYearEnd: 100, fmvYearEndUsd: 900 }), null)).toMatchObject({ startBasisUsd: 1_000, inclusionUsd: 0, deductionUsd: 0, disallowedLossUsd: 100 });
  });

  it("deducts a decline only up to the unreversed inclusions and rolls the basis", () => {
    const years = form8621RollForward([
      year(2024, { arrival: { startUnits: 100, startCostBasisUsd: 1_000, startFmvUsd: 1_000 }, unitsYearEnd: 100, fmvYearEndUsd: 1_300 }), // +300
      year(2025, { unitsYearEnd: 100, fmvYearEndUsd: 1_150 }), // -150: within the 300
      year(2026, { unitsYearEnd: 100, fmvYearEndUsd: 900 }), // -250: only 150 left to reverse
    ]);
    expect(years[1]).toMatchObject({ inclusionUsd: 0, deductionUsd: 150, disallowedLossUsd: 0, ordinaryIncomeUsd: -150 });
    expect(years[1]!.stateOut).toEqual({ units: 100, adjustedBasisUsd: 1_150, unreversedInclusionsUsd: 150 });
    expect(years[2]).toMatchObject({ deductionUsd: 150, disallowedLossUsd: 100, ordinaryIncomeUsd: -150 });
    expect(years[2]!.stateOut).toEqual({ units: 100, adjustedBasisUsd: 1_000, unreversedInclusionsUsd: 0 });
  });

  it("makes a partial sale's gain ordinary on the pro rata adjusted basis, then marks what is left", () => {
    const years = form8621RollForward([
      year(2024, { arrival: { startUnits: 100, startCostBasisUsd: 1_000, startFmvUsd: 1_000 }, unitsYearEnd: 100, fmvYearEndUsd: 1_200 }), // +200: basis 1.200
      year(2025, {
        events: [{ kind: "dispose", date: "2025-06-01", units: 40, proceedsUsd: 600 }], // basis sold 480: gain 120
        unitsYearEnd: 60,
        fmvYearEndUsd: 800, // basis 720: +80
      }),
    ]);
    const y = years[1]!;
    expect(y.disposals[0]).toMatchObject({ basisUsd: 480, ordinaryGainUsd: 120, ordinaryLossUsd: 0, capitalLossUsd: 0 });
    expect(y.inclusionUsd).toBe(80);
    expect(y.ordinaryIncomeUsd).toBe(200);
    // Unreversed: 200 less the 40 % sold = 120, plus 80.
    expect(y.stateOut).toEqual({ units: 60, adjustedBasisUsd: 800, unreversedInclusionsUsd: 200 });
  });

  it("makes a sale's loss ordinary only up to the unreversed inclusions, the rest capital", () => {
    const [, y] = form8621RollForward([
      year(2024, { arrival: { startUnits: 100, startCostBasisUsd: 1_000, startFmvUsd: 1_000 }, unitsYearEnd: 100, fmvYearEndUsd: 1_200 }),
      // All sold for 900: basis 1.200, loss 300; unreversed 200 → ordinary 200, capital 100.
      year(2025, { events: [{ kind: "dispose", date: "2025-03-01", units: 100, proceedsUsd: 900 }], unitsYearEnd: 0, fmvYearEndUsd: 0 }),
    ]);
    expect(y!.disposals[0]).toMatchObject({ ordinaryLossUsd: 200, capitalLossUsd: 100, ordinaryGainUsd: 0 });
    expect(y).toMatchObject({ ordinaryIncomeUsd: -200, capitalLossUsd: 100 });
    expect(y!.stateOut).toEqual({ units: 0, adjustedBasisUsd: expect.closeTo(0, 9), unreversedInclusionsUsd: expect.closeTo(0, 9) });
  });

  it("starts a holding bought in the year at its cost and marks it at the year end", () => {
    const y = form8621Year(year(2025, { events: [{ kind: "acquire", date: "2025-05-01", units: 10, costUsd: 500 }], unitsYearEnd: 10, fmvYearEndUsd: 560 }), null);
    expect(y).toMatchObject({ startBasisUsd: 0, basisBeforeMarkUsd: 500, inclusionUsd: 60 });
    expect(y.flags).toEqual({ partVPossible: false, marketableAssumed: true, foreignCorporationAssumed: true });
  });

  it("fails when the roll-forward units disagree with the year-end position or a sale exceeds the holding", () => {
    expect(() => form8621Year(year(2025, { events: [{ kind: "acquire", date: "2025-05-01", units: 10, costUsd: 500 }], unitsYearEnd: 12, fmvYearEndUsd: 560 }), null)).toThrow(/rolls to 10/);
    expect(() => form8621Year(year(2025, { events: [{ kind: "dispose", date: "2025-05-01", units: 1, proceedsUsd: 5 }], unitsYearEnd: 0 }), null)).toThrow(/sells 1/);
    expect(() => form8621Year(year(2025, { arrival: { startUnits: 1, startCostBasisUsd: 1, startFmvUsd: 1 }, unitsYearEnd: 1, fmvYearEndUsd: 1 }), { units: 1, adjustedBasisUsd: 1, unreversedInclusionsUsd: 0 })).toThrow(/first US year/);
  });
});
