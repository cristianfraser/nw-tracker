import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysIso } from "nw-tracker-contracts";
import { accountRowForId } from "./accountRowForMovement.js";
import { accountValueAt } from "./accountValue.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { totalDividendsInUnitForAccount } from "./equityReturns.js";
import { foreignCashBalanceAt } from "./foreignCashAccounts.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { registerInstrument } from "./marketSymbols.js";
import { insertMovement } from "./movementWrites.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import type { ShortHorizonAccountRef } from "./periodReturnsShortHorizon.js";
import { flowEventInUnit, referenceAmountAtMid } from "./rates.js";
import { convertValue } from "./valueConvert.js";

/**
 * Trades settled in euros (untangle wave 9, `ut-trade-currency`): a euro cash account, a stock
 * quoted in euros and one quoted in dollars bought from it, and a dividend paid into it. Every
 * row is written through the create API's validator, so the amounts are in the cash account's
 * own currency. The fixture is valued in pesos, dollars and euros and reports its P/L through
 * the monthly performance rows and the daily series; inside the three accounts together the
 * trades and the dividend are internal moves that net to nothing.
 */
const NOTE = "vitest-eur-trade";
/** A synthetic euro-quoted instrument, registered for the test and removed after it. */
const EUR_TICKER = "VTEURSTK";
const EUR_CLOSE_AT_BUY = 100;
const EUR_CLOSE_LATER = 110;

const UNITS = ["clp", "usd", "eur"] as const;

describe("a trade settled in euros", () => {
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  let cashId = 0;
  let eurStockId = 0;
  let usdStockId = 0;
  let usdTicker = "";
  const today = chileCalendarTodayYmd();
  const depositDay = addDaysIso(today, -100);
  const buyDay = addDaysIso(today, -90);
  const dividendDay = addDaysIso(today, -50);
  const asOf = addDaysIso(today, -10);

  const DEPOSIT = 10_000;
  const EUR_BUY = 2_000;
  const EUR_SHARES = 20;
  const USD_STOCK_BUY = 1_000;
  const USD_STOCK_SHARES = 2;
  const DIVIDEND = 50;

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

  beforeAll(() => {
    const usd = db
      .prepare(
        `SELECT s.ticker FROM market_symbols s
         WHERE s.quote_currency = 'usd' AND s.market_kind = 'nyse'
           AND EXISTS (SELECT 1 FROM equity_daily d WHERE d.ticker = s.ticker AND d.trade_date <= ?)
         ORDER BY s.ticker LIMIT 1`
      )
      .get(buyDay) as { ticker: string } | undefined;
    if (!usd) throw new Error("the test market has no dollar-quoted stock with prices");
    usdTicker = usd.ticker;

    registerInstrument(
      EUR_TICKER,
      { quote_currency: "eur", market_kind: "nyse", display_symbol: EUR_TICKER, name: "Vitest euro stock", exchange: null, instrument_type: null },
      "declared"
    );
    const insClose = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'eur')`);
    for (let d = addDaysIso(buyDay, -5); d <= today; d = addDaysIso(d, 1)) {
      insClose.run(EUR_TICKER, d, d < dividendDay ? EUR_CLOSE_AT_BUY : EUR_CLOSE_LATER);
    }

    const panelAccount = (input: Parameters<typeof createPanelAccount>[0]) => {
      const out = createPanelAccount(input);
      created.push(out);
      return out;
    };
    const cash = panelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest EUR broker cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_eur_trade_cash",
        exclude_from_group_totals: true,
      },
    });
    const eurStock = panelAccount({
      account: {
        account_type: "equity",
        bucket_slug: "brokerage_acciones",
        ticker: EUR_TICKER,
        name: "Vitest EUR stock",
        category_slug: "vitest_eur_trade_stock",
        exclude_from_group_totals: true,
      },
    });
    const usdStock = panelAccount({
      account: {
        account_type: "equity",
        bucket_slug: "brokerage_acciones",
        ticker: usdTicker,
        name: "Vitest USD stock bought in euros",
        category_slug: "vitest_eur_trade_usd_stock",
        exclude_from_group_totals: true,
      },
    });
    cashId = cash.account_id;
    eurStockId = eurStock.account_id;
    usdStockId = usdStock.account_id;

    create(cashId, { occurred_on: depositDay, flow_kind: "deposit", amount: DEPOSIT, currency: "eur" });
    create(eurStockId, {
      occurred_on: buyDay,
      flow_kind: "stock_buy",
      amount: EUR_BUY,
      currency: "eur",
      units_delta: EUR_SHARES,
      counterpart_account_id: cashId,
      counterpart_role: "from",
    });
    create(usdStockId, {
      occurred_on: buyDay,
      flow_kind: "stock_buy",
      amount: USD_STOCK_BUY,
      currency: "eur",
      units_delta: USD_STOCK_SHARES,
      counterpart_account_id: cashId,
      counterpart_role: "from",
    });
    create(eurStockId, {
      occurred_on: dividendDay,
      flow_kind: "dividend_payout",
      amount: DIVIDEND,
      currency: "eur",
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
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(EUR_TICKER);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(EUR_TICKER);
    clearAggregationCache();
  });

  it("the create API takes the cash account's currency and refuses any other on a trade", () => {
    const wrong = validateMovementCreate(
      accountRowForId(eurStockId)!,
      {
        occurred_on: buyDay,
        flow_kind: "stock_buy",
        amount: 500,
        currency: "usd",
        units_delta: 5,
        counterpart_account_id: cashId,
        counterpart_role: "from",
      },
      eurStockId
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/settles in EUR, the cash account's currency/);
    const unknown = validateMovementCreate(accountRowForId(cashId)!, {
      occurred_on: depositDay,
      flow_kind: "deposit",
      amount: 10,
      currency: "xxx",
    });
    expect(unknown.ok).toBe(false);
  });

  it("the cash account pays the buys and receives the dividend in euros", () => {
    expect(foreignCashBalanceAt(cashId, depositDay)).toBe(DEPOSIT);
    expect(foreignCashBalanceAt(cashId, buyDay)).toBe(DEPOSIT - EUR_BUY - USD_STOCK_BUY);
    expect(foreignCashBalanceAt(cashId, asOf)).toBe(DEPOSIT - EUR_BUY - USD_STOCK_BUY + DIVIDEND);
  });

  it("the euro-quoted stock is valued in pesos, dollars and euros", () => {
    const eur = EUR_SHARES * EUR_CLOSE_LATER;
    expect(accountValueAt(eurStockId, asOf, "eur")?.value).toBeCloseTo(eur, 6);
    for (const unit of ["clp", "usd"] as const) {
      const expected = convertValue(eur, "eur", unit, asOf, "asset");
      expect(expected).not.toBeNull();
      expect(accountValueAt(eurStockId, asOf, unit)?.value).toBeCloseTo(expected!, 4);
    }
  });

  it("the dollar-quoted stock bought with euros is valued from its dollar price", () => {
    const usd = accountValueAt(usdStockId, asOf, "usd")?.value;
    expect(usd).toBeGreaterThan(0);
    const eur = convertValue(usd!, "usd", "eur", asOf, "asset");
    expect(accountValueAt(usdStockId, asOf, "eur")?.value).toBeCloseTo(eur!, 4);
  });

  it("the capital events carry the euros that moved and their reference pesos", () => {
    const events = loadMergedDepositInflowEvents([eurStockId]).get(eurStockId) ?? [];
    expect(events.map((e) => e.occurred_on)).toEqual([buyDay, dividendDay]);
    expect(events.map((e) => flowEventInUnit(e, "eur"))).toEqual([EUR_BUY, -DIVIDEND]);
    expect(events.every((e) => e.amt_usd == null)).toBe(true);
    expect(events[0]!.amt).toBeCloseTo(referenceAmountAtMid(EUR_BUY, "eur", "clp", buyDay)!, 4);
    expect(events[1]!.amt).toBeCloseTo(-referenceAmountAtMid(DIVIDEND, "eur", "clp", dividendDay)!, 4);
    // The cash side mirrors each one, negated.
    const cashEvents = loadMergedDepositInflowEvents([cashId]).get(cashId) ?? [];
    const cashEur = cashEvents.map((e) => flowEventInUnit(e, "eur"));
    expect(cashEur.reduce((s, x) => s + x, 0)).toBeCloseTo(DEPOSIT - EUR_BUY - USD_STOCK_BUY + DIVIDEND, 6);
    expect(totalDividendsInUnitForAccount(eurStockId, "eur")).toBeCloseTo(DIVIDEND, 6);
  });

  it("monthly performance: the stock's P/L is its price move plus the dividend, in every unit", () => {
    const eur = monthlyPerfForAccountId(eurStockId, "eur")!;
    const flows = eur.monthly.reduce((s, m) => s + m.net_capital_flow, 0);
    expect(flows).toBeCloseTo(EUR_BUY - DIVIDEND, 6);
    const newest = <T extends { as_of_date: string }>(rows: readonly T[]): T =>
      rows.reduce((a, b) => (b.as_of_date > a.as_of_date ? b : a));
    const last = newest(eur.monthly);
    expect(last.closing_value).toBeCloseTo(EUR_SHARES * EUR_CLOSE_LATER, 6);
    // Bought at 100, now 110, plus the dividend taken out as cash.
    expect(last.cumulative_nominal_pl!).toBeCloseTo(EUR_SHARES * (EUR_CLOSE_LATER - EUR_CLOSE_AT_BUY) + DIVIDEND, 6);
    for (const unit of ["clp", "usd"] as const) {
      const rows = monthlyPerfForAccountId(eurStockId, unit)!.monthly;
      expect(rows.length).toBe(eur.monthly.length);
      const end = newest(rows);
      const closing = convertValue(EUR_SHARES * EUR_CLOSE_LATER, "eur", unit, today, "asset")!;
      // Today's close converts at the live or latest stored rate; a percent of slack covers the two.
      expect(Math.abs(end.closing_value - closing) / closing).toBeLessThan(0.02);
      const unitFlows = rows.reduce((s, m) => s + m.net_capital_flow, 0);
      expect(end.cumulative_nominal_pl!).toBeCloseTo(end.closing_value - unitFlows, 4);
      expect(end.cumulative_nominal_pl!).toBeGreaterThan(0);
    }
  });

  it("daily series: flows on the buy and dividend days, and nothing for the three accounts together", () => {
    for (const unit of UNITS) {
      const stock = getBucketDailySeries([ref(eurStockId)], { unit, days: 95 });
      const byDay = new Map(stock.points.map((p) => [p.as_of_date, p]));
      const buy = byDay.get(buyDay)!;
      const div = byDay.get(dividendDay)!;
      expect(buy.flow).toBeGreaterThan(0);
      expect(div.flow).toBeLessThan(0);
      if (unit === "eur") {
        expect(buy.flow).toBeCloseTo(EUR_BUY, 6);
        expect(buy.value!).toBeCloseTo(EUR_SHARES * EUR_CLOSE_AT_BUY, 6);
        // Bought at the day's close: no P/L on the buy day.
        expect(buy.pl!).toBeCloseTo(0, 6);
        expect(div.flow).toBeCloseTo(-DIVIDEND, 6);
        // The price steps 100 → 110 on the dividend day; the dividend itself is return too.
        expect(div.pl!).toBeCloseTo(EUR_SHARES * (EUR_CLOSE_LATER - EUR_CLOSE_AT_BUY) + DIVIDEND, 6);
      }
      // Cash and both stocks: the buys and the dividend move money inside the set.
      const all = getBucketDailySeries([ref(cashId), ref(eurStockId), ref(usdStockId)], { unit, days: 95 });
      const allByDay = new Map(all.points.map((p) => [p.as_of_date, p]));
      expect(allByDay.get(buyDay)!.flow).toBeCloseTo(0, 4);
      expect(allByDay.get(dividendDay)!.flow).toBeCloseTo(0, 4);
    }
    const allEur = getBucketDailySeries([ref(cashId), ref(eurStockId), ref(usdStockId)], { unit: "eur", days: 95 });
    const day = allEur.points.find((p) => p.as_of_date === dividendDay)!;
    // The set's P/L on the dividend day in euros: the euro stock's step and the dividend, plus
    // whatever the dollar stock and its rate did that day.
    const usdStockOnly = getBucketDailySeries([ref(usdStockId)], { unit: "eur", days: 95 }).points.find(
      (p) => p.as_of_date === dividendDay
    )!;
    expect(day.pl!).toBeCloseTo(EUR_SHARES * (EUR_CLOSE_LATER - EUR_CLOSE_AT_BUY) + DIVIDEND + usdStockOnly.pl!, 4);
  });
});
