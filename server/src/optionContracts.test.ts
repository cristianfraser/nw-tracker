import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daysBetweenIso } from "nw-tracker-contracts";
import { bucketSlugForAccountId } from "./accountBucket.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { getAccountPositionMeta, positionMarkFromMeta } from "./accountPosition.js";
import { accountProfile, profileFromFacts, type AccountProfileFacts } from "./accountProfile.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { accountValueAt } from "./accountValue.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { holdingPriceAt } from "./holdingPrices.js";
import { listMovementRowsForAccount, unitsDeltaForAccountMovement, signedUsdDeltaForAccountMovement } from "./movementTransfer.js";
import { movementCreateSchemaForAccount, validateMovementCreate } from "./movementUnitsPolicy.js";
import { assignOptionContract, assignmentShareLeg, optionAssignmentForStockMovement } from "./optionAssignment.js";
import { occSymbol, occSymbolSlug, optionContractDisplayName, optionContractForAccount, optionIntrinsicPerShare } from "./optionContracts.js";
import { optionContractsThroughDate } from "./optionPosition.js";
import { seedNavTree } from "./seedNavTree.js";
import { convertValue } from "./valueConvert.js";

/**
 * Options as an instrument kind (docs/demo-app-features-plan.md §3, wave O1): the holding and
 * quantity decision, the intrinsic mark, the signed units, the endpoint validation, the
 * assignment service, and the capital identity Δvalue = flow + P/L on the contract, the cash
 * account and the brokerage bucket — for a sold call that expires and for one assigned.
 * Synthetic fixture: a ticker no market knows, accounts cleaned up after.
 */
const PREFIX = "Vitest · options";
const TICKER = "VTOPTX";
const NOTE = "vitest-options";
const created: number[] = [];

/** Underlying closes: the expiring call (strike 105, expiry 06-05) is in the money only on 05-18. */
const CLOSES: [string, number][] = [
  ["2026-05-04", 100],
  ["2026-05-05", 100],
  ["2026-05-11", 102],
  ["2026-05-18", 108],
  ["2026-05-25", 104],
  ["2026-06-01", 103],
  ["2026-06-05", 103],
  ["2026-06-08", 103],
  ["2026-06-12", 110],
  ["2026-06-15", 110],
];

function usdLeaf(): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_usd' ESCAPE '\\' LIMIT 1`).get() as { id: number } | undefined;
  if (!row) throw new Error("no USD cash leaf in the test DB");
  return row.id;
}
function stockLeaf(): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones\\_\\_%' ESCAPE '\\' LIMIT 1`).get() as { id: number } | undefined;
  if (!row) throw new Error("no brokerage_acciones leaf in the test DB");
  return row.id;
}
function insertAccount(leaf: number, name: string, ticker: string | null): number {
  const id = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`).run(leaf, `${PREFIX} ${name}`, ticker).lastInsertRowid
  );
  created.push(id);
  return id;
}
function single(account: number, on: string, amount: number, kind: string, units: number | null = null): void {
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind) VALUES (?, ?, 'usd', ?, ?, ?, ?)`
  ).run(account, amount, on, NOTE, units, kind);
}
function transfer(from: number, to: number, on: string, amount: number, kind: string, units: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
         VALUES (?, ?, ?, 'usd', ?, ?, ?, ?)`
      )
      .run(from, to, amount, on, NOTE, units, kind).lastInsertRowid
  );
}
function createContract(right: "C" | "P", strike: number, expiry: string): number {
  const r = createPanelAccount({
    account: {
      account_type: "option",
      name: "",
      bucket_slug: "brokerage_opciones",
      option: { underlying: TICKER, right, strike, expiry },
      exclude_from_group_totals: false,
    },
  });
  created.push(r.account_id);
  return r.account_id;
}
function valueUsd(id: number, ymd: string): number {
  const v = accountValueAt(id, ymd, "usd");
  if (!v) throw new Error(`no value for ${id} on ${ymd}`);
  return Math.round(v.value * 100) / 100;
}
function flowsUsdThrough(id: number, ymd: string): number {
  return Math.round(
    getMergedDisplayDepositInflowEventsForAccount(id)
      .filter((e) => e.occurred_on <= ymd)
      .reduce((s, e) => s + (e.amt_usd ?? 0), 0) * 100
  ) / 100;
}
/** Cumulative P/L through `ymd`: value − Σ capital flows (every account started at 0). */
function plUsd(ids: number[], ymd: string): number {
  return Math.round(ids.reduce((s, id) => s + valueUsd(id, ymd) - flowsUsdThrough(id, ymd), 0) * 100) / 100;
}

let cash = 0;
let stock = 0;
let callA = 0;
let callB = 0;

beforeAll(() => {
  const insClose = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')`);
  for (const [d, c] of CLOSES) insClose.run(TICKER, d, c);
  cash = insertAccount(usdLeaf(), "USD cash", null);
  stock = insertAccount(stockLeaf(), "stock", TICKER);
  callA = createContract("C", 105, "2026-06-05");
  callB = createContract("C", 100, "2026-07-17");
  // 10,000 dollars arrive; call A (2 contracts) sold for 600, expires worthless on 06-05.
  single(cash, "2026-05-04", 10_000, "compra_usd");
  transfer(callA, cash, "2026-05-05", 600, "option_sell_open", 2);
  single(callA, "2026-06-05", 0, "option_expire", 2);
  // 200 shares bought at 103 on 06-08; call B (2 contracts, strike 100) sold for 400 the same day
  // and assigned on 06-15 with the underlying at 110.
  transfer(cash, stock, "2026-06-08", 20_600, "stock_buy", 200);
  transfer(callB, cash, "2026-06-08", 400, "option_sell_open", 2);
  clearAggregationCache();
});

afterAll(() => {
  for (const a of created) {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(a, a, a);
  }
  for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM asset_groups WHERE slug LIKE 'brokerage_opciones\\_\\_vtoptx%' ESCAPE '\\'`).run();
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  seedNavTree();
  clearAggregationCache();
});

describe("OCC symbol and intrinsic value", () => {
  it("spells the series the OCC way and names the account from it", () => {
    const t = { underlying_ticker: "SPY", expiry: "2025-06-20", right: "C" as const, strike: 600 };
    expect(occSymbol(t)).toBe("SPY   250620C00600000");
    expect(occSymbol({ ...t, strike: 12.5, right: "P" })).toBe("SPY   250620P00012500");
    expect(occSymbolSlug(occSymbol(t))).toBe("spy250620c00600000");
    expect(optionContractDisplayName(t)).toBe("SPY 2025-06-20 C 600");
    expect(() => occSymbol({ ...t, strike: 0.0001 })).toThrow(/thousandths/);
    expect(() => occSymbol({ ...t, underlying_ticker: "TOOLONGROOT" })).toThrow(/OCC root/);
  });

  it("is max(0, S − K) for a call and max(0, K − S) for a put, 0 on and after the expiry", () => {
    const call = { right: "C" as const, strike: 100, expiry: "2026-06-05" };
    const put = { right: "P" as const, strike: 100, expiry: "2026-06-05" };
    expect(optionIntrinsicPerShare(call, 110, "2026-06-01")).toBe(10);
    expect(optionIntrinsicPerShare(call, 90, "2026-06-01")).toBe(0);
    expect(optionIntrinsicPerShare(put, 90, "2026-06-01")).toBe(10);
    expect(optionIntrinsicPerShare(put, 110, "2026-06-01")).toBe(0);
    expect(optionIntrinsicPerShare(call, 110, "2026-06-05")).toBe(0);
    expect(optionIntrinsicPerShare(call, 110, "2026-06-06")).toBe(0);
  });
});

describe("the profile", () => {
  const base: AccountProfileFacts = {
    id: 1,
    name: "Vitest",
    importKey: null,
    leafSlug: "brokerage_opciones__spy250620c00600000",
    kind: "spy250620c00600000",
    equityTicker: null,
    optionContract: { occSymbol: "SPY   250620C00600000", underlying: "SPY", right: "C", strike: 600, expiry: "2025-06-20", multiplier: 100 },
    coinPriceTicker: null,
    usesEquityMtm: false,
    fundSeriesKey: null,
    quoteCurrencyOf: (t) => (t.endsWith(".SN") ? "clp" : "usd"),
    fundQuoteCurrencyOf: () => "clp",
    roles: [],
    demoOrTest: true,
  };

  it("decides the option quantity from the contract row, before the share-units branch", () => {
    const p = profileFromFacts(base);
    expect(p.quantity).toEqual({ kind: "option_contracts" });
    expect(p.holding).toEqual({
      kind: "option",
      occSymbol: "SPY   250620C00600000",
      underlying: "SPY",
      right: "C",
      strike: 600,
      expiry: "2025-06-20",
      multiplier: 100,
      quote: "usd",
    });
    expect(p.priceless).toBe(false);
    expect(p.side).toBe("asset");
  });

  it("refuses a contract account that carries a ticker, share units or a non-dollar underlying", () => {
    expect(() => profileFromFacts({ ...base, equityTicker: "SPY" })).toThrow(/equity_ticker/);
    expect(() => profileFromFacts({ ...base, usesEquityMtm: true })).toThrow(/share or coin units/);
    expect(() =>
      profileFromFacts({ ...base, optionContract: { ...base.optionContract!, underlying: "CFIETFIPSA.SN" } })
    ).toThrow(/USD underlyings only/);
  });

  it("the created account resolves to the contract (equity_ticker NULL, terms on file)", () => {
    const terms = optionContractForAccount(callA);
    expect(terms).toMatchObject({ underlying_ticker: TICKER, right: "C", strike: 105, expiry: "2026-06-05", multiplier: 100 });
    expect(terms!.occ_symbol).toBe("VTOPTX260605C00105000");
    expect(db.prepare(`SELECT equity_ticker, name FROM accounts WHERE id = ?`).get(callA)).toEqual({
      equity_ticker: null,
      name: "VTOPTX 2026-06-05 C 105",
    });
    expect(accountProfile(callA).quantity).toEqual({ kind: "option_contracts" });
    // The same series twice is refused.
    expect(() => createContract("C", 105, "2026-06-05")).toThrow(/already holds/);
  });
});

describe("signed contracts and the intrinsic mark", () => {
  it("counts a sold call negative and the expiry back to zero; the cash leg counts the premium", () => {
    expect(optionContractsThroughDate(callA, "2026-05-04")).toBe(0);
    expect(optionContractsThroughDate(callA, "2026-05-05")).toBe(-2);
    expect(optionContractsThroughDate(callA, "2026-06-04")).toBe(-2);
    expect(optionContractsThroughDate(callA, "2026-06-05")).toBe(0);
    const rows = listMovementRowsForAccount(callA);
    const sell = rows.find((r) => r.flow_kind === "option_sell_open")!;
    expect(unitsDeltaForAccountMovement(sell, callA)).toBe(-2);
    expect(unitsDeltaForAccountMovement(sell, cash)).toBe(0);
    expect(signedUsdDeltaForAccountMovement(sell, cash)).toBe(600);
    expect(signedUsdDeltaForAccountMovement(sell, callA)).toBe(0);
    const expire = rows.find((r) => r.flow_kind === "option_expire")!;
    expect(unitsDeltaForAccountMovement(expire, callA)).toBe(2);
    expect(signedUsdDeltaForAccountMovement(expire, callA)).toBe(0);
  });

  it("prices intrinsic value per share from the underlying's close, 0 from the expiry on, and throws without a close", () => {
    const h = accountProfile(callA).holding;
    if (h.kind !== "option") throw new Error("not an option holding");
    expect(holdingPriceAt(h, "2026-05-11")).toEqual({ price: 0, currency: "usd", as_of: "2026-05-11" });
    expect(holdingPriceAt(h, "2026-05-18")).toEqual({ price: 3, currency: "usd", as_of: "2026-05-18" });
    expect(holdingPriceAt(h, "2026-05-20")).toEqual({ price: 3, currency: "usd", as_of: "2026-05-20" });
    expect(holdingPriceAt(h, "2026-06-05")).toEqual({ price: 0, currency: "usd", as_of: "2026-06-05" });
    expect(holdingPriceAt(h, "2026-06-30")).toEqual({ price: 0, currency: "usd", as_of: "2026-06-30" });
    expect(() => holdingPriceAt(h, "2026-04-30")).toThrow(/no VTOPTX close/);
    const put = { ...h, right: "P" as const, strike: 110, occSymbol: "VTOPTX260605P00110000" };
    expect(holdingPriceAt(put, "2026-05-11")).toEqual({ price: 8, currency: "usd", as_of: "2026-05-11" });
    expect(holdingPriceAt(put, "2026-06-05")).toEqual({ price: 0, currency: "usd", as_of: "2026-06-05" });
  });

  it("a short position's value is negative, in dollars and in pesos; empty days read 0 with no price", () => {
    expect(valueUsd(callA, "2026-05-11")).toBe(0);
    expect(valueUsd(callA, "2026-05-18")).toBe(-600);
    expect(valueUsd(callA, "2026-06-05")).toBe(0);
    // A day before the underlying has any close: no contracts, so no price is read.
    expect(valueUsd(callA, "2026-04-30")).toBe(0);
    const clp = accountMarkClpAtYmd(callA, "2026-05-18")!.value_clp;
    expect(clp).toBeLessThan(0);
    expect(clp).toBeCloseTo(convertValue(-600, "usd", "clp", "2026-05-18", "asset")!, 6);
    const meta = getAccountPositionMeta(callA, { asOfYmd: "2026-05-18" })!;
    expect(meta.units_kind).toBe("contracts");
    expect(meta.units).toBe(-2);
    expect(meta.afp_override_value_clp).toBeCloseTo(Math.round(clp * 100) / 100, 2);
    expect(positionMarkFromMeta(callA, meta)?.value_clp).toBeCloseTo(Math.round(clp * 100) / 100, 2);
    // Per contract: 3 × 100 shares, in pesos.
    expect(meta.afp_override_valor_cuota_clp).toBeCloseTo(convertValue(300, "usd", "clp", "2026-05-18", "asset")!, 2);
    const closed = getAccountPositionMeta(callA, { asOfYmd: "2026-06-06" })!;
    expect(closed).toMatchObject({ units: 0, afp_override_value_clp: 0 });
    expect(accountChartInactive(callA)).toBe(true);
    expect(accountChartInactive(callB)).toBe(false);
  });
});

describe("the capital identity: Δvalue = flow + P/L", () => {
  it("a sold call: the premium leaves the contract's capital, the contract's P/L is premium − intrinsic, and expiry needs no event", () => {
    // Capital: −600 on the contract (the dividend_payout mirror), +600 on cash.
    expect(flowsUsdThrough(callA, "2026-05-05")).toBe(-600);
    expect(flowsUsdThrough(cash, "2026-05-05")).toBe(10_600);
    // 05-11: out of the money → P/L = the whole premium; 05-18: 3 in the money → premium − 600 = 0.
    expect(plUsd([callA], "2026-05-11")).toBe(600);
    expect(plUsd([callA], "2026-05-18")).toBe(0);
    expect(plUsd([callA], "2026-06-05")).toBe(600);
    // The expiry row changes nothing: the premium was already P/L.
    expect(plUsd([callA], "2026-06-04")).toBe(600);
    // Cash never earns on it; the bucket's P/L is the premium, its flows the outside money only.
    expect(plUsd([cash], "2026-06-05")).toBe(0);
    expect(plUsd([cash, callA], "2026-06-05")).toBe(600);
    expect(flowsUsdThrough(cash, "2026-06-05") + flowsUsdThrough(callA, "2026-06-05")).toBe(10_000);
  });

  it("an assigned call: three legs reconcile and the aportes identity holds on every account and the bucket", () => {
    // Before the assignment (06-12, underlying 110): the short call is 10 in the money.
    expect(valueUsd(callB, "2026-06-12")).toBe(-2_000);
    expect(plUsd([callB], "2026-06-12")).toBe(-1_600);
    expect(valueUsd(stock, "2026-06-12")).toBe(22_000);
    expect(plUsd([stock], "2026-06-12")).toBe(1_400);

    const r = assignOptionContract({
      contract_account_id: callB,
      stock_account_id: stock,
      cash_account_id: cash,
      occurred_on: "2026-06-15",
      contracts: 2,
      note: NOTE,
    });
    clearAggregationCache();
    expect(r).toMatchObject({ stock_flow_kind: "stock_sell", shares: 200, amount_usd: 20_000, contracts_units_delta: 2 });
    expect(optionAssignmentForStockMovement(r.stock_movement_id)?.option_movement_id).toBe(r.option_movement_id);
    expect(optionContractsThroughDate(callB, "2026-06-15")).toBe(0);
    expect(valueUsd(callB, "2026-06-15")).toBe(0);
    expect(valueUsd(stock, "2026-06-15")).toBe(0);
    expect(valueUsd(cash, "2026-06-15")).toBe(10_000 + 600 - 20_600 + 400 + 20_000);
    // Contract: premium 400 is P/L once the contracts are gone; stock: bought 20,600, called away
    // at 20,000; cash: 0; bucket: 1,000 of premiums − 600 lost on the shares = 400.
    expect(plUsd([callB], "2026-06-15")).toBe(400);
    expect(plUsd([stock], "2026-06-15")).toBe(-600);
    expect(plUsd([cash], "2026-06-15")).toBe(0);
    expect(plUsd([cash, stock, callA, callB], "2026-06-15")).toBe(400);
    expect([cash, stock, callA, callB].reduce((s, id) => s + flowsUsdThrough(id, "2026-06-15"), 0)).toBe(10_000);
    // The assignment day itself moves no P/L on the bucket: +2,000 on the contract, −2,000 on the shares.
    expect(plUsd([cash, stock, callA, callB], "2026-06-12")).toBe(400);
  });

  it("the daily series carries the signed contract line, and Σ of its P/L is the bucket's 400 dollars", () => {
    const ids = [cash, stock, callA, callB];
    const refs = ids.map((id) => ({ account_id: id, bucket_slug: bucketSlugForAccountId(id)! }));
    const s = getBucketDailySeries(refs, { unit: "usd", days: daysBetweenIso("2026-05-01", chileCalendarTodayYmd()), includeAccounts: true });
    const at = (ymd: string) => s.points.findIndex((p) => p.as_of_date === ymd);
    const lineA = s.accounts!.find((l) => l.account_id === callA)!;
    expect(lineA.values[at("2026-05-18")]).toBe(-600);
    expect(lineA.pl![at("2026-05-18")]).toBe(-600);
    // Out of the money from 05-25 on, the line reads 0 and then ends: the daily per-account line
    // keeps one plotted zero and clips the trailing run, as a sold-out stock's does.
    expect(lineA.values[at("2026-05-25")]).toBe(0);
    expect(lineA.values[at("2026-06-05")]).toBeNull();
    // Every day: Δvalue = flow + P/L on the bucket; over the window the bucket earned the 400.
    for (const p of s.points) if (p.delta != null) expect(p.delta).toBeCloseTo(p.flow + p.pl!, 6);
    expect(s.points.reduce((acc, p) => acc + (p.pl ?? 0), 0)).toBeCloseTo(400, 6);
    expect(s.points.at(-1)!.value).toBeCloseTo(10_400, 6);
  });
});

describe("the movement API", () => {
  it("offers the option kinds on the contract account and the share kinds on the stock", () => {
    expect(movementCreateSchemaForAccount(accountRowForId(callB)!)).toMatchObject({
      units_delta: "required",
      unit_label: "contratos",
      brokerage_flow_kinds: ["option_sell_open", "option_sell_close", "option_buy_open", "option_buy_close", "option_expire"],
    });
    expect(movementCreateSchemaForAccount(accountRowForId(stock)!)!.brokerage_flow_kinds).not.toContain("option_sell_open");
    const onStock = validateMovementCreate(accountRowForId(stock)!, { flow_kind: "option_expire", occurred_on: "2026-07-17", units_delta: 2 }, stock);
    expect(onStock.ok).toBe(false);
  });

  it("validates a premium transfer: USD cash on the other side, the premium in dollars, whole contracts, a direction that fits the position", () => {
    const row = accountRowForId(callB)!;
    const ok = validateMovementCreate(
      row,
      { flow_kind: "option_sell_open", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1, counterpart_account_id: cash, counterpart_role: "to" },
      callB
    );
    expect(ok).toMatchObject({ ok: true, mode: "transfer", from_account_id: callB, to_account_id: cash, flow_kind: "option_sell_open" });
    const bad = (body: Record<string, unknown>) => {
      const v = validateMovementCreate(row, body, callB);
      if (v.ok) throw new Error(`expected a refusal for ${JSON.stringify(body)}`);
      return v.error;
    };
    expect(bad({ flow_kind: "option_sell_open", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1 })).toMatch(/counterpart/);
    expect(bad({ flow_kind: "option_sell_open", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1, counterpart_account_id: stock, counterpart_role: "to" })).toMatch(/USD cash/);
    expect(bad({ flow_kind: "option_sell_open", occurred_on: "2026-06-09", amount: 45_000, currency: "clp", units_delta: 1, counterpart_account_id: cash, counterpart_role: "to" })).toMatch(/USD amount/);
    expect(bad({ flow_kind: "option_sell_open", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1.5, counterpart_account_id: cash, counterpart_role: "to" })).toMatch(/whole number/);
    // Closing more than held, or the wrong side.
    expect(bad({ flow_kind: "option_buy_close", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 3, counterpart_account_id: cash, counterpart_role: "from" })).toMatch(/exceeds/);
    expect(bad({ flow_kind: "option_sell_close", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1, counterpart_account_id: cash, counterpart_role: "to" })).toMatch(/closes a long/);
    expect(bad({ flow_kind: "option_buy_open", occurred_on: "2026-06-09", amount: 50, currency: "usd", units_delta: 1, counterpart_account_id: cash, counterpart_role: "from" })).toMatch(/option_buy_close/);
    // After the expiry nothing trades.
    expect(bad({ flow_kind: "option_sell_open", occurred_on: "2026-07-18", amount: 50, currency: "usd", units_delta: 1, counterpart_account_id: cash, counterpart_role: "to" })).toMatch(/expired/);
    // The expiry row: on or after the expiry, units exactly −held, no money; an assignment is never typed.
    expect(bad({ flow_kind: "option_expire", occurred_on: "2026-07-10", units_delta: 2 })).toMatch(/expires on/);
    expect(bad({ flow_kind: "option_expire", occurred_on: "2026-07-17", units_delta: 2, amount: 10, currency: "usd" })).toMatch(/no money/);
    // An assignment is never typed as a row: the contract's own kinds leave it out.
    expect(bad({ flow_kind: "option_assign", occurred_on: "2026-06-15", units_delta: 2 })).toMatch(/valid flow_kind/);
  });

  it("the expiry row takes the position to zero exactly", () => {
    const rowA = accountRowForId(callA)!;
    // Call A already expired (held 0 on the day): nothing to expire.
    const none = validateMovementCreate(rowA, { flow_kind: "option_expire", occurred_on: "2026-06-05", units_delta: 2 }, callA);
    expect(none.ok).toBe(false);
    // A fresh short put expiring: the units must be +held's negation.
    const put = createContract("P", 90, "2026-06-05");
    transfer(put, cash, "2026-05-05", 150, "option_sell_open", 3);
    const rowP = accountRowForId(put)!;
    const wrong = validateMovementCreate(rowP, { flow_kind: "option_expire", occurred_on: "2026-06-05", units_delta: 2 }, put);
    expect(wrong.ok).toBe(false);
    expect((wrong as { error: string }).error).toMatch(/must be 3/);
    const right = validateMovementCreate(rowP, { flow_kind: "option_expire", occurred_on: "2026-06-05", units_delta: 3 }, put);
    expect(right).toMatchObject({ ok: true, mode: "brokerage", flow_kind: "option_expire", amount: 0, currency: "usd", units_delta: 3 });
  });
});

describe("the assignment service", () => {
  it("decides the share leg from the side held and the right", () => {
    expect(assignmentShareLeg({ right: "C" }, -2)).toBe("stock_sell");
    expect(assignmentShareLeg({ right: "P" }, -2)).toBe("stock_buy");
    expect(assignmentShareLeg({ right: "C" }, 2)).toBe("stock_buy");
    expect(assignmentShareLeg({ right: "P" }, 2)).toBe("stock_sell");
  });

  it("refuses the wrong stock, the wrong cash, more contracts than held, and shares that are not there", () => {
    const put = createContract("P", 95, "2026-07-17");
    transfer(put, cash, "2026-06-09", 300, "option_sell_open", 1);
    const otherStock = insertAccount(stockLeaf(), "other stock", "VTOTHER");
    const base = { contract_account_id: put, stock_account_id: stock, cash_account_id: cash, occurred_on: "2026-06-16", contracts: 1 };
    expect(() => assignOptionContract({ ...base, stock_account_id: otherStock })).toThrow(/not the contract's underlying/);
    expect(() => assignOptionContract({ ...base, cash_account_id: stock })).toThrow(/USD cash/);
    expect(() => assignOptionContract({ ...base, contracts: 2 })).toThrow(/exceed/);
    expect(() => assignOptionContract({ ...base, occurred_on: "2026-07-20" })).toThrow(/after the expiry/);
    // Call B's shares were called away: a short call on an empty stock account cannot be assigned.
    const callC = createContract("C", 120, "2026-07-17");
    transfer(callC, cash, "2026-06-16", 100, "option_sell_open", 1);
    expect(() =>
      assignOptionContract({ contract_account_id: callC, stock_account_id: stock, cash_account_id: cash, occurred_on: "2026-06-17", contracts: 1 })
    ).toThrow(/called away/);
    // The put assigned: shares bought at the strike from cash, linked to the contract row.
    const r = assignOptionContract(base);
    expect(r).toMatchObject({ stock_flow_kind: "stock_buy", shares: 100, amount_usd: 9_500, contracts_units_delta: 1 });
    const stockRow = db.prepare(`SELECT from_account_id, to_account_id, units_delta, flow_kind FROM movements WHERE id = ?`).get(r.stock_movement_id);
    expect(stockRow).toEqual({ from_account_id: cash, to_account_id: stock, units_delta: 100, flow_kind: "stock_buy" });
    expect(optionContractsThroughDate(put, "2026-06-16")).toBe(0);
  });
});
