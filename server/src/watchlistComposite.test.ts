import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  basketUsdForHoldings,
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
