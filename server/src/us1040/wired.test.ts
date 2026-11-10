import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { assertReadsEarlierReturn, taxReturnOrderFor } from "../taxReturnOrder.js";
import type { Form8621Result } from "./form8621.js";
import { usdClpYearlyAverage } from "./fx.js";
import { scheduleE } from "./scheduleE.js";
import { foreignTaxCredit, pficCapitalLossRows, rentalsAfterPassiveLimit, PFIC_CAPITAL_LOSS_TERM } from "./wired.js";

const YEAR = 2097; // a year no fixture person reaches

function rental(net: number) {
  const inputs = [
    {
      slug: "x",
      label: "X",
      window: { fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-12-31` },
      rentsUsd: 10_000,
      expensesUsd: { managementFees: 0, mortgageInterest: 10_000 - net, insurance: 0, taxes: 0, utilities: 0, other: 0 },
      depreciation: {
        placedInServiceDate: `${YEAR}-01-01`,
        basisUsd: 0,
        basisOrigin: "purchase_cost" as const,
        usPersonSince: `${YEAR}-01-01`,
        valueAtUsPersonSinceUsd: null,
      },
    },
  ];
  return { inputs, scheduleE: scheduleE(inputs) };
}

describe("the 1040's wiring", () => {
  it("passes a rental loss through Form 8582 at the year's MAGI, suspends what the allowance does not cover, and a gain absorbs the carry", () => {
    // MAGI 120.000: the allowance is 25.000 − 50 % × 20.000 = 15.000.
    const loss = rentalsAfterPassiveLimit(rental(-20_000), "single", 120_000, 0);
    expect(loss.form8582).toMatchObject({ allowanceUsd: 15_000, allowedLossUsd: 15_000, suspendedLossUsd: 5_000 });
    expect(loss.line5).toBe(-15_000);
    // Above 150.000 nothing passes; next year's 3.000 of income absorbs 3.000 of the carry.
    const high = rentalsAfterPassiveLimit(rental(-2_000), "single", 160_000, 5_000);
    expect(high).toMatchObject({ line5: 0, form8582: { suspendedLossUsd: 7_000 } });
    const gain = rentalsAfterPassiveLimit(rental(3_000), "single", 160_000, 7_000);
    expect(gain).toMatchObject({ line5: 0, form8582: { priorLossAbsorbedUsd: 3_000, suspendedLossUsd: 4_000 } });
    // No place and nothing carried: no form.
    expect(rentalsAfterPassiveLimit({ inputs: [], scheduleE: scheduleE([]) }, "single", 100_000, 0)).toMatchObject({ form8582: null, line5: 0 });
  });

  it("turns a PFIC sale's capital part into a Form 8949 row (h = d − e)", () => {
    const r = {
      label: "Fund",
      disposals: [
        { date: `${YEAR}-05-01`, units: 10, proceedsUsd: 800.4, basisUsd: 1_000, ordinaryGainUsd: 0, ordinaryLossUsd: 50, capitalLossUsd: 149.6 },
        { date: `${YEAR}-06-01`, units: 1, proceedsUsd: 90, basisUsd: 80, ordinaryGainUsd: 10, ordinaryLossUsd: 0, capitalLossUsd: 0 },
      ],
    } as unknown as Form8621Result;
    expect(pficCapitalLossRows([r], YEAR)).toEqual([
      expect.objectContaining({ proceeds: 800, cost: 950, gain: -150, term: PFIC_CAPITAL_LOSS_TERM, box: "F", source: "pfic", sold: `${YEAR}-05-01` }),
    ]);
  });

  describe("Form 1116", () => {
    beforeAll(() => {
      const ins = db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
      ins.run(`${YEAR}-03-01`, 900);
      ins.run(`${YEAR}-09-01`, 1_000);
    });
    afterAll(() => void db.prepare(`DELETE FROM fx_daily WHERE date LIKE ?`).run(`${YEAR}-%`));

    const chile = (adicionalClp: number, unicoArt107Clp = 0) => ({
      taxYear: YEAR + 1,
      window: { fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-12-31` },
      adicionalClp,
      adicionalSource: "filed" as const,
      unicoArt107Clp,
    });
    const base = {
      taxYear: YEAR,
      rateThroughYmd: `${YEAR}-12-31`,
      foreignPassiveGrossUsd: 12_000,
      foreignPassiveDeductionsUsd: 10_000,
      taxableIncomeUsd: 100_000,
      usTaxBeforeCreditsUsd: 18_000,
      carryoversIn: [],
    };

    it("translates the accrued Adicional at the year's average rate, credits up to the limit, carries the rest; the único is not creditable", () => {
      expect(usdClpYearlyAverage(YEAR)).toBe(950);
      const f = foreignTaxCredit({ ...base, chile: chile(950_000, 95_000) })!;
      expect(f.rateClpPerUsd).toBe(950);
      expect(f.classified.map((c) => [c.item, c.amountUsd, c.creditable])).toEqual([
        ["adicional_on_rent", 1_000, true],
        ["unico_on_etf_sale", 100, false],
      ]);
      // Limit 2.000 ÷ 100.000 × 18.000 = 360.
      expect(f.credit).toBe(360);
      expect(f.result.carryoversOut).toEqual([{ taxYear: YEAR, amountUsd: 640 }]);
    });

    it("has no form without Chilean taxes or carryovers; a carryover alone still uses the year's limit", () => {
      expect(foreignTaxCredit({ ...base, chile: null })).toBeNull();
      expect(foreignTaxCredit({ ...base, chile: chile(0) })).toBeNull();
      const f = foreignTaxCredit({ ...base, chile: null, carryoversIn: [{ taxYear: YEAR - 1, amountUsd: 500 }] })!;
      expect(f.credit).toBe(360);
      expect(f.result.carryoversOut).toEqual([{ taxYear: YEAR - 1, amountUsd: 140 }]);
    });
  });

  it("lets each return read the other only when the one it reads comes first", () => {
    expect(taxReturnOrderFor({ incomeYear: YEAR, cl: "full", us: "none", declared: true, periods: [] })).toEqual(["f1040", "f22"]);
    expect(taxReturnOrderFor({ incomeYear: YEAR, cl: { through: `${YEAR}-04-14` }, us: { from: `${YEAR}-04-15` }, declared: true, periods: [] })).toEqual(["f22", "f1040"]);
    // YEAR is undeclared (a Chilean-resident year): the F22 may read the 1040, not the other way round.
    expect(() => assertReadsEarlierReturn("f22", "f1040", YEAR)).not.toThrow();
    expect(() => assertReadsEarlierReturn("f1040", "f22", YEAR)).toThrow(/1040 2097 reads the F22 of the same year, which comes after it \(taxReturnOrder: f1040 → f22\)/);
  });
});
