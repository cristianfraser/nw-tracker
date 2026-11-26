import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysIso } from "nw-tracker-contracts";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";
import { totalDividendsInUnitForAccount } from "./equityReturns.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { registerInstrument } from "./marketSymbols.js";
import { insertMovement } from "./movementWrites.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import type { ShortHorizonAccountRef } from "./periodReturnsShortHorizon.js";
import { flowEventInUnit } from "./rates.js";

/**
 * A dividend paid into peso cash (untangle wave 9, `ut-currency-seams`): a Santiago-quoted stock
 * bought from a peso cash account, which later receives the stock's dividend. Every row goes
 * through the create API's validator. The dividend is the stock's return once — capital leaving
 * the stock — and a deposit of the same pesos on the cash account, never the cash account's own
 * return; across the two accounts it is a move that nets to nothing, in the monthly performance
 * rows and the daily series, in pesos and in dollars.
 */
const NOTE = "vitest-peso-dividend";
/** A synthetic peso-quoted instrument, registered for the test and removed after it. */
const TICKER = "VTCLPDIV.SN";
const CLOSE_AT_BUY = 1_000;
const CLOSE_LATER = 1_100;

const UNITS = ["clp", "usd"] as const;

describe("a dividend paid into peso cash", () => {
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  let cashId = 0;
  let stockId = 0;
  const today = chileCalendarTodayYmd();
  const depositDay = addDaysIso(today, -100);
  const buyDay = addDaysIso(today, -90);
  const dividendDay = addDaysIso(today, -50);
  const dividendMonth = dividendDay.slice(0, 7);

  const DEPOSIT = 5_000_000;
  const BUY = 2_000_000;
  const SHARES = 2_000;
  const DIVIDEND = 60_000;

  function ref(accountId: number): ShortHorizonAccountRef {
    const row = db
      .prepare(`SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`)
      .get(accountId) as { bucket_slug: string };
    return { account_id: accountId, bucket_slug: row.bucket_slug };
  }

  /** One create request through the API's validator, written as the route writes it. */
  function create(accountId: number, body: Record<string, unknown>): number {
    const v = validateMovementCreate(accountRowForId(accountId)!, body, accountId);
    if (!v.ok) throw new Error(`create refused: ${v.error}`);
    if (v.mode === "transfer") {
      return insertMovement({
        fromAccountId: v.from_account_id,
        toAccountId: v.to_account_id,
        amount: v.amount,
        currency: v.currency,
        occurredOn: v.occurred_on,
        note: NOTE,
        unitsDelta: v.units_delta,
        flowKind: v.flow_kind,
      });
    }
    return insertMovement({
      accountId,
      amount: v.amount,
      currency: v.currency,
      occurredOn: v.occurred_on,
      note: NOTE,
      unitsDelta: v.units_delta,
      flowKind: v.flow_kind,
    });
  }

  function removeFixture(): void {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
    clearAggregationCache();
  }

  beforeAll(() => {
    removeFixture();
    registerInstrument(
      TICKER,
      { quote_currency: "clp", market_kind: "santiago", display_symbol: "VTCLPDIV", name: "Vitest peso stock", exchange: null, instrument_type: null },
      "declared"
    );
    const insClose = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`);
    for (let d = addDaysIso(buyDay, -5); d <= today; d = addDaysIso(d, 1)) {
      insClose.run(TICKER, d, d < dividendDay ? CLOSE_AT_BUY : CLOSE_LATER);
    }
    const panelAccount = (input: Parameters<typeof createPanelAccount>[0]) => {
      const out = createPanelAccount(input);
      created.push(out);
      return out;
    };
    cashId = panelAccount({
      account: {
        account_type: "clp_cash",
        name: "Vitest peso dividend cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_peso_dividend_cash",
        exclude_from_group_totals: true,
      },
    }).account_id;
    stockId = panelAccount({
      account: {
        account_type: "equity",
        bucket_slug: "brokerage_acciones",
        ticker: TICKER,
        name: "Vitest peso dividend stock",
        category_slug: "vitest_peso_dividend_stock",
        exclude_from_group_totals: true,
      },
    }).account_id;

    create(cashId, { occurred_on: depositDay, flow_kind: "deposit", amount: DEPOSIT, currency: "clp" });
    create(stockId, {
      occurred_on: buyDay,
      flow_kind: "stock_buy",
      amount: BUY,
      currency: "clp",
      units_delta: SHARES,
      counterpart_account_id: cashId,
      counterpart_role: "from",
    });
    create(stockId, {
      occurred_on: dividendDay,
      flow_kind: "dividend_payout",
      amount: DIVIDEND,
      currency: "clp",
      counterpart_account_id: cashId,
      counterpart_role: "to",
    });
    clearAggregationCache();
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
    removeFixture();
  });

  it("the create API takes the dividend in pesos and still refuses another currency or share units", () => {
    const body = {
      occurred_on: dividendDay,
      flow_kind: "dividend_payout",
      amount: DIVIDEND,
      counterpart_account_id: cashId,
      counterpart_role: "to",
    };
    expect(validateMovementCreate(accountRowForId(stockId)!, { ...body, currency: "clp" }, stockId).ok).toBe(true);
    const dollars = validateMovementCreate(accountRowForId(stockId)!, { ...body, currency: "usd" }, stockId);
    expect(dollars.ok).toBe(false);
    if (!dollars.ok) expect(dollars.error).toMatch(/settles in CLP, the cash account's currency/);
    const units = validateMovementCreate(accountRowForId(stockId)!, { ...body, currency: "clp", units_delta: 1 }, stockId);
    expect(units.ok).toBe(false);
  });

  it("the cash balance and its deposited line both rise by the dividend", () => {
    expect(clpCashBalanceClpAt(cashId, addDaysIso(dividendDay, -1))).toBe(DEPOSIT - BUY);
    expect(clpCashBalanceClpAt(cashId, dividendDay)).toBe(DEPOSIT - BUY + DIVIDEND);
    const cash = loadMergedDepositInflowEvents([cashId]).get(cashId) ?? [];
    expect(cash.map((e) => [e.occurred_on, e.amt])).toEqual([
      [depositDay, DEPOSIT],
      [buyDay, -BUY],
      [dividendDay, DIVIDEND],
    ]);
    const stock = loadMergedDepositInflowEvents([stockId]).get(stockId) ?? [];
    expect(stock.map((e) => [e.occurred_on, e.amt])).toEqual([
      [buyDay, BUY],
      [dividendDay, -DIVIDEND],
    ]);
    // The two legs of the dividend cancel in every unit.
    for (const unit of UNITS) {
      const cashLeg = flowEventInUnit(cash[2]!, unit);
      const stockLeg = flowEventInUnit(stock[1]!, unit);
      expect(cashLeg).toBeGreaterThan(0);
      expect(cashLeg + stockLeg).toBeCloseTo(0, 6);
    }
    expect(totalDividendsInUnitForAccount(stockId, "clp")).toBeCloseTo(DIVIDEND, 6);
  });

  it("monthly performance: the dividend is the stock's P/L once and never the cash account's", () => {
    const stockClp = monthlyPerfForAccountId(stockId, "clp")!.monthly;
    const cashClp = monthlyPerfForAccountId(cashId, "clp")!.monthly;
    const month = <T extends { as_of_date: string }>(rows: readonly T[]): T => {
      const hit = rows.filter((r) => r.as_of_date.slice(0, 7) === dividendMonth);
      expect(hit).toHaveLength(1);
      return hit[0]!;
    };
    // The price steps 1.000 → 1.100 on the dividend day; the dividend is return on top.
    expect(month(stockClp).net_capital_flow).toBeCloseTo(-DIVIDEND, 6);
    expect(month(stockClp).nominal_pl!).toBeCloseTo(SHARES * (CLOSE_LATER - CLOSE_AT_BUY) + DIVIDEND, 6);
    expect(month(cashClp).net_capital_flow).toBeCloseTo(DIVIDEND, 6);
    expect(month(cashClp).nominal_pl!).toBeCloseTo(0, 6);
    // Peso cash never earns anything from these rows, in any month.
    for (const row of cashClp) expect(row.nominal_pl ?? 0).toBeCloseTo(0, 6);
    expect(cashClp.reduce((s, m) => s + m.net_capital_flow, 0)).toBeCloseTo(DEPOSIT - BUY + DIVIDEND, 6);
    expect(stockClp.reduce((s, m) => s + m.net_capital_flow, 0)).toBeCloseTo(BUY - DIVIDEND, 6);

    for (const unit of UNITS) {
      const stock = month(monthlyPerfForAccountId(stockId, unit)!.monthly);
      const cash = month(monthlyPerfForAccountId(cashId, unit)!.monthly);
      // No other flow touches either account that month: the dividend's two legs net to zero.
      expect(stock.net_capital_flow).toBeLessThan(0);
      expect(stock.net_capital_flow + cash.net_capital_flow).toBeCloseTo(0, 6);
    }
  });

  it("daily series: the dividend day's flow nets to zero across the two accounts, and its P/L is counted once", () => {
    for (const unit of UNITS) {
      const day = (refs: ShortHorizonAccountRef[]) =>
        getBucketDailySeries(refs, { unit, days: 95 }).points.find((p) => p.as_of_date === dividendDay)!;
      const stock = day([ref(stockId)]);
      const cash = day([ref(cashId)]);
      const both = day([ref(cashId), ref(stockId)]);
      expect(stock.flow).toBeLessThan(0);
      expect(cash.flow).toBeCloseTo(-stock.flow, 6);
      expect(both.flow).toBeCloseTo(0, 6);
      // The set's P/L is the stock's plus the cash account's, and the set's value change that day.
      expect(both.pl!).toBeCloseTo(stock.pl! + cash.pl!, 4);
      if (unit === "clp") {
        expect(stock.flow).toBeCloseTo(-DIVIDEND, 6);
        expect(stock.pl!).toBeCloseTo(SHARES * (CLOSE_LATER - CLOSE_AT_BUY) + DIVIDEND, 6);
        expect(cash.pl!).toBeCloseTo(0, 6);
        expect(both.pl!).toBeCloseTo(SHARES * (CLOSE_LATER - CLOSE_AT_BUY) + DIVIDEND, 6);
      }
      const buy = getBucketDailySeries([ref(cashId), ref(stockId)], { unit, days: 95 }).points.find(
        (p) => p.as_of_date === buyDay
      )!;
      expect(buy.flow).toBeCloseTo(0, 6);
    }
    // In dollars the cash account's P/L on the dividend day is the rate's move on the pesos it
    // held the day before — the same figure a cash account that received no dividend would read.
    const cashUsd = getBucketDailySeries([ref(cashId)], { unit: "usd", days: 95 }).points;
    const i = cashUsd.findIndex((p) => p.as_of_date === dividendDay);
    const at = cashUsd[i]!;
    const prev = cashUsd[i - 1]!;
    expect(at.pl!).toBeCloseTo(at.value! - prev.value! - at.flow, 6);
    const dividendUsd = at.flow;
    const heldBefore = DEPOSIT - BUY;
    // value(t) = (held + dividend) / rate(t); the dividend's dollars at that same rate leave the
    // rate's move on the pesos already held.
    expect(at.pl!).toBeCloseTo((at.value! * heldBefore) / (heldBefore + DIVIDEND) - prev.value!, 2);
    expect(dividendUsd).toBeGreaterThan(0);
  });
});
