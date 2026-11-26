import type { DisplayUnitCode } from "./core.js";
/**
 * Adjustable inputs for /projections. Money inputs are today's money in the response's `unit`
 * (a request may type one in another currency: `<key>=<amount>&<key>_currency=<code>`).
 */
export interface ProjectionParams {
  real_return_pct: number;
  monthly_aporte: number;
  /** Annual inflation % per core currency (request keys `inflation_<code>_pct`). */
  inflation_pct: Record<string, number>;
  retire_return_pct: number;
  end_age: number;
  swr_pct: number;
  pct_balance_pct: number;
  monthly_income: number;
  /** % of the non-invested remainder (RE, cash) liquidated into the drawdown pot at 65. */
  liquidate_other_pct: number;
  /** Passive real monthly income during retirement (rent), today's money. */
  monthly_rent: number;
}

/** One piece of the «net worth at 65» bar, at its share of the bar's scale. */
export interface ProjectionsCompositionSegment {
  /** `loss`: negative growth, drawn over the bar's tail from `start`. */
  kind: "today" | "contributions" | "growth" | "loss";
  start: number;
  share: number;
}

/** How long a drawdown strategy's pot lasts. */
export type ProjectionsStrategyLasts =
  /** Still funded at the end age. */
  | { kind: "end_age"; age: number }
  /** The pot reaches zero at this age. */
  | { kind: "depleted"; age: number }
  /** A share of the balance: never reaches zero. */
  | { kind: "always" };

export interface ProjectionsStrategy {
  kind: "swr" | "pct_balance" | "fixed_income";
  /** The chart line of this strategy (`chart.lines[].dataKey`). */
  line_key: string;
  /** The strategy's yearly % (SWR, % of balance); null for the fixed income. */
  pct: number | null;
  /** Monthly income, passive rent included (today's money, the unit). */
  monthly_income: number;
  /** True when the income is the first month's and then follows the balance (% of balance). */
  income_is_initial: boolean;
  lasts: ProjectionsStrategyLasts;
  /** The funded part of the span retirement age → end age (0..1). */
  lasts_share: number;
}

/** The page's figures at retirement, every amount in the unit and today's money. */
export interface ProjectionsGlance {
  net_worth_at_retire: number;
  /**
   * Net worth at retirement as today's net worth + the contributions to come + real growth (the
   * three add up to it). Null when today's net worth or the projected one is not positive.
   */
  composition: {
    today: number;
    contributions: number;
    /** Negative when the real return loses more than nothing. */
    growth: number;
    /** Net worth at retirement's share of the bar's scale (1 unless growth is negative). */
    value_share: number;
    segments: ProjectionsCompositionSegment[];
  } | null;
  invested_at_retire: number;
  /** The non-invested rest (real estate, cash), flat in today's money. */
  other_at_retire: number;
  /** The drawdown pot: invested + `liquidate_other_pct` % of the rest. */
  pot_at_retire: number;
  liquidate_other_pct: number;
  /** Passive monthly income every strategy's income includes; 0 = none. */
  monthly_rent: number;
  retire_age: number;
  end_age: number;
  strategies: ProjectionsStrategy[];
}

export interface ProjectionsChartLine {
  dataKey: string;
  valueSeriesType: "data" | "reference";
  /** A constant reference level in the currency it is fixed in (dollars); null for the page's named lines. */
  milestone: { value: number; currency: string } | null;
}

export interface ProjectionsResponse {
  unit: DisplayUnitCode;
  params: ProjectionParams;
  /** The default inflation per core currency: assumptions, not forecasts. */
  inflation_default_pct: Record<string, number>;
  retire_month: string;
  retire_age: number;
  glance: ProjectionsGlance;
  chart: {
    points: Record<string, string | number | null>[];
    lines: ProjectionsChartLine[];
  };
}
