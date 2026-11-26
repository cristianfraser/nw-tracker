/**
 * The two regimes of a year called directly on hand-made window blocks (`resident.ts`,
 * `nonresident.ts`), the crypto block over a synthetic coin account (`crypto.ts`) and a year's
 * setup under a declared departure (`year.ts`). Income year 2086 (AT2087): far enough that no other
 * suite writes it, past the last published IPC month so every reajuste is 0 % — the figures below
 * are the codes' own arithmetic. IGC table AT2021+ (`legalParameters.ts`), UTA 800.000:
 * 8 % bracket from 30 to 50 UTA with a 1,74 UTA rebaja (1.392.000).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { checkingAccountId } from "../checkingCartolaImport.js";
import { deleteCheckingIncomeMovementOverride, upsertCheckingIncomeMovementOverride } from "../flowsCheckingIncomeOverrides.js";
import { createRealEstatePlace } from "../flowsRealEstateExpenses.js";
import { wholeYearWindow, type DateWindow } from "../dateWindow.js";
import type { F22WindowBlocks, F22YearContext } from "./blocks.js";
import { cryptoTaxGainsForYear } from "./crypto.js";
import { nonresidentPart } from "./nonresident.js";
import { residentPart, type F22ResidentInput } from "./resident.js";
import { f22TaxOnUsWindow, f22Year } from "./year.js";
import type { F22DividendLine } from "./types.js";

const YEAR = 2086;
const TAX_YEAR = YEAR + 1;
const UTA = 800_000;
const OBSERVADO = 900;
const WHOLE = wholeYearWindow(YEAR);

function emptyBlocks(window: DateWindow = WHOLE): F22WindowBlocks {
  return {
    window,
    salary: { incomeYear: YEAR, months: 0, taxablePayClp: 0, withheldTaxClp: 0, incompleteMonths: [], provisional: false },
    feeReceipts: { receipts: 0, grossClp: 0, retentionClp: 0 },
    crypto: { incomeYear: YEAR, method: "average", feePolicy: "excluded", sales: [], proceedsClp: 0, gainDecemberClp: 0, provisional: false, reajusteToMonth: `${YEAR}-11` },
    dividends: [],
    foreignShares: { year: YEAR, lotMethod: "fifo", disposals: [], totalClp: { usd_31dic: 0, clp_ipc: 0 }, defaultMode: "usd_31dic", provisional: false, yearEndObservadoDate: `${YEAR}-12-31` },
    art107: {
      taxYear: TAX_YEAR,
      incomeYear: YEAR,
      gains: {
        year: YEAR,
        lotMethod: "fifo",
        disposals: [],
        inrDisposals: [],
        totalClp: { cost_paid: 0, close_dec31: 0 },
        defaultOption: "cost_paid",
        byKindClp: { fund: 0, share: 0 },
        provisional: false,
      },
      carry: { clp: 0, source: null },
      codes: { 1809: 0, 1813: 0, 1814: 0, 1815: 0, 1816: 0, 1829: 0, 1830: 0 },
    },
    art107Distributions: [],
    foreignFx: {
      incomeYear: YEAR,
      route: "idpc_1901",
      posture: "oficio_2573",
      purchaseCost: "observado",
      disposals: [],
      fees: [],
      feesLostClp: 0,
      deferred: [],
      deferredClp: 0,
      byCurrency: [],
      resultClp: 0,
      resultDecemberClp: 0,
      reajusteToMonth: `${YEAR}-11`,
      reajusteIsEstimate: false,
      codes: {},
    },
    rentals: { places: [], taxableRentClp: 0, exemptRentClp: 0, propertyTaxPaidClp: 0, provisional: false },
    foreignSalary: { stubs: [], incomeUsd: 0, grossClp: 0, usTaxUsd: 0, usTaxSource: null, usTaxClp: 0, netClp: 0, creditClp: 0, provisional: false },
    foreignInterest: { lines: [], usd: 0, clp: 0 },
  };
}

function resident(blocks: F22WindowBlocks, informed: Record<number, number>, extra: Partial<F22ResidentInput> = {}) {
  return residentPart({
    taxYear: TAX_YEAR,
    incomeYear: YEAR,
    split: false,
    residentWindow: blocks.window,
    blocks,
    filed: null,
    dj: new Map(),
    informed,
    utaClp: UTA,
    yearEndObservado: OBSERVADO,
    art107DistributionsClp: 0,
    nonresident: null,
    ...extra,
  });
}

const dividend = (grossUsd: number | null, withholdingUsd: number | null, netUsd: number): F22DividendLine => ({
  date: `${YEAR}-05-05`,
  movementId: 1,
  grossUsd,
  withholdingUsd,
  netUsd,
});

const SALARY = { 1098: 24_000_000, 162: 500_000 };

describe("residentPart", () => {
  it("states the dividends' codes, deducts a crypto loss from them and prices the gain left", () => {
    const blocks = emptyBlocks();
    blocks.crypto = { ...blocks.crypto, gainDecemberClp: -300_000 };
    // US$1.000 gross, US$150 withheld at 900: 1104 = 765.000 net, 748 = 135.000, 1018 = min(135.000, 35 % × 900.000).
    // A dividend with no detail is left out.
    blocks.dividends = [dividend(1_000, 150, 850), dividend(null, null, 99)];
    const r = resident(blocks, { ...SALARY });
    expect(r.base).toBe("informed");
    expect(r.draft).toMatchObject({ 1098: 24_000_000, 161: 24_000_000, 1104: 765_000, 748: 135_000, 1018: 135_000, 1032: 0, 169: 300_000 });
    // 158 = 24.000.000 + 765.000 + 135.000 − 300.000 = 24.600.000 (30,75 UTA, 8 %): 157 = 1.968.000 − 1.392.000 = 576.000.
    // 304 = 576.000 − 162 500.000 − 1018 135.000 = −59.000: a refund, so no code 31.
    expect(r.draft[158]).toBe(24_600_000);
    expect(r.draft[170]).toBe(24_600_000);
    expect(r.draft[157]).toBe(576_000);
    expect(r.draft[304]).toBe(-59_000);
    expect(r.draft[305]).toBe(-59_000);
    expect(r.draft[31]).toBeUndefined();
    // The pool is the 765.000 of 1104: the 300.000 loss is used whole, 465.000 taxed.
    // With 169 = 765.000: 158 = 24.135.000 → 157 = 1.930.800 − 1.392.000 = 538.800, 304 = −96.200; effect −59.000 + 96.200 = 37.200.
    expect(r.lossOffset).toMatchObject({ gainsClp: 765_000, lossesClp: 300_000, deductedClp: 300_000, unusedLossClp: 0, taxedGainClp: 465_000, taxEffectClp: 37_200 });
    expect(r.lossOffset.parts.find((p) => p.source === "crypto")).toEqual({ source: "crypto", gainClp: 0, lossClp: 300_000 });
    expect(r.lossOffset.parts.find((p) => p.source === "foreign_dividends")).toEqual({ source: "foreign_dividends", gainClp: 765_000, lossClp: 0 });
    expect(r.estimatedCodes).toEqual([]);
  });

  it("adds the net foreign share result to 1104, its IDPC beside, and nets the sales among themselves", () => {
    const blocks = emptyBlocks();
    const sale = (r: number) => ({ accountId: 1, accountName: "x", date: `${YEAR}-06-01`, movementId: 1, units: 1, proceedsUsd: 0, costUsd: 0, gainUsd: 0, resultClp: { usd_31dic: r, clp_ipc: 0 } });
    blocks.foreignShares = { ...blocks.foreignShares, disposals: [sale(500_000), sale(-200_000)], totalClp: { usd_31dic: 300_000, clp_ipc: 0 } };
    const r = resident(blocks, { ...SALARY });
    // 158 = 24.300.000 (30,375 UTA): 157 = 1.944.000 − 1.392.000 = 552.000, 304 = 52.000, printed as 31.
    expect(r.draft[1104]).toBe(300_000);
    expect(r.draft[157]).toBe(552_000);
    expect(r.draft[304]).toBe(52_000);
    expect(r.draft[31]).toBe(52_000);
    // IDPC on the positive result: 25 % × 300.000.
    expect(r.foreignSharesIdpcClp).toBe(75_000);
    // Gains 500.000, losses 200.000 deducted, 300.000 taxed; without it 158 = 24.000.000 (30 UTA):
    // 157 = 1.920.000 − 1.392.000 = 528.000, 304 = 28.000 → effect 52.000 − 28.000 = 24.000.
    expect(r.foreignShareOffset).toEqual({ gainsClp: 500_000, lossesClp: 200_000, deductedClp: 200_000, unusedLossClp: 0, taxedGainClp: 300_000, taxEffectClp: 24_000 });
  });

  it("routes the dollars' exchange result: 1901 outside the pool, or a 1032 loss into 169", () => {
    const blocks = emptyBlocks();
    blocks.foreignFx = { ...blocks.foreignFx, codes: { 1901: 400_000, idpcClp: 100_000 } };
    const idpc = resident(blocks, { ...SALARY });
    // 158 = 24.400.000 (30,5 UTA): 157 = 1.952.000 − 1.392.000 = 560.000, 304 = 60.000.
    expect(idpc.draft[1901]).toBe(400_000);
    expect(idpc.draft[304]).toBe(60_000);
    expect(idpc.foreignFxIdpcClp).toBe(100_000);
    expect(idpc.estimatedCodes).toEqual([1901]);
    expect(idpc.lossOffset.gainsClp).toBe(0);

    blocks.foreignFx = { ...blocks.foreignFx, route: "igc_1032", codes: { loss169: 150_000 } };
    const igc = resident(blocks, { ...SALARY });
    // No pool gain: the 150.000 loss is capped to 0 in the draft and stays unused in the offset.
    expect(igc.draft[169]).toBe(0);
    expect(igc.estimatedCodes).toEqual([169]);
    expect(igc.lossOffset).toMatchObject({ gainsClp: 0, lossesClp: 150_000, unusedLossClp: 150_000 });
    expect(igc.lossOffset.parts.find((p) => p.source === "foreign_fx")).toEqual({ source: "foreign_fx", gainClp: 0, lossClp: 150_000 });
  });

  it("caps the APV rebate at the salary declared", () => {
    const r = resident(emptyBlocks(), { 1098: 1_000_000, 765: 5_000_000 });
    expect(r.draft[765]).toBe(1_000_000);
    // 170 = 158 − 765 = 0: no IGC.
    expect(r.draft[170]).toBe(0);
    expect(r.draft[304]).toBe(0);
  });

  it("with no base shows only the app's non-zero codes and no tax, a crypto loss left unused", () => {
    const blocks = emptyBlocks();
    blocks.crypto = { ...blocks.crypto, gainDecemberClp: -200_000 };
    const r = resident(blocks, {});
    expect(r.base).toBe("none");
    expect(r.taxComputed).toBe(false);
    // 169 capped at the empty pool; 1032 / 1104 / 748 / 1018 / 1901 and the art. 107 codes are zero and not shown.
    expect(r.draft).toEqual({ 169: 0 });
    expect(r.lossOffset).toMatchObject({ gainsClp: 0, lossesClp: 200_000, unusedLossClp: 200_000, taxEffectClp: null });
  });

  it("adds the non-resident part's Adicional and art. 107 codes in a departure year", () => {
    const blocks = emptyBlocks({ fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-06-30` });
    blocks.art107 = { ...blocks.art107, codes: { 1809: 0, 1813: 1_000_000, 1814: 1_000_000, 1815: -300_000, 1816: 700_000, 1829: 700_000, 1830: 70_000 } };
    const r = resident(blocks, { ...SALARY }, {
      split: true,
      nonresident: {
        window: { fromYmd: `${YEAR}-07-01`, throughYmd: `${YEAR}-12-31` },
        rentals: emptyBlocks().rentals,
        art107: emptyBlocks().art107,
        codes: { 1849: 2_000_000, 955: 2_000_000, 158: 2_000_000, 32: 2_000_000, 34: 700_000, 1809: 500_000, 1813: 200_000, 1814: 700_000 },
        excluded: [],
        taxComputed: true,
      },
    });
    // 158 = 24.000.000 (30 UTA): 157 = 528.000, 304 = 28.000.
    expect(r.draft[304]).toBe(28_000);
    expect(r.draft[32]).toBe(2_000_000);
    expect(r.draft[34]).toBe(700_000);
    // Art. 107 summed with the one carry: 1814 = 1.000.000 + 700.000; 1816 = 1.700.000 − 300.000 = 1.400.000; 1830 = 10 %.
    expect(r.draft).toMatchObject({ 1809: 500_000, 1813: 1_200_000, 1814: 1_700_000, 1815: -300_000, 1816: 1_400_000, 1829: 1_400_000, 1830: 140_000 });
    // 305 = 304 + 34 + 1830 = 28.000 + 700.000 + 140.000.
    expect(r.draft[305]).toBe(868_000);
    // The non-resident part's own base stays out of the resident 158.
    expect(r.draft[158]).toBe(24_000_000);
  });
});

function nrContext(): F22YearContext {
  return {
    taxYear: TAX_YEAR,
    incomeYear: YEAR,
    todayYmd: `${TAX_YEAR}-06-01`,
    provisional: false,
    yearEndObservado: OBSERVADO,
    foreignFx: { route: "idpc_1901", posture: "oficio_2573", purchaseCost: "observado", load: undefined },
    usTax: () => {
      throw new Error("the non-resident part read the 1040");
    },
  };
}

describe("nonresidentPart", () => {
  it("taxes the window's rent under línea 72: 1849 → 955 → 158 → 32 → 34 at 35 %", () => {
    const blocks = emptyBlocks();
    blocks.rentals = { ...blocks.rentals, taxableRentClp: 3_000_000, propertyTaxPaidClp: 120_000 };
    const p = nonresidentPart(nrContext(), blocks, {}, UTA, true);
    expect(p.taxComputed).toBe(true);
    // 34 = round(35 % × 3.000.000) = 1.050.000; no IGC codes.
    expect(p.codes).toMatchObject({ 1849: 3_000_000, 955: 3_000_000, 158: 3_000_000, 32: 3_000_000, 34: 1_050_000 });
    for (const c of [157, 170, 304]) expect(p.codes[c]).toBeUndefined();
    // The contribuciones credit is a resident's (no IGC to credit against).
    expect(p.excluded).toEqual([{ kind: "property_tax_credit", reason: "no_igc", clp: 120_000, count: 1, window: WHOLE }]);
  });

  it("computes art. 107 sales alone (no rent: 32 and 34 are 0) and nothing without either", () => {
    const blocks = emptyBlocks();
    blocks.art107 = { ...blocks.art107, codes: { 1809: 400_000, 1813: 0, 1814: 400_000, 1815: 0, 1816: 400_000, 1829: 400_000, 1830: 40_000 } };
    const p = nonresidentPart(nrContext(), blocks, {}, UTA, true);
    expect(p.taxComputed).toBe(true);
    expect(p.codes).toMatchObject({ 1830: 40_000, 158: 0, 32: 0, 34: 0 });

    const none = nonresidentPart(nrContext(), emptyBlocks(), {}, UTA, true);
    expect(none.taxComputed).toBe(false);
    expect(none.codes).toEqual(emptyBlocks().art107.codes);
    expect(none.excluded).toEqual([]);
  });

  it("lists what it does not declare with its reason; the yearly DJ figures only for a whole year", () => {
    const blocks = emptyBlocks();
    // Net US$850 + US$150 at 900 = 900.000.
    blocks.dividends = [dividend(1_000, 150, 850), dividend(null, null, 150)];
    const sale = { accountId: 1, accountName: "x", date: `${YEAR}-06-01`, movementId: 1, units: 1, proceedsUsd: 0, costUsd: 0, gainUsd: 0, resultClp: { usd_31dic: 0, clp_ipc: 0 } };
    blocks.foreignShares = { ...blocks.foreignShares, disposals: [sale, sale], totalClp: { usd_31dic: -12_345.4, clp_ipc: 0 } };
    blocks.crypto = { ...blocks.crypto, sales: [{} as never], gainDecemberClp: 555_555.5 };
    const informed = { 152: 10_000, 751: 2_000_000, 765: 300_000, 155: 80_000, 169: 30_000, 105: 7_000 };
    const whole = nonresidentPart(nrContext(), blocks, informed, UTA, true);
    expect(whole.excluded).toEqual([
      { kind: "foreign_dividends", reason: "nonresident", clp: 900_000, count: 2, window: WHOLE },
      { kind: "foreign_shares", reason: "nonresident", clp: -12_345, count: 2, window: WHOLE },
      { kind: "crypto", reason: "treaty_art13_8", clp: 555_556, count: 1, window: WHOLE },
      // DJ 1894: 155 − 169 = 50.000.
      { kind: "fund_redemptions", reason: "fund_unico_withheld", clp: 50_000, count: 0, window: WHOLE },
      { kind: "fund_distributions", reason: "fund_unico_withheld", clp: 7_000, count: 0, window: WHOLE },
      { kind: "chile_interest", reason: "withheld_at_source", clp: 10_000, count: 0, window: WHOLE },
      { kind: "mortgage_interest", reason: "no_igc", clp: 2_000_000, count: 0, window: WHOLE },
      { kind: "apv", reason: "no_igc", clp: 300_000, count: 0, window: WHOLE },
    ]);
    // A part of the year ignores the yearly DJs (the ledger of 2086 has none of these).
    const part = nonresidentPart(nrContext(), { ...blocks, window: { fromYmd: `${YEAR}-07-01`, throughYmd: `${YEAR}-12-31` } }, informed, UTA, false);
    expect(part.excluded.map((x) => x.kind)).toEqual(["foreign_dividends", "foreign_shares", "crypto"]);
  });

  it("refuses a Chilean salary, a boleta or an informed salary (art. 60 inc. 2 is not modelled)", () => {
    const salary = emptyBlocks();
    salary.salary = { ...salary.salary, months: 2 };
    expect(() => nonresidentPart(nrContext(), salary, {}, UTA, true)).toThrow(/2 Chilean salary payslip\(s\).*art\. 60 inc\. 2/);
    const fees = emptyBlocks();
    fees.feeReceipts = { receipts: 1, grossClp: 100_000, retentionClp: 13_750 };
    expect(() => nonresidentPart(nrContext(), fees, {}, UTA, true)).toThrow(/1 boleta\(s\) de honorarios/);
    expect(() => nonresidentPart(nrContext(), emptyBlocks(), { 162: 1 }, UTA, true)).toThrow(/DJ 1887/);
    // Over part of a year the yearly DJ is the resident part's.
    expect(() => nonresidentPart(nrContext(), emptyBlocks(), { 1098: 1 }, UTA, false)).not.toThrow();
  });
});

describe("cryptoTaxGainsForYear", () => {
  const created = { accounts: [] as number[], movements: [] as number[] };
  let coin = 0;
  const groupId = (slug: string) => (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;
  const account = (name: string, slug: string, ticker: string | null) => {
    const id = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`).run(groupId(slug), `vitest-f22-crypto ${name}`, ticker).lastInsertRowid
    );
    created.accounts.push(id);
    return id;
  };
  const trade = (on: string, kind: "buy" | "sell", clp: number, units: number, feeClp: number) => {
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, units_delta) VALUES (?, ?, 'clp', ?, ?)`)
        .run(coin, kind === "buy" ? clp : -clp, on, kind === "buy" ? units : -units).lastInsertRowid
    );
    created.movements.push(id);
    db.prepare(`INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, ?)`).run(id, kind);
    db.prepare(
      `INSERT INTO crypto_trade_details (movement_id, exchange_trade_id, units, price, price_currency, fee_amount, fee_currency, created_at)
       VALUES (?, ?, ?, ?, 'clp', ?, 'clp', ?)`
    ).run(id, `vitest-f22-crypto-${id}`, units, clp / units, feeClp, `${on}T12:00:00Z`);
  };

  beforeAll(() => {
    const buffer = account("buffer", "brokerage_crypto__buda_clp", null);
    db.prepare(`INSERT INTO account_roles (account_id, role) VALUES (?, 'buda_wallet')`).run(buffer);
    coin = account("coin", "brokerage_crypto__bitcoin", "BTC-USD");
    trade(`${YEAR}-02-10`, "buy", 2_000_000, 2, 10_000);
    trade(`${YEAR}-03-10`, "buy", 3_000_000, 2, 0);
    trade(`${YEAR}-06-10`, "sell", 4_000_000, 2, 20_000);
    trade(`${YEAR + 1}-02-10`, "sell", 9_000_000, 1, 0);
  });

  afterAll(() => {
    for (const id of created.movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    for (const id of created.accounts) {
      db.prepare(`DELETE FROM account_roles WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  it("takes average cost with the commissions out of both sides", () => {
    const r = cryptoTaxGainsForYear(YEAR);
    // Cost 2.000.000 − 10.000 + 3.000.000 = 4.990.000 for 4 units → 2 units 2.495.000.
    // Proceeds 4.000.000 + 20.000 commission = 4.020.000; gain 1.525.000; 0 % reajuste past the IPC on file.
    expect(r.sales).toHaveLength(1);
    expect(r.sales[0]).toMatchObject({ accountId: coin, coin: "BTC-USD", date: `${YEAR}-06-10`, units: 2, proceedsClp: 4_020_000, costClp: 2_495_000, decemberPct: 0 });
    expect(r.sales[0]!.gainDecemberClp).toBeCloseTo(1_525_000, 6);
    expect(r.gainDecemberClp).toBeCloseTo(1_525_000, 6);
    expect(r.proceedsClp).toBe(4_020_000);
    expect(r.provisional).toBe(true);
    expect(r).toMatchObject({ method: "average", feePolicy: "excluded" });
  });

  it("keeps the ledger's pesos when commissions are included, and FIFO picks the first lot", () => {
    // (5.000.000 / 4) × 2 = 2.500.000 against 4.000.000.
    expect(cryptoTaxGainsForYear(YEAR, { feePolicy: "included" }).gainDecemberClp).toBeCloseTo(1_500_000, 6);
    // First lot 1.990.000 against 4.020.000.
    expect(cryptoTaxGainsForYear(YEAR, { method: "fifo" }).gainDecemberClp).toBeCloseTo(2_030_000, 6);
  });

  it("counts only the window's sales and refuses a window outside the year", () => {
    expect(cryptoTaxGainsForYear(YEAR, { window: { fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-06-09` } }).sales).toEqual([]);
    expect(cryptoTaxGainsForYear(YEAR, { window: { fromYmd: `${YEAR}-06-10`, throughYmd: `${YEAR}-12-31` } }).sales).toHaveLength(1);
    expect(() => cryptoTaxGainsForYear(YEAR, { window: { fromYmd: `${YEAR}-07-01`, throughYmd: `${YEAR + 1}-01-31` } })).toThrow(/outside the year/);
  });
});

describe("f22Year and f22TaxOnUsWindow under a declared departure", () => {
  const DEPARTURE = `${YEAR}-07-01`;
  let savedPeriods: Record<string, unknown>[] = [];
  let rentMovement = 0;

  beforeAll(() => {
    savedPeriods = db.prepare(`SELECT * FROM tax_residency_periods ORDER BY id`).all() as Record<string, unknown>[];
    db.prepare(`DELETE FROM tax_residency_periods`).run();
    db.prepare(`INSERT INTO tax_residency_periods (jurisdiction, from_date, to_date, note) VALUES ('us', ?, NULL, 'vitest-f22-year')`).run(DEPARTURE);
    db.prepare(`INSERT INTO utm_daily (date, utm_clp) VALUES (?, ?)`).run(`${YEAR}-12-01`, 70_000);
    for (const [d, v] of [[`${YEAR - 1}-12-30`, 930], [`${YEAR}-10-30`, 940], [`${YEAR}-12-30`, 950]] as const) db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(d, v);
    createRealEstatePlace({ slug: "vitest_f22year_flat", label: "Flat" });
    const day = `${YEAR}-09-05`;
    rentMovement = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`)
        .run(checkingAccountId(), 2_000_000, day, `import:cartola|${day.slice(0, 7)}|—|ARRIENDO F22YEAR|on:${day}|amt:2000000|idx:986001`).lastInsertRowid
    );
    upsertCheckingIncomeMovementOverride(rentMovement, { income_kind: "rent", rent_place_slug: "vitest_f22year_flat" });
  });

  afterAll(() => {
    deleteCheckingIncomeMovementOverride(rentMovement);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(rentMovement);
    db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_f22year_flat'`).run();
    db.prepare(`DELETE FROM utm_daily WHERE date = ?`).run(`${YEAR}-12-01`);
    db.prepare(`DELETE FROM fx_daily_bcentral WHERE date IN (?, ?, ?)`).run(`${YEAR - 1}-12-30`, `${YEAR}-10-30`, `${YEAR}-12-30`);
    db.prepare(`DELETE FROM tax_residency_periods`).run();
    for (const p of savedPeriods) {
      const cols = Object.keys(p);
      db.prepare(`INSERT INTO tax_residency_periods (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => p[c]));
    }
  });

  const noUsTax = () => {
    throw new Error("read the 1040");
  };

  it("splits the windows at the declared day and reads the December UTA and the year-end observado", () => {
    const y = f22Year(TAX_YEAR, `${TAX_YEAR}-06-01`, {}, noUsTax);
    expect(y.regime).toBe("split");
    expect(y.residentWindow).toEqual({ fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-06-30` });
    expect(y.nonresidentWindow).toEqual({ fromYmd: DEPARTURE, throughYmd: `${YEAR}-12-31` });
    expect(y.residency.assumption).not.toBeNull();
    // UTA = 12 × UTM of December = 840.000.
    expect(y).toMatchObject({ incomeYear: YEAR, provisional: false, utaClp: 840_000, utaProvisional: false, filed: null, yearEndObservado: 950 });
    expect(y.ctx.foreignFx).toMatchObject({ route: "idpc_1901", posture: "oficio_2573", purchaseCost: "observado" });
    // While the year is open, today's observado stands in.
    expect(f22Year(TAX_YEAR, `${YEAR}-11-01`, {}, noUsTax)).toMatchObject({ provisional: true, yearEndObservado: 940 });
  });

  it("gives Chile's tax on the US-resident months from the non-resident part, and nothing for a resident year", () => {
    const t = f22TaxOnUsWindow(YEAR, `${TAX_YEAR}-06-01`);
    // September's rent, after the departure: 35 % × 2.000.000 (0 % reajuste) = 700.000.
    expect(t).toEqual({ taxYear: TAX_YEAR, window: { fromYmd: DEPARTURE, throughYmd: `${YEAR}-12-31` }, adicionalClp: 700_000, adicionalSource: "draft", unicoArt107Clp: 0 });
    expect(f22TaxOnUsWindow(YEAR - 1, `${TAX_YEAR}-06-01`)).toBeNull();
  });
});
