/**
 * The year's two offset pools (`offsets.ts`), called directly with a hand-made tax function so
 * every figure is checkable by hand: a flat 10 % on the line-17 pool codes (1032, 1104, 155) less
 * 169, never negative. The real chain feeds them in `regimeParts.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { capitalLossOffset, foreignShareOffset, type F22TaxOf } from "./offsets.js";
import type { ForeignShareDisposalResult, ForeignShareYearResult } from "./foreignShares.js";
import type { F22Codes } from "./types.js";

const tenPct: F22TaxOf = (c) => Math.max(0, 0.1 * ((c[1032] ?? 0) + (c[1104] ?? 0) + (c[155] ?? 0) - (c[169] ?? 0)));

function lossOffset(draftInput: F22Codes, taxed = true, taxOf: F22TaxOf = tenPct, extra: Partial<Parameters<typeof capitalLossOffset>[0]> = {}) {
  return capitalLossOffset({
    draftInput,
    draft: { 304: taxOf(draftInput) },
    taxOf,
    taxed,
    cryptoGain: 0,
    foreignGain: 0,
    dividendsNetClp: 0,
    declaredLossClp: 0,
    fundLossClp: 0,
    foreignFx1032: 0,
    foreignFxLoss: 0,
    ...extra,
  });
}

describe("capitalLossOffset (the code-169 pool)", () => {
  it("uses the whole loss against a larger pool and prices the gain left as what a loss that size would save", () => {
    // Pool 1.000.000 (1032), loss 300.000: all deducted, 700.000 taxed.
    // draft 304 = 10 % × (1.000.000 − 300.000) = 70.000; with 169 = 300.000 + 700.000 the tax is 0 → effect +70.000.
    const o = lossOffset({ 1032: 1_000_000, 169: 300_000 });
    expect(o).toMatchObject({ gainsClp: 1_000_000, lossesClp: 300_000, deductedClp: 300_000, unusedLossClp: 0, taxedGainClp: 700_000 });
    expect(o.taxEffectClp).toBeCloseTo(70_000, 6);
  });

  it("uses a loss up to the pool and prices the rest as what a pool gain that size would cost", () => {
    // Pool 200.000, loss 500.000: 200.000 deducted, 300.000 unused.
    // With 1032 = 500.000: tax(169 = 200.000) = 10 % × 300.000 = 30.000; tax(169 = 500.000) = 0 → effect +30.000.
    const o = lossOffset({ 1032: 200_000, 169: 500_000 });
    expect(o).toMatchObject({ gainsClp: 200_000, lossesClp: 500_000, deductedClp: 200_000, unusedLossClp: 300_000, taxedGainClp: 0 });
    expect(o.taxEffectClp).toBeCloseTo(30_000, 6);
  });

  it("leaves a loss with no pool wholly unused", () => {
    // Pool 0 (salary is not in it), loss 400.000: tax(1032 = 400.000, 169 = 0) = 40.000 − tax(…, 169 = 400.000) = 0.
    const o = lossOffset({ 1098: 30_000_000, 169: 400_000 });
    expect(o).toMatchObject({ gainsClp: 0, deductedClp: 0, unusedLossClp: 400_000, taxedGainClp: 0 });
    expect(o.taxEffectClp).toBeCloseTo(40_000, 6);
  });

  it("puts the unused loss back as a 1032 gain, not as 1104", () => {
    // A tax that reads 1032 at 10 % and 1104 at 90 %: the unused 100.000 must cost 10.000, not 90.000.
    const weighted: F22TaxOf = (c) => Math.max(0, 0.1 * ((c[1032] ?? 0) - (c[169] ?? 0)) + 0.9 * (c[1104] ?? 0));
    const o = lossOffset({ 169: 100_000 }, true, weighted);
    expect(o.unusedLossClp).toBe(100_000);
    expect(o.taxEffectClp).toBeCloseTo(10_000, 6);
  });

  it("has no tax effect when the loss equals the pool, nor without a tax chain", () => {
    const even = lossOffset({ 1104: 250_000, 169: 250_000 });
    expect(even).toMatchObject({ deductedClp: 250_000, unusedLossClp: 0, taxedGainClp: 0, taxEffectClp: null });
    expect(lossOffset({ 1032: 200_000, 169: 500_000 }, false).taxEffectClp).toBeNull();
    expect(lossOffset({ 1032: 1_000_000 }, false).taxEffectClp).toBeNull();
    expect(lossOffset({}).taxEffectClp).toBeNull();
  });

  it("sums only the positive pool codes 105, 155, 152, 1032, 1104 — not salary, 1901 or a negative 1104", () => {
    // 100 + 200 + 300 + 400 = 1.000 (the −500 of 1104 counts as 0).
    const o = lossOffset({ 105: 100, 155: 200, 152: 300, 1032: 400, 1104: -500, 1098: 9_999_999, 1901: 777 });
    expect(o.gainsClp).toBe(1_000);
    expect(o.lossesClp).toBe(0);
    expect(o.taxedGainClp).toBe(1_000);
  });

  it("splits the pool by source, a crypto loss on the loss side and the fund losses together", () => {
    const o = lossOffset({ 155: 50_000, 152: 20_000, 105: 30_000, 1104: 765_000, 169: 410_000 }, true, tenPct, {
      cryptoGain: -250_000,
      foreignGain: 120_000,
      dividendsNetClp: -5,
      declaredLossClp: 60_000,
      fundLossClp: 40_000,
      foreignFx1032: 15_000,
      foreignFxLoss: 7_000,
    });
    expect(o.parts).toEqual([
      { source: "crypto", gainClp: 0, lossClp: 250_000 },
      { source: "foreign_shares", gainClp: 120_000, lossClp: 0 },
      { source: "foreign_dividends", gainClp: 0, lossClp: 0 },
      // 50.000 + 20.000 + 30.000; losses 60.000 declared + 40.000 of the funds.
      { source: "funds_interest", gainClp: 100_000, lossClp: 100_000 },
      { source: "foreign_fx", gainClp: 15_000, lossClp: 7_000 },
    ]);
    expect(lossOffset({ 1032: 10 }, true, tenPct, { cryptoGain: 10 }).parts[0]).toEqual({ source: "crypto", gainClp: 10, lossClp: 0 });
  });
});

function disposal(usd31dic: number, clpIpc: number): ForeignShareDisposalResult {
  return {
    accountId: 1,
    accountName: "vitest",
    date: "2086-06-01",
    movementId: 1,
    units: 1,
    proceedsUsd: 0,
    costUsd: 0,
    gainUsd: 0,
    resultClp: { usd_31dic: usd31dic, clp_ipc: clpIpc },
  };
}

function shares(results: number[], defaultMode: "usd_31dic" | "clp_ipc" = "usd_31dic", other = 0): ForeignShareYearResult {
  const disposals = results.map((r) => (defaultMode === "usd_31dic" ? disposal(r, other) : disposal(other, r)));
  const total = results.reduce((s, r) => s + r, 0);
  return {
    year: 2086,
    lotMethod: "fifo",
    disposals,
    totalClp: defaultMode === "usd_31dic" ? { usd_31dic: total, clp_ipc: other * results.length } : { usd_31dic: other * results.length, clp_ipc: total },
    defaultMode,
    provisional: false,
    yearEndObservadoDate: "2086-12-31",
  };
}

const only1104: F22TaxOf = (c) => Math.max(0, 0.1 * (c[1104] ?? 0)) + 1_000 * (c[1032] ?? 0);

function shareOffset(results: number[], taxed = true, mode: "usd_31dic" | "clp_ipc" = "usd_31dic", other = 0) {
  const foreignShares = shares(results, mode, other);
  const foreignResult = Math.round(foreignShares.totalClp[mode]);
  const draftInput: F22Codes = { 1104: Math.max(0, foreignResult) };
  return foreignShareOffset({ foreignShares, foreignResult, draftInput, draft: { 304: only1104(draftInput) }, taxOf: only1104, taxed });
}

describe("foreignShareOffset (sales netted among themselves)", () => {
  it("nets a smaller loss against the gains and prices the net gain through 1104", () => {
    // +300.000 and −100.000: result 200.000 in 1104; gains 300.000, losses 300.000 − 200.000 = 100.000, all deducted.
    // 304 = 10 % × 200.000 = 20.000; with 1104 − 200.000 = 0 → 0; effect +20.000.
    const o = shareOffset([300_000, -100_000]);
    expect(o).toMatchObject({ gainsClp: 300_000, lossesClp: 100_000, deductedClp: 100_000, unusedLossClp: 0, taxedGainClp: 200_000 });
    expect(o.taxEffectClp).toBeCloseTo(20_000, 6);
  });

  it("leaves a larger loss unused (it offsets nothing else) and prices it as a 1104 gain", () => {
    // +100.000 and −400.000: result −300.000, 1104 = 0; gains 100.000, losses 400.000, deducted 100.000, unused 300.000.
    // tax(1104 = 300.000) = 30.000 − 304 = 0 → +30.000 (a 1032 bump would read 300 M through the test's tax).
    const o = shareOffset([100_000, -400_000]);
    expect(o).toMatchObject({ gainsClp: 100_000, lossesClp: 400_000, deductedClp: 100_000, unusedLossClp: 300_000, taxedGainClp: 0 });
    expect(o.taxEffectClp).toBeCloseTo(30_000, 6);
  });

  it("at a zero net result has no loss left and no gain taxed", () => {
    const o = shareOffset([100_000, -100_000]);
    expect(o).toEqual({ gainsClp: 100_000, lossesClp: 100_000, deductedClp: 100_000, unusedLossClp: 0, taxedGainClp: 0, taxEffectClp: null });
  });

  it("is empty without sales and has no tax effect without a chain", () => {
    expect(shareOffset([])).toEqual({ gainsClp: 0, lossesClp: 0, deductedClp: 0, unusedLossClp: 0, taxedGainClp: 0, taxEffectClp: null });
    expect(shareOffset([50_000], false)).toMatchObject({ taxedGainClp: 50_000, taxEffectClp: null });
    expect(shareOffset([50_000, -80_000], false)).toMatchObject({ unusedLossClp: 30_000, taxEffectClp: null });
  });

  it("reads the default frame's results and rounds their gains once", () => {
    // clp_ipc frame: gains 100.000,4 + 0,4 = 100.000,8 → 100.001; the usd_31dic figures (999.999) are ignored.
    const o = shareOffset([100_000.4, 0.4, -50_000], true, "clp_ipc", 999_999);
    expect(o.gainsClp).toBe(100_001);
    // result = round(50.000,8) = 50.001 → losses 100.001 − 50.001 = 50.000.
    expect(o.lossesClp).toBe(50_000);
    expect(o.taxedGainClp).toBe(50_001);
  });
});
