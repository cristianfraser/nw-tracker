import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  buildF22Draft,
  capCapitalLosses,
  capitalLossPoolClp,
  computeF22Tax,
  IDPC_RATE,
  igcTax,
  informedDj1922Codes,
  type F22Codes,
} from "./f22Draft.js";
import type { UsdFxDisposalLoader } from "./usdFxTaxGains.js";

const UTA = 800_000;

describe("igcTax", () => {
  it("applies the bracket's rate less its deduction, zero below 13,5 UTA", () => {
    expect(igcTax(10 * UTA, UTA, 2030)).toBe(0);
    // 52 UTA: 13,5% bracket, deduction 4,49 UTA.
    expect(igcTax(52 * UTA, UTA, 2030)).toBeCloseTo(52 * UTA * 0.135 - 4.49 * UTA, 6);
    expect(() => igcTax(52 * UTA, UTA, 2017)).toThrow(/no table/);
    // Above 120 UTA: 35% (AT2018–AT2020) vs the 35% bracket of the current table up to 310 UTA.
    expect(igcTax(200 * UTA, UTA, 2019)).toBeCloseTo(200 * UTA * 0.35 - 23.32 * UTA, 6);
  });
});

describe("computeF22Tax", () => {
  it("runs the chain from income codes to 304", () => {
    const codes = computeF22Tax({ 1098: 40_000_000, 155: 5_000_000, 152: 100, 169: 1_000, 750: 3_000_000, 162: 1_500_000 }, UTA, 2030);
    expect(codes[158]).toBe(44_999_100);
    expect(codes[170]).toBe(41_999_100);
    const igc = Math.round(igcTax(41_999_100, UTA, 2030));
    expect(codes[157]).toBe(igc);
    expect(codes[136]).toBe(Math.round((igc * 100) / 44_999_100));
    expect(codes[304]).toBe(igc - codes[136]! - 1_500_000);
  });

  it("adds crypto gains, foreign income and its gross-up, and takes the foreign tax credit", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const withMore = computeF22Tax({ ...base, 1032: 1_000_000, 1104: 8_500, 748: 1_500, 1018: 1_500 }, UTA, 2030);
    expect(withMore[158]! - plain[158]!).toBe(1_010_000);
    expect(withMore[304]! - plain[304]!).toBe(Math.round(withMore[157]! - plain[157]!) - 1_500);
  });

  it("adds a domestic dividend (105) to the IGC base and takes its IDPC credit (610)", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const withDividend = computeF22Tax({ ...base, 105: 2_000_000, 610: 300_000 }, UTA, 2030);
    expect(withDividend[158]! - plain[158]!).toBe(2_000_000);
    expect(withDividend[304]! - plain[304]!).toBe(withDividend[157]! - plain[157]! - 300_000);
  });

  it("adds the dollars' exchange result (1901, line 58 d) to 158 and leaves its IDPC credit out of 304", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const with1901 = computeF22Tax({ ...base, 1901: 2_000_000 }, UTA, 2030);
    expect(with1901[158]! - plain[158]!).toBe(2_000_000);
    // The IDPC on 1901 is credited back in full: 304 moves only by the IGC on the larger base.
    expect(with1901[304]! - plain[304]!).toBe(with1901[157]! - plain[157]! - (with1901[136]! - plain[136]!));
  });

  it("never puts art. 107 results in the IGC chain", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const art107 = { 1813: 5_000_000, 1814: 5_000_000, 1816: 5_000_000, 1829: 5_000_000, 1830: 500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const withArt107 = computeF22Tax({ ...base, ...art107 }, UTA, 2030);
    for (const c of [158, 170, 157, 136, 304]) expect(withArt107[c]).toBe(plain[c]);
  });
});

describe("capCapitalLosses", () => {
  it("caps 169 at the line-17 pool, foreign income included, never against salary", () => {
    const codes = { 1098: 30_000_000, 1032: 100_000, 1104: 50_000, 169: 400_000 };
    expect(capitalLossPoolClp(codes)).toBe(150_000);
    expect(capCapitalLosses(codes)[169]).toBe(150_000);
    expect(computeF22Tax(capCapitalLosses(codes), 800_000, 2026)[158]).toBe(30_000_000);
  });

  it("leaves a loss the pool absorbs untouched", () => {
    const codes = { 155: 8_700_462, 169: 3_453 };
    expect(capCapitalLosses(codes)[169]).toBe(3_453);
  });

  it("never counts 1901 in the pool: a loss on the dollars' route is lost, not a 169 candidate", () => {
    const codes = { 1098: 30_000_000, 1901: 900_000, 1032: 100_000, 169: 500_000 };
    expect(capitalLossPoolClp(codes)).toBe(100_000);
    expect(capCapitalLosses(codes)[169]).toBe(100_000);
  });

  it("counts a fund's distributions (105) in the pool, never an art. 107 result", () => {
    const codes = { 1098: 30_000_000, 105: 200_000, 1813: 900_000, 1814: 900_000, 169: 500_000 };
    expect(capitalLossPoolClp(codes)).toBe(200_000);
    expect(capCapitalLosses(codes)[169]).toBe(200_000);
  });
});

describe("informedDj1922Codes", () => {
  const AFECTAS =
    "Monto de Distribuciones o Remesas y Devoluciones de Capital, Reajustados ($) / DIVIDENDOS, REMESAS O DISTRIBUCIONES AFECTAS A LOS IMPUESTOS GLOBAL COMPLEMENTARIO Y/O IMPUESTO ADICIONAL";
  const CREDITS = "Créditos para Impuestos Global Completmentario o Adicional / ACUMULADOS A CONTAR DEL 01.01.2017";
  const fields = (over: Record<string, string> = {}) =>
    Object.entries({
      "L: Detalle de Operaciones y Movimientos / Diferencia Obtenida en la Enajenación o Rescate de Cuotas (Actualizada)": "7.000",
      "M: Detalle de Operaciones y Movimientos / Diferencia Obtenida en el Rescate o Enajenación de Cuotas de Fondos de Inversión que cumplen requisitos Art.107 LIR (Actualizada)":
        "123.456",
      [`R: ${AFECTAS} / Con Crédito por IDPC Generados a contar del 01.01.2017`]: "10.000",
      [`S: ${AFECTAS} / Con Crédito por IDPC acumulados hasta el 31.12.2016`]: "2.000",
      [`T: ${AFECTAS} / Con Crédito por Pago de IDPC Voluntario`]: "0",
      [`U: ${AFECTAS} / Sin Derecho a Crédito`]: "300",
      "AB: Monto de Distribuciones o Remesas y Devoluciones de Capital, Reajustados ($) / RENTAS EXENTAS / Rentas exentas de impuestos global complementario (IGC) y/o impuesto adicional (IA)":
        "99.000",
      [`AI: ${CREDITS} / ASOCIADOS A RENTAS AFECTAS / Sin Derecho a Devolución`]: "0",
      [`AJ: ${CREDITS} / ASOCIADOS A RENTAS AFECTAS / Con Derecho a Devolución`]: "0",
      ...over,
    }).map(([field, value]) => ({ field, value }));

  it("reads the art. 107 difference (1813) and the distributions afectas al IGC, all four columns (105)", () => {
    expect(informedDj1922Codes(fields())).toEqual({ 1813: 123_456, 105: 12_300 });
  });

  it("throws on an informed IDPC credit, which the draft does not map yet", () => {
    expect(() =>
      informedDj1922Codes(fields({ [`AJ: ${CREDITS} / ASOCIADOS A RENTAS AFECTAS / Con Derecho a Devolución`]: "4.500" }))
    ).toThrow(/IGC credits informed in AJ/);
  });
});

/**
 * The dollars' exchange result on the draft, both routes, with the tax-lot disposals injected
 * (synthetic — the DB walk is `usdCashTaxLotEvents`' own concern). An informed DJ 1887 salary
 * gives the year a base so the tax chain runs; the reference rows the chain needs (official IPC,
 * December UTM, year-end observado) are inserted only where the test DB has none and removed
 * afterwards. A year the art. 107 draft test does not use, so the two never share rows.
 */
describe("the dollars' exchange result on the F22 draft", () => {
  const NOTE = "vitest-f22-usd-fx";
  const TAX_YEAR = 2023;
  const INCOME_YEAR = 2022;
  const TODAY = "2026-06-01";
  const ACCOUNT = 9_102;
  const insertedIpc: string[] = [];
  let insertedUtm = false;
  let insertedObservado = false;

  const cleanup = () => {
    db.prepare(`DELETE FROM sii_informed_dj WHERE source_file = ?`).run(NOTE);
  };

  beforeAll(() => {
    cleanup();
    const ipc = db.prepare(`INSERT OR IGNORE INTO ipc_official_monthly (month, variation_pct, index_points) VALUES (?, 0.4, ?)`);
    for (let m = 1; m <= 11; m++) {
      const month = `${INCOME_YEAR}-${String(m).padStart(2, "0")}-01`;
      if (ipc.run(month, 100 * 1.004 ** m).changes > 0) insertedIpc.push(month);
    }
    insertedUtm = db.prepare(`INSERT OR IGNORE INTO utm_daily (date, utm_clp) VALUES (?, 60000)`).run(`${INCOME_YEAR}-12-01`).changes > 0;
    insertedObservado =
      db.prepare(`INSERT OR IGNORE INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, 870)`).run(`${INCOME_YEAR}-12-31`).changes > 0;
    const dj = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, 1887, ?, ?, ?)`);
    dj.run(TAX_YEAR, "C: Renta Total Neta Pagada (Art.42 N°1, Ley de la Renta)", "40.000.000", NOTE);
    dj.run(TAX_YEAR, "D: Impuesto Unico Retenido", "1.500.000", NOTE);
  });

  afterAll(() => {
    cleanup();
    const ipc = db.prepare(`DELETE FROM ipc_official_monthly WHERE month = ?`);
    for (const month of insertedIpc) ipc.run(month);
    if (insertedUtm) db.prepare(`DELETE FROM utm_daily WHERE date = ?`).run(`${INCOME_YEAR}-12-01`);
    if (insertedObservado) db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = ?`).run(`${INCOME_YEAR}-12-31`);
  });

  // One realized outflow of 1.000 dollars on 2022-07-15: bought at 800 on 2022-03-10, left at 900 (a gain
  // of 100.000) or at 700 (a loss of 100.000); a fee is listed apart whatever the sign.
  const loaderOf = (proceedsPerUsd: number): UsdFxDisposalLoader => () => ({
    disposals: [
      {
        accountId: ACCOUNT,
        date: `${INCOME_YEAR}-07-15`,
        movementId: 50,
        units: 1000,
        proceeds: 1000 * proceedsPerUsd,
        cost: 800_000,
        gain: 1000 * proceedsPerUsd - 800_000,
        slices: [{ acquiredOn: `${INCOME_YEAR}-03-10`, acquireMovementId: 40, units: 1000, cost: 800_000 }],
        tag: "realized",
      },
      {
        accountId: ACCOUNT,
        date: `${INCOME_YEAR}-08-01`,
        movementId: 51,
        units: 10,
        proceeds: 0,
        cost: 8_000,
        gain: -8_000,
        slices: [{ acquiredOn: `${INCOME_YEAR}-03-10`, acquireMovementId: 40, units: 10, cost: 8_000 }],
        tag: "fee",
      },
    ],
    openLots: [],
  });
  const none: UsdFxDisposalLoader = () => ({ disposals: [], openLots: [] });
  const draftWith = (load: UsdFxDisposalLoader, route: "idpc_1901" | "igc_1032") =>
    buildF22Draft(TAX_YEAR, TODAY, { usdFx: { route, load } });
  const chainCodes = [158, 170, 157, 136, 304, 305, 31];
  const sameButChain = (a: F22Codes, b: F22Codes, except: number[]) => {
    for (const c of new Set([...Object.keys(a), ...Object.keys(b)].map(Number))) {
      if (chainCodes.includes(c) || except.includes(c)) continue;
      expect(b[c], `code ${c}`).toBe(a[c]);
    }
  };

  it("under idpc_1901 a gain is code 1901 in 158 with its IDPC credited back, so 304 moves only through 158", () => {
    const zero = draftWith(none, "idpc_1901");
    const gain = draftWith(loaderOf(900), "idpc_1901");
    expect(zero.base).toBe("informed");
    expect(zero.taxComputed).toBe(true);
    expect(zero.draft[1901] ?? 0).toBe(0);
    expect(zero.usdFxIdpcClp).toBe(0);
    const december = gain.usdFx.resultDecemberClp;
    expect(gain.usdFx.resultClp).toBe(100_000);
    expect(december).toBeGreaterThan(100_000);
    expect(gain.draft[1901]).toBe(Math.round(december));
    expect(gain.usdFxIdpcClp).toBe(Math.round(Math.round(december) * IDPC_RATE));
    expect(gain.estimatedCodes).toContain(1901);
    expect(gain.draft[158]! - zero.draft[158]!).toBe(Math.round(december));
    // Nothing but 1901 and the chain changed: no 169, no 1032, no credit code.
    sameButChain(zero.draft, gain.draft, [1901]);
    // The chain on the gain draft's own codes reproduces its 304: the IDPC credit is outside it.
    const recomputed = computeF22Tax(gain.draft, gain.utaClp, TAX_YEAR);
    expect(recomputed[304]).toBe(gain.draft[304]);
    expect(gain.draft[304]! - zero.draft[304]!).toBe(gain.draft[157]! - zero.draft[157]! - (gain.draft[136]! - zero.draft[136]!));
    expect(gain.usdFx.feesLostClp).toBe(8_000);
    expect(gain.lossOffset.parts.find((p) => p.source === "usd_fx")).toEqual({ source: "usd_fx", gainClp: 0, lossClp: 0 });
  });

  it("under idpc_1901 a loss adds nothing: no code, no 169, the IDPC at zero", () => {
    const zero = draftWith(none, "idpc_1901");
    const loss = draftWith(loaderOf(700), "idpc_1901");
    expect(loss.usdFx.resultClp).toBe(-100_000);
    expect(loss.usdFx.codes).toEqual({});
    expect(loss.usdFxIdpcClp).toBe(0);
    expect(loss.draft).toEqual(zero.draft);
    expect(loss.estimatedCodes).toEqual(zero.estimatedCodes);
    expect(loss.lossOffset.lossesClp).toBe(zero.lossOffset.lossesClp);
  });

  it("under igc_1032 a gain sums with the crypto's 1032", () => {
    const zero = draftWith(none, "igc_1032");
    const gain = draftWith(loaderOf(900), "igc_1032");
    const december = Math.round(gain.usdFx.resultDecemberClp);
    expect(gain.draft[1901] ?? 0).toBe(0);
    expect(gain.usdFxIdpcClp).toBe(0);
    expect(gain.draft[1032]! - (zero.draft[1032] ?? 0)).toBe(december);
    expect(gain.draft[158]! - zero.draft[158]!).toBe(december);
    expect(gain.estimatedCodes).toContain(1032);
    sameButChain(zero.draft, gain.draft, [1032]);
    expect(gain.lossOffset.parts.find((p) => p.source === "usd_fx")).toEqual({ source: "usd_fx", gainClp: december, lossClp: 0 });
  });

  it("under igc_1032 a loss joins 169 within the line-17 pool cap", () => {
    const zero = draftWith(none, "igc_1032");
    const loss = draftWith(loaderOf(700), "igc_1032");
    const december = Math.round(-loss.usdFx.resultDecemberClp);
    expect(december).toBeGreaterThan(100_000);
    expect(loss.usdFx.codes).toEqual({ loss169: december });
    expect(loss.draft[1032] ?? 0).toBe(zero.draft[1032] ?? 0);
    expect(loss.lossOffset.lossesClp).toBe(zero.lossOffset.lossesClp + december);
    expect(loss.lossOffset.parts.find((p) => p.source === "usd_fx")).toEqual({ source: "usd_fx", gainClp: 0, lossClp: december });
    // Capped at the pool: a loss never reaches the salary.
    expect(loss.draft[169] ?? 0).toBe(Math.min(loss.lossOffset.lossesClp, loss.lossOffset.gainsClp));
    expect(loss.draft[169] ?? 0).toBeLessThanOrEqual(capitalLossPoolClp(loss.draft));
    expect(loss.estimatedCodes).toContain(169);
    sameButChain(zero.draft, loss.draft, [169]);
  });
});
