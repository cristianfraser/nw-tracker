import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  basketUsdForHoldings,
  compositeLiveStats,
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  type CompositeHolding,
} from "./watchlistComposite.js";
import { watchlistStatsForRow } from "./watchlistStats.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";

const TEST_BUCKET = "vitest_rn_proxy";
const COMPOSITION_DATE = "2026-06-20";

const HOLDINGS: CompositeHolding[] = [
  { ticker: "SPY", weight: 0.6, synced_at: COMPOSITION_DATE },
  { ticker: "VEA", weight: 0.4, synced_at: COMPOSITION_DATE },
];

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(TEST_BUCKET);
});

function seedCompositeFixture(): void {
  const holdings = HOLDINGS;
  let anchorBasket: number;
  try {
    anchorBasket = basketUsdForHoldings(holdings, COMPOSITION_DATE, { preferLive: false });
  } catch {
    return;
  }
  const fxRow = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(COMPOSITION_DATE) as { clp_per_usd: number } | undefined;
  if (fxRow == null || !Number.isFinite(fxRow.clp_per_usd)) return;

  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(TEST_BUCKET, COMPOSITION_DATE, anchorBasket, fxRow.clp_per_usd, COMPOSITION_DATE);
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(TEST_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

describe("watchlistComposite valuation", () => {
  it("computes basket USD from equity_daily when prices exist", () => {
    seedCompositeFixture();
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    if (holdings.length === 0) return;
    const basket = basketUsdForHoldings(holdings, COMPOSITION_DATE, { preferLive: false });
    expect(basket).toBeGreaterThan(0);
    expect(Number.isFinite(basket)).toBe(true);
  });

  it("proxy CLP scales with basket and FX vs anchor", () => {
    seedCompositeFixture();
    const meta = loadCompositeMeta(TEST_BUCKET);
    if (meta == null) return;
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    const atAnchor = proxyClpFromMeta(meta, holdings, COMPOSITION_DATE, { preferLive: false });
    expect(atAnchor).toBeCloseTo(4000, 0);
  });
});

const SESSION_BUCKET = "vitest_rn_proxy_session";
const SESSION_TICKERS = ["VITESTRNA", "VITESTRNB"] as const;
/** Mon–Fri NYSE trading days, all in the past so live-quote paths never engage. */
const SESSION_DAYS = ["2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"];
const insertedFxDates: string[] = [];

/** Synthetic tickers + closes so day_pct assertions do not depend on live-DB market data. */
function seedSessionFixture(): void {
  const closes: Record<(typeof SESSION_TICKERS)[number], number[]> = {
    VITESTRNA: [100, 101, 102, 103, 104],
    VITESTRNB: [50, 50.5, 51, 51.5, 52],
  };
  for (const ticker of SESSION_TICKERS) {
    SESSION_DAYS.forEach((day, i) => {
      db.prepare(
        `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
         ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
      ).run(ticker, day, closes[ticker][i]);
    });
  }
  for (const day of SESSION_DAYS) {
    const res = db
      .prepare(`INSERT OR IGNORE INTO fx_daily (date, clp_per_usd) VALUES (?, 950)`)
      .run(day);
    if (res.changes > 0) insertedFxDates.push(day);
  }

  const holdings: CompositeHolding[] = [
    { ticker: "VITESTRNA", weight: 0.6, synced_at: SESSION_DAYS[0]! },
    { ticker: "VITESTRNB", weight: 0.4, synced_at: SESSION_DAYS[0]! },
  ];
  const anchorBasket = basketUsdForHoldings(holdings, SESSION_DAYS[0]!, { preferLive: false });
  const fxRow = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(SESSION_DAYS[0]) as { clp_per_usd: number };
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, ?, ?, ?)`
  ).run(SESSION_BUCKET, SESSION_DAYS[0], anchorBasket, fxRow.clp_per_usd, SESSION_DAYS[0]);
  for (const h of holdings) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(SESSION_BUCKET, h.ticker, h.weight, h.synced_at);
  }
}

afterEach(() => {
  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(SESSION_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(SESSION_BUCKET);
  for (const ticker of SESSION_TICKERS) {
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
  }
  while (insertedFxDates.length > 0) {
    db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(insertedFxDates.pop());
  }
});

describe("compositeLiveStats session anchoring", () => {
  function expectedDayPct(prevYmd: string, sessionYmd: string): number {
    const meta = loadCompositeMeta(SESSION_BUCKET)!;
    const holdings = loadCompositeHoldings(SESSION_BUCKET);
    const live = proxyClpFromMeta(meta, holdings, sessionYmd, { preferLive: false });
    const prior = proxyClpFromMeta(meta, holdings, prevYmd, { preferLive: false });
    return ((live - prior) / prior) * 100;
  }

  it("pre-open Friday shows Thursday session vs Wednesday (not 0%)", () => {
    seedSessionFixture();
    // 01:00 Chile / 01:00 NY, Friday 2026-06-26 — before NYSE open.
    const now = new Date("2026-06-26T01:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-25");
    expect(stats.day_pct).not.toBeNull();
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-24", "2026-06-25"), 6);
    expect(stats.day_pct!).not.toBeCloseTo(0, 3);
  });

  it("Sunday shows Friday session vs Thursday", () => {
    seedSessionFixture();
    const now = new Date("2026-06-28T12:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-26");
    expect(stats.day_pct).not.toBeNull();
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-25", "2026-06-26"), 6);
  });

  it("after Friday close shows Friday session vs Thursday", () => {
    seedSessionFixture();
    const now = new Date("2026-06-26T18:00:00-04:00");
    const stats = compositeLiveStats(SESSION_BUCKET, now);
    expect(stats.as_of_date).toBe("2026-06-26");
    expect(stats.day_pct!).toBeCloseTo(expectedDayPct("2026-06-25", "2026-06-26"), 6);
  });
});

describe("watchlistStatsForRow composite", () => {
  it("returns CLP stats for composite row when meta exists", () => {
    seedCompositeFixture();
    const row: MarketDisplaySeriesRow = {
      id: 9999,
      slug: TEST_BUCKET,
      label: "Test proxy",
      label_i18n_key: null,
      sort_order: 0,
      kind: "composite",
      series_key: TEST_BUCKET,
      show_in_marquee: 0,
      show_in_rates: 0,
      rates_chart_title: null,
      source: "builtin",
    };
    const stats = watchlistStatsForRow(row);
    if (stats.value == null) return;
    expect(stats.value_currency).toBe("clp");
    expect(stats.changes).not.toBeNull();
  });
});
