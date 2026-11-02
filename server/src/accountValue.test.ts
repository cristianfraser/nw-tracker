/**
 * An account's value is a quantity of what it holds, priced when it is an instrument, converted
 * once into the unit at its side of the spread (`accountValue.ts`). Synthetic far-future fixture
 * (no collision with the seeded history): a stored day 2099-01-06 at the mid 900 (no bid/ask
 * row: the sides are the mid ∓ the inferred half spread of 2), and Wednesday 2099-01-07 as
 * Chile today with the fx day open and a live CLP=X of 950.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { accountHoldingQtyAt, accountValueAt } from "./accountValue.js";
import { holdingPriceAt } from "./holdingPrices.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountValueSeriesOnGrid } from "./accountMarkDailyCache.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { insertLiveMarketQuote } from "./liveMarketQuotesDb.js";

const PAST = "2099-01-06";
const TODAY = "2099-01-07";
const NOW = new Date("2099-01-07T15:00:00.000Z"); // 12:00 Chile, 10:00 New York: fx day open
const MID = 900;
const LIVE = 950;
const HALF = 2;
const TICKER = "VITESTHOLDUSD";
const SERIES = "afp_vitestholding_cuota_a";

const created = { accounts: [] as number[], groups: [] as number[] };

function leafId(slug: string): number {
  const r = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (!r) throw new Error(`no asset group ${slug} in the test DB`);
  return r.id;
}

function account(name: string, groupSlug: string, extra: { ticker?: string; series?: string } = {}): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?)`
      )
      .run(leafId(groupSlug), `Vitest · holding value ${name}`, extra.ticker ?? null, extra.series ?? null)
      .lastInsertRowid
  );
  created.accounts.push(id);
  return id;
}

function move(accountId: number, on: string, amount: number, currency: string, flowKind: string | null, units: number | null) {
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, amount, currency, on, flowKind, units);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`).run(PAST, MID);
  db.prepare(`INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, 50, 'usd')`).run(
    TICKER,
    PAST
  );
  db.prepare(`INSERT OR REPLACE INTO fund_unit_daily (series_key, day, unit_value, currency) VALUES (?, ?, 1000, 'clp')`).run(
    SERIES,
    PAST
  );
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    currency: null,
    value: LIVE,
    session_ymd: TODAY,
    previous_value: MID,
    fetched_at: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  clearAggregationCache();
});

afterEach(() => {
  for (const id of created.accounts.splice(0)) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
  for (const id of created.groups.splice(0)) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(PAST);
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
  db.prepare(`DELETE FROM live_market_quotes WHERE symbol = ? AND session_ymd >= '2099-01-01'`).run(LIVE_FX_SYMBOL);
  vi.useRealTimers();
  clearAggregationCache();
});

describe("accountValueAt — one conversion from what the account holds", () => {
  it("dollar cash: its dollars in USD; in pesos at the sell rate, today's live one today", () => {
    const panel = createPanelAccount({
      account: { account_type: "usd_cash", name: "vitest-holding-usd", bucket_slug: "cash_savings", exclude_from_group_totals: false },
    });
    created.accounts.push(panel.account_id);
    if (panel.created_leaf_bucket) created.groups.push(panel.asset_group_id);
    move(panel.account_id, "2099-01-02", 100, "usd", "compra_usd", null);

    expect(accountHoldingQtyAt(panel.account_id, PAST)).toMatchObject({ qty: 100, holding: { kind: "currency", code: "usd" } });
    expect(accountValueAt(panel.account_id, PAST, "usd")?.value).toBeCloseTo(100, 9);
    expect(accountValueAt(panel.account_id, PAST, "clp")?.value).toBeCloseTo(100 * (MID - HALF), 6);
    // The issue that started the holdings model: today follows the live rate, so its day P/L
    // in pesos moves with the peso.
    expect(accountValueAt(panel.account_id, TODAY, "clp")?.value).toBeCloseTo(100 * (LIVE - HALF), 6);
    expect(accountMarkClpAtYmd(panel.account_id, TODAY)?.value_clp).toBeCloseTo(100 * (LIVE - HALF), 6);
    expect(accountValueAt(panel.account_id, TODAY, "usd")?.value).toBeCloseTo(100, 9);
  });

  it("dollar stock: shares × dollar price in USD, never pesos ÷ a rate; pesos at the sell rate", () => {
    const id = account("stock", "brokerage_acciones__aapl", { ticker: TICKER });
    move(id, "2099-01-02", 0, "usd", "stock_buy", 10);

    const q = accountHoldingQtyAt(id, PAST);
    expect(q).toMatchObject({ qty: 10, holding: { kind: "stock", ticker: TICKER, quote: "usd" } });
    expect(holdingPriceAt({ kind: "stock", ticker: TICKER, quote: "usd" }, PAST)).toEqual({
      price: 50,
      currency: "usd",
      as_of: PAST,
    });
    expect(accountValueAt(id, PAST, "usd")?.value).toBeCloseTo(500, 9);
    expect(accountValueAt(id, PAST, "clp")?.value).toBeCloseTo(500 * (MID - HALF), 6);
    // The daily quantity series reads the same values in every unit.
    expect(accountValueSeriesOnGrid({ account_id: id, bucket_slug: "brokerage_acciones__aapl" }, [PAST], "usd")).toEqual([
      accountValueAt(id, PAST, "usd")!.value,
    ]);
  });

  it("a peso fund: cuotas × peso price; in USD at the buy rate, today's live one today", () => {
    const id = account("fund", "retirement_afp_afc__afp", { series: SERIES });
    move(id, "2099-01-02", 0, "clp", null, 10);

    expect(accountHoldingQtyAt(id, PAST)).toMatchObject({ qty: 10, holding: { kind: "fund", seriesKey: SERIES } });
    expect(holdingPriceAt({ kind: "fund", seriesKey: SERIES, quote: "clp" }, PAST)?.price).toBe(1000);
    expect(accountValueAt(id, PAST, "clp")?.value).toBe(10_000);
    expect(accountValueAt(id, PAST, "usd")?.value).toBeCloseTo(10_000 / (MID + HALF), 9);
    expect(accountValueAt(id, TODAY, "usd")?.value).toBeCloseTo(10_000 / (LIVE + HALF), 9);
  });

  it("a peso book mark in USD at the buy rate", () => {
    const id = account("book", "brokerage_acciones__aapl");
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, '2099-01-05', 1000000, 'clp')`).run(id);
    expect(accountHoldingQtyAt(id, PAST)).toMatchObject({ qty: 1_000_000, holding: { kind: "currency", code: "clp" } });
    expect(accountValueAt(id, PAST, "usd")?.value).toBeCloseTo(1_000_000 / (MID + HALF), 9);
  });
});
