/**
 * Shape of a proxy basket's per-holding breakdown for the value map (leaf module: types only,
 * so the loader and the map builder can depend on it without depending on each other).
 *
 * Every holding the fund STATES in its latest basket gets a tile. Its `pct` is the ETF's
 * time-weighted return over the days the fund held it inside the period — a rebalance resets
 * the weights, a holding that left and came back chains both windows, the days it was out
 * contribute nothing. `contribution_pct` is the holding's share of the fund's return in the
 * period (Σ weight × daily return, fractions of the fund). `other_weight` is the non-ETF
 * sleeve (cash, bonds, futures): one neutral tile.
 */
import type { CardMetricsPeriod } from "./dashboardNavCardMetrics.js";

export type ProxyHoldingBreakdown = {
  /** The ticker as the fund states it (SPXS, not the pricing proxy SPY). */
  ticker: string;
  /** The Yahoo ticker it is priced with (`FINTUAL_TICKER_PRICE_PROXY`). */
  price_ticker: string;
  /** Share of the WHOLE fund: stated ETF-sleeve weight × the sleeve's share of assets. */
  weight: number;
  /** Held-window time-weighted return per period, fraction (0.03 = 3%), in the display unit. */
  pct: Record<CardMetricsPeriod, number | null>;
  /** Contribution to the fund's period return, fraction of the fund, in the display unit. */
  contribution_pct: Record<CardMetricsPeriod, number | null>;
  /** Calendar days in the period the fund held the ETF, out of the period's days so far. */
  days_held: Record<CardMetricsPeriod, { held: number; total: number }>;
};

export type ProxyBasketBreakdown = {
  bucket_slug: string;
  /** The stated basket the tiles come from (its positions date). */
  positions_date: string;
  /** Non-ETF share of the fund (1 − the ETF sleeve's share); 0 when the sleeve is everything. */
  other_weight: number;
  /** Stated holdings, heaviest first. */
  holdings: ProxyHoldingBreakdown[];
};
