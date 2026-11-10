/**
 * The pure form modules of the 1040 (`us1040/`), each against the form's own arithmetic on a worked
 * example built line by line: Schedule B, Form 8949's term and box, Schedule D with the loss limit
 * and the carryover worksheet, the Qualified Dividends and Capital Gain Tax Worksheet at each rate,
 * Form 8960, Schedule 2, the dual-status statement, the return order and the treaty's withholding
 * date.
 */
import { describe, expect, it } from "vitest";
import { dualStatusStatement, usResidencyOfYear } from "./dualStatus.js";
import { assertForm8949Row, form8949Box, form8949Rows, type Form8949Lot } from "./form8949.js";
import { form8960 } from "./form8960.js";
import { assertF1040Identities, computeF1040Lines, f1040PrintedLine, f1040RoleOfPrintedLine, type F1040Inputs } from "./identities.js";
import { qualifiedDividendsWorksheet } from "./qualifiedDividendsWorksheet.js";
import { schedule1 } from "./schedule1.js";
import { schedule2 } from "./schedule2.js";
import { scheduleB } from "./scheduleB.js";
import { capitalLossCarryoverOut, scheduleD, scheduleDNetCapitalGainForWorksheet } from "./scheduleD.js";
import { taxReturnOrderFor } from "../taxReturnOrder.js";
import type { YearResidency } from "../taxResidency.js";
import { usBracketTax, usDividendWithholdingRateForChileanResident, usForm1040Tax, usTaxYear } from "../usLegalParameters.js";

const tax2024 = (t: number) => usForm1040Tax(t, "single", 2024);

describe("Schedule B", () => {
  it("lists payers, totals lines 2/4 and 6, keeps 3a within 3b and refuses a negative amount", () => {
    const b = scheduleB({
      interest: [
        { payer: "Bank", date: "2025-01-31", movementId: 1, usd: 10.4 },
        { payer: "Bank", date: "2025-02-28", movementId: 2, usd: 10.4 },
        { payer: "Broker", date: "2025-03-31", movementId: 3, usd: 3.3 },
      ],
      dividends: [
        { payer: "SPY", date: "2025-03-08", movementId: 4, usd: 25.5, qualified: true },
        { payer: "SPY", date: "2025-06-08", movementId: 5, usd: 25.5, qualified: true },
        { payer: "SGOV", date: "2025-06-02", movementId: 6, usd: 40, qualified: false },
      ],
      foreignAccount: true,
    });
    expect(b.interestRows).toEqual([
      { payer: "Bank", items: 2, usd: 21 },
      { payer: "Broker", items: 1, usd: 3 },
    ]);
    expect(b.line2).toBe(24);
    expect(b.line4).toBe(24);
    expect(b.line6).toBe(91);
    expect(b.qualifiedDividends).toBe(51);
    expect(b.foreignAccount).toBe(true);
    // Every dividend qualified, rounded per payer: 3a never exceeds 3b.
    const all = scheduleB({
      interest: [],
      dividends: [
        { payer: "A", date: "2025-01-01", movementId: 1, usd: 0.4, qualified: true },
        { payer: "B", date: "2025-01-01", movementId: 2, usd: 0.4, qualified: true },
      ],
      foreignAccount: false,
    });
    expect(all.line6).toBe(0);
    expect(all.qualifiedDividends).toBe(0);
    expect(() => scheduleB({ interest: [{ payer: "x", date: "2025-01-01", movementId: 9, usd: -1 }], dividends: [], foreignAccount: false })).toThrow(/negative interest/);
  });
});

describe("Form 8949", () => {
  const lot = (over: Partial<Form8949Lot> = {}): Form8949Lot => ({
    instrument: "SPY",
    unitLabel: "sh.",
    sold: "2025-06-02",
    movementId: 7,
    units: 15,
    proceedsUsd: 1950,
    slices: [
      { acquiredOn: "2024-05-01", units: 10, costUsd: 1000 },
      { acquiredOn: "2024-07-01", units: 5, costUsd: 600 },
    ],
    reportedOn1099B: true,
    digitalAsset: false,
    source: "equity",
    ...over,
  });

  it("splits a sale by holding term, the proceeds by units, and picks the box by broker and year", () => {
    const rows = form8949Rows([lot()], 2025);
    expect(rows).toEqual([
      expect.objectContaining({ term: "short_term", box: "A", acquired: "2024-07-01", proceeds: 650, cost: 600, gain: 50 }),
      expect.objectContaining({ term: "long_term", box: "D", acquired: "2024-05-01", proceeds: 1300, cost: 1000, gain: 300 }),
    ]);
    for (const r of rows) assertForm8949Row(r);
    // A broker abroad: no 1099-B → C / F; a coin from 2025 → the digital-asset boxes I / L, C / F in 2024.
    expect(form8949Box("short_term", { reportedOn1099B: false, digitalAsset: false }, 2025)).toBe("C");
    expect(form8949Box("long_term", { reportedOn1099B: false, digitalAsset: false }, 2025)).toBe("F");
    expect(form8949Box("short_term", { reportedOn1099B: false, digitalAsset: true }, 2025)).toBe("I");
    expect(form8949Box("long_term", { reportedOn1099B: false, digitalAsset: true }, 2025)).toBe("L");
    expect(form8949Box("long_term", { reportedOn1099B: false, digitalAsset: true }, 2024)).toBe("F");
    // Exactly one year is still short-term (held MORE than one year is long).
    expect(form8949Rows([lot({ sold: "2025-05-01", slices: [{ acquiredOn: "2024-05-01", units: 15, costUsd: 1600 }] })], 2025)[0]!.term).toBe("short_term");
    expect(() => form8949Rows([lot({ units: 16 })], 2025)).toThrow(/slices hold/);
    expect(() => assertForm8949Row({ ...rows[0]!, gain: 1 })).toThrow(/h = 1/);
  });
});

describe("Schedule D and the capital loss carryover", () => {
  const row = (term: "short_term" | "long_term", gain: number) => ({
    description: "x",
    acquired: "2024-01-01",
    sold: "2025-01-01",
    proceeds: Math.max(gain, 0),
    cost: Math.max(-gain, 0),
    adjustmentCode: null,
    adjustment: 0,
    gain,
    term,
    box: term === "short_term" ? ("C" as const) : ("F" as const),
    source: "equity",
    movementId: null,
  });

  it("nets the parts, limits a loss to US$3.000 and carries the rest by character", () => {
    const d = scheduleD([row("short_term", -5_000), row("long_term", 1_000)], { shortTerm: 0, longTerm: 0 }, 3_000);
    expect(d.lines).toMatchObject({ "3": -5_000, "7": -5_000, "10": 1_000, "15": 1_000, "16": -4_000, "21": -3_000 });
    expect(d.form1040Line7).toBe(-3_000);
    // Worksheet: 1 = 50.000, 2 = 3.000, 3 = 53.000, 4 = 3.000; short: 5 = 5.000, 6 = 1.000, 7 = 4.000, 8 = 1.000.
    expect(capitalLossCarryoverOut(d, 50_000)).toEqual({ shortTerm: 1_000, longTerm: 0 });
    // With negative taxable income the deduction used is smaller and more carries.
    expect(capitalLossCarryoverOut(d, -2_000)).toEqual({ shortTerm: 3_000, longTerm: 0 });
    expect(scheduleDNetCapitalGainForWorksheet(d)).toBe(0);
  });

  it("brings last year's carryover onto lines 6 and 14 and a gain to line 7 whole", () => {
    const d = scheduleD([row("long_term", 10_000)], { shortTerm: 1_000, longTerm: 2_000 }, 3_000);
    expect(d.lines).toMatchObject({ "6": -1_000, "7": -1_000, "14": -2_000, "15": 8_000, "16": 7_000, "21": 0 });
    expect(d.form1040Line7).toBe(7_000);
    expect(scheduleDNetCapitalGainForWorksheet(d)).toBe(7_000);
    expect(capitalLossCarryoverOut(d, 80_000)).toEqual({ shortTerm: 0, longTerm: 0 });
    // A long-term loss carried: 9 = 6.000, 10 = 0, 11 = max(0, 3.000 − 0) = 3.000, 12 = 3.000, 13 = 3.000.
    const long = scheduleD([row("long_term", -6_000)], { shortTerm: 0, longTerm: 0 }, 3_000);
    expect(capitalLossCarryoverOut(long, 60_000)).toEqual({ shortTerm: 0, longTerm: 3_000 });
  });
});

describe("the Qualified Dividends and Capital Gain Tax Worksheet", () => {
  const edges2024 = usTaxYear(2024).capitalGainBrackets.single;

  it("taxes the preferential part at 15 % above the ordinary income (single 2024, taxable 60.000, 3.000 qualified, 7.000 gain)", () => {
    const w = qualifiedDividendsWorksheet({ taxableIncome: 60_000, qualifiedDividends: 3_000, netCapitalGain: 7_000, edges: edges2024, taxOn: tax2024 });
    // 4 = 10.000; 5 = 50.000; 6 = 47.025; 7 = 47.025; 8 = 47.025; 9 = 0; 10 = 10.000; 12 = 10.000;
    // 14 = 60.000; 15 = 50.000; 16 = 10.000; 17 = 10.000; 18 = 1.500; 20 = 0; 22 = the Tax Table on 50.000.
    expect(w).toMatchObject({ "4": 10_000, "5": 50_000, "7": 47_025, "8": 47_025, "9": 0, "12": 10_000, "15": 50_000, "16": 10_000, "17": 10_000, "18": 1_500, "20": 0, "21": 0 });
    // Tax Table 2024, single: 50.000–50.050 → 6.059; 60.000–60.050 → 8.259 (the brackets' tax on each row's midpoint).
    expect(w["22"]).toBe(6_059);
    expect(w["24"]).toBe(8_259);
    expect(w["23"]).toBe(7_559);
    expect(w["25"]).toBe(7_559);
  });

  it("taxes it at 0 % below the edge and at 20 % above the 15 % edge", () => {
    const zero = qualifiedDividendsWorksheet({ taxableIncome: 40_000, qualifiedDividends: 5_000, netCapitalGain: 0, edges: edges2024, taxOn: tax2024 });
    expect(zero).toMatchObject({ "5": 35_000, "7": 40_000, "8": 35_000, "9": 5_000, "12": 0, "17": 0, "18": 0, "20": 0 });
    expect(zero["25"]).toBe(tax2024(35_000));
    const high = qualifiedDividendsWorksheet({ taxableIncome: 600_000, qualifiedDividends: 0, netCapitalGain: 200_000, edges: edges2024, taxOn: tax2024 });
    // 5 = 400.000; 9 = 0; 14 = 518.900; 16 = 118.900; 17 = 118.900; 18 = 17.835; 20 = 81.100; 21 = 16.220.
    expect(high).toMatchObject({ "5": 400_000, "9": 0, "14": 518_900, "16": 118_900, "17": 118_900, "18": 17_835, "20": 81_100, "21": 16_220 });
    expect(high["22"]).toBe(Math.round(usBracketTax(400_000, usTaxYear(2024).brackets.single)));
    expect(high["22"]).toBe(110_375);
    expect(high["25"]).toBe(17_835 + 16_220 + 110_375);
    expect(high["24"]).toBe(180_375);
  });
});

describe("Form 8960, Schedules 1 and 2", () => {
  it("taxes the smaller of NII and MAGI over the threshold at 3,8 %", () => {
    const base = { taxableInterest: 1_000, ordinaryDividends: 4_000, rentalNet: 0, capitalGain: 5_000, pficInclusions: 0, other: 0, threshold: 200_000, rate: 0.038 };
    expect(form8960({ ...base, magi: 250_000 })).toMatchObject({ "8": 10_000, "12": 10_000, "15": 50_000, "16": 10_000, "17": 380 });
    expect(form8960({ ...base, magi: 205_000 })).toMatchObject({ "15": 5_000, "16": 5_000, "17": 190 });
    expect(form8960({ ...base, magi: 150_000 })["17"]).toBe(0);
    // A net loss floors NII at 0; the §1296 inclusions join the net gain (line 5a).
    expect(form8960({ ...base, capitalGain: -3_000, ordinaryDividends: 0, taxableInterest: 0, magi: 300_000 })["12"]).toBe(0);
    expect(form8960({ ...base, pficInclusions: 2_000, magi: 300_000 })["5a"]).toBe(7_000);
  });

  it("adds Schedule 1's line 10 and Schedule 2's line 21", () => {
    expect(schedule1({ rentalRealEstate: -500, pficMarkToMarket: 1_200, otherIncome: 0 })).toEqual({ "5": -500, "8z": 1_200, "9": 1_200, "10": 700, "26": 0 });
    expect(schedule2({ additionalMedicareTax: 90, netInvestmentIncomeTax: 380 })).toEqual({ "3": 0, "11": 90, "12": 380, "21": 470 });
  });
});

describe("the 1040's own arithmetic with the schedules' lines", () => {
  const inputs: F1040Inputs = {
    wages1a: 100_000,
    taxExemptInterest2a: 0,
    interest2b: 500,
    qualifiedDividends3a: 300,
    ordinaryDividends3b: 800,
    capitalGain7: -3_000,
    additionalIncome8: 1_200,
    adjustments10: 0,
    deduction12: 0,
    qbiDeduction13: 0,
    additionalDeductions13b: 0,
    taxOn: tax2024,
    schedule2Part1_17: 0,
    childTaxCredit19: 0,
    schedule3Nonrefundable20: 400,
    otherTaxes23: 120,
    withholdingW2_25a: 15_000,
    withholding1099_25b: 0,
    withholdingOther25c: 60,
    schedule3Credits31: 0,
  };

  it("adds 3b, 7 and 8 into line 9, credits line 20 and checks 3a ≤ 3b", () => {
    const l = computeF1040Lines(inputs);
    expect(l["9"]).toBe(100_000 + 500 + 800 - 3_000 + 1_200);
    expect(l["15"]).toBe(l["9"]);
    expect(l["21"]).toBe(400);
    expect(l["22"]).toBe(l["16"] - 400);
    expect(l["24"]).toBe(l["22"] + 120);
    expect(l["25d"]).toBe(15_060);
    expect(() => assertF1040Identities(l, "ok", 2024)).not.toThrow();
    expect(() => assertF1040Identities({ ...l, "3a": 900 }, "bad")).toThrow(/3a \(900\) exceeds line 3b/);
    expect(() => computeF1040Lines({ ...inputs, qualifiedDividends3a: 801 })).toThrow(/exceed the ordinary dividends/);
    expect(() => assertF1040Identities({ ...l, "9": l["9"] + 1 }, "bad")).toThrow(/line 9 is/);
  });

  it("prints line 7 as 7a on the 2025 form", () => {
    expect(f1040PrintedLine("7", 2024)).toBe("7");
    expect(f1040PrintedLine("7", 2025)).toBe("7a");
    expect(f1040RoleOfPrintedLine("7a", 2025)).toBe("7");
    expect(() => f1040RoleOfPrintedLine("7", 2025)).toThrow(/prints no line 7/);
    expect(() => f1040RoleOfPrintedLine("7a", 2024)).toThrow(/prints no line 7a/);
  });
});

describe("the dual-status year", () => {
  const year = (cl: YearResidency["cl"], us: YearResidency["us"], declared = true): YearResidency => ({ incomeYear: 2024, cl, us, declared, periods: [] });

  it("reads the residency kind and taxes the nonresident part's US dividends at the rate in force on each pay day", () => {
    expect(usResidencyOfYear(year({ through: "2024-04-14" }, { from: "2024-04-15" }))).toEqual({ kind: "dual_status", from: "2024-04-15" });
    expect(usResidencyOfYear(year("none", "full"))).toEqual({ kind: "full", from: null });
    expect(usResidencyOfYear(year("full", "none"))).toEqual({ kind: "nonresident", from: null });
    expect(usResidencyOfYear(year("full", "none", false))).toEqual({ kind: "undeclared", from: null });
    const s = dualStatusStatement(
      "2024-04-15",
      [
        { date: "2024-01-08", movementId: 1, instrument: "SPY", grossUsd: 100, withheldUsd: 30 },
        { date: "2024-03-08", movementId: 2, instrument: "MSFT", grossUsd: 50, withheldUsd: 7.5 },
      ],
      usDividendWithholdingRateForChileanResident
    );
    expect(s.rows.map((r) => [r.ratePct, r.taxUsd])).toEqual([[30, 30], [15, 7.5]]);
    expect(s).toMatchObject({ grossUsd: 150, tax: 38, withheld: 38 });
    expect(() => dualStatusStatement("2024-04-15", [{ date: "2024-04-15", movementId: 3, instrument: "SPY", grossUsd: 1, withheldUsd: 0 }], usDividendWithholdingRateForChileanResident)).toThrow(/not before/);
  });

  it("withholds 30 % before the convention's withholding date and 15 % from it", () => {
    expect(usDividendWithholdingRateForChileanResident("2024-01-31")).toBe(0.3);
    expect(usDividendWithholdingRateForChileanResident("2024-02-01")).toBe(0.15);
    expect(() => usDividendWithholdingRateForChileanResident("2024-2-1")).toThrow(/not YYYY-MM-DD/);
  });

  it("orders the returns: the 1040 first in a Chilean-resident year, the F22 first in a split or non-resident one", () => {
    expect(taxReturnOrderFor(year("full", "none", false))).toEqual(["f1040", "f22"]);
    expect(taxReturnOrderFor(year("full", "none"))).toEqual(["f1040", "f22"]);
    expect(taxReturnOrderFor(year({ through: "2024-04-14" }, { from: "2024-04-15" }))).toEqual(["f22", "f1040"]);
    expect(taxReturnOrderFor(year("none", "full"))).toEqual(["f22", "f1040"]);
  });
});
