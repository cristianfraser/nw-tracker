import type { DTO_SCHEMA_VERSIONS } from "./schemaVersions.js";
import type {
  AccountMonthlyPerformanceRow,
  PositionGlanceDto,
  PositionGlancePeriodDto,
  PositionGlancePricingDto,
  PositionGlanceSparkRange,
} from "./accounts.js";
import type { PeriodReturnsPayload } from "./performance.js";
import type { FxCoverage, DisplayUnitCode, UnitsKind } from "./core.js";
import type { Money, ShownName, ShownNameDetail } from "./flows.js";
import type { UpcomingPaymentsDto } from "./creditCard.js";
import type {
  DashboardAccountRow,
  DashboardNwBucketTotals,
  DashboardResponse,
  ValuationTimeseriesResponse,
  ValueSeriesType,
} from "./dashboard.js";

/** `GET /api/groups/:slug/performance-monthly` — derived, not stored. */
export interface GroupMonthlyPerformanceBarAccount {
  account_id: number;
  name: string;
  /** i18n key for server-grouped bucket bars; client resolves at render (falls back to `name`). */
  name_i18n_key?: string | null;
  bar_data_key: string;
  color_rgb?: string;
}

export interface GroupMonthlyPerformanceGroupedBars {
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
}

export interface GroupMonthlyPerformanceResponse {
  unit: DisplayUnitCode;
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
  /** Server-side "Agrupado" bucket bars (built from unclipped per-account P/L). */
  nav_grouped_bars?: {
    grouped?: GroupMonthlyPerformanceGroupedBars;
    ungrouped?: GroupMonthlyPerformanceGroupedBars;
  };
  liab_grouped_bars?: GroupMonthlyPerformanceGroupedBars;
}

export interface DashboardChartShapeLine {
  dataKey: string;
  name: string;
  valueSeriesType: ValueSeriesType;
  account_id?: number;
  color_rgb?: string;
  /** See `TimeseriesBlock.lines[].level_currency`. */
  level_currency?: DisplayUnitCode;
}

/**
 * Dashboard chart skeleton — line specs, x-axis start, and which optional sections exist —
 * so every chart/section mounts empty (correct shape) before the page bundle resolves.
 */
export interface DashboardChartShape {
  /** Earliest valuation date; chart x-axes start on its month. Null on an empty DB. */
  first_month: string | null;
  overview_lines: DashboardChartShapeLine[];
  has_perf_sections: boolean;
}

/** `GET /api/dashboard/nav-snapshot` — card strip shape (no valuation TS). */
export interface DashboardNavSnapshotResponse {
  /** `DTO_SCHEMA_VERSIONS.nav_strip`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["nav_strip"];
  /** The display unit of every money field of the payload. */
  unit: DisplayUnitCode;
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  nw_bucket_totals: DashboardNwBucketTotals;
  card_metrics_by_slug: DashboardResponse["card_metrics_by_slug"];
  value_map?: DashboardResponse["value_map"];
  value_map_color_bounds?: DashboardResponse["value_map_color_bounds"];
  chart_shape?: DashboardChartShape;
}

/**
 * Nav snapshot as read from a persisted cache: entries written by older app versions may
 * predate `liabilities_breakdown` / `nw_bucket_totals` (placeholder paths guard for this).
 */
export type CachedDashboardNavSnapshot = Omit<
  DashboardNavSnapshotResponse,
  "liabilities_breakdown" | "nw_bucket_totals"
> &
  Partial<Pick<DashboardNavSnapshotResponse, "liabilities_breakdown" | "nw_bucket_totals">>;

/** `GET /api/dashboard/nav-context` — nav strip + overview in one response. */
export interface DashboardNavContextResponse {
  /** `DTO_SCHEMA_VERSIONS.nav_strip`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["nav_strip"];
  /** The display unit of every money field of the payload. */
  unit: DisplayUnitCode;
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  /** Live NW bucket totals + prior closes (same as page-bundle `dash.totals` buckets). */
  nw_bucket_totals: DashboardNwBucketTotals;
  card_metrics_by_slug: DashboardResponse["card_metrics_by_slug"];
  value_map?: DashboardResponse["value_map"];
  value_map_color_bounds?: DashboardResponse["value_map_color_bounds"];
  /**
   * The basket page's «at a glance» block when the page's node (`root`) is a group declared a
   * basket (`portfolio_groups.basket`, `NavTreeNodeDto.basket`); null for every other root.
   * Built with this payload (`basketGlance.ts`), so it shares its cache entry and lifetime.
   */
  basket_glance?: BasketGlanceDto | null;
  /**
   * The group page's «at a glance» block when the page's node (`root`) has
   * `NavTreeNodeDto.investment_glance` (a group at or under «Inversiones», not a basket) or
   * `NavTreeNodeDto.cash_glance` (a group of the cash bucket); null for every other root. Built
   * with this payload (`groupGlance.ts`), so it shares its cache entry.
   */
  group_glance?: GroupGlanceDto | null;
}

/**
 * One row of an investment group page's children table (`docs/investment-group-pages-plan.md`).
 * Every money figure is in the display unit, from the card metrics (a group) or the dashboard
 * row (an account), so the table equals the cards and «Detalle».
 */
export interface GroupGlanceRowDto {
  /**
   * "group" = a child nav group (or the page's own group for the total row), "account" = a direct
   * account, "linked_cards" = what the linked credit cards owe, as the negative amount a cash
   * group's total nets (a cash glance only; `slug` and `route_path` are the cards' group's).
   */
  kind: "group" | "account" | "linked_cards";
  /** Group and linked-cards rows. */
  slug: string | null;
  /** Account rows. */
  account_id: number | null;
  /** The nav label / account name (the server's; translate `label_i18n_key` when present). */
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  /**
   * The id of this child's line in the grouped valuation block / bar key in the grouped P/L bars
   * (`nav_grouped_blocks.grouped`, `nav_grouped_bars.grouped`: a synthetic negative id for a
   * bucket line, the account's own id when the page draws per-account lines), so the client takes
   * its colour from the same colour map the charts use; null for the total row and for basket members.
   */
  chart_line_account_id: number | null;
  color_rgb: string | null;
  /** Today, display unit. */
  value: Money;
  /**
   * value ÷ the group's value (0..1); 1 on the total row; 0 when sold out. On a cash glance the
   * base is the accounts' positive balances (0 for an account worth 0 or less and for the cards).
   */
  share: number;
  /** The card's chained %s (a child: `row_pct`; the total row: `parent_pct`; an account: its row's `pct_*`). */
  day_pct: number | null;
  month_pct: number | null;
  year_pct: number | null;
  /** Lifetime P/L (the card's `delta_total`, the row's `delta_total`). */
  total_pl: Money | null;
  /** Compounded all-time return (the `total` % cell, the row's `pct_total`). */
  total_pct: number | null;
  /** Lifetime aportes (net deposits). */
  deposits: Money | null;
  /**
   * A cash glance's rows: the balance in the currency each account holds, one entry per currency,
   * largest value in the display unit first (an account has one; a group one per currency its
   * accounts hold; the linked cards their peso total, negative). Empty on an investment glance.
   */
  native: Money[];
  /**
   * A cash glance's rows: today's value less the value at the end of the previous month / year,
   * each at its own day's rate, in the display unit. Null on an investment glance.
   */
  change: { month: Money; year: Money } | null;
  /** Holds something today. */
  held: boolean;
  /** One year ending today, own scale: up to ~60 points, x/y in 0..1 (x by calendar day from today−364). */
  spark: { x: number; y: number }[];
  /**
   * The same year as performance: the row's daily returns (the ones its % cells compound) chained
   * from its first held day in the window, on one scale per level drawn together — the total with
   * the page's rows (`perf_zero_y` is 0 %), a row's members with each other (that row's
   * `members_perf_zero_y`); no point before it first held something or after it sold out.
   */
  perf_spark: { x: number; y: number }[];
  /** Where 0 % sits on the scale of this row's members' `perf_spark` (0..1); null without members. */
  members_perf_zero_y: number | null;
  /**
   * One level under a child row: a basket's member accounts, any other child group's own rows (its
   * sub-groups and accounts, as its page lists them, without members of their own); empty for an
   * account, the total row and the members themselves.
   */
  members: GroupGlanceRowDto[];
}

/** One currency of a cash group: what its accounts hold in it. */
export interface GroupGlanceCurrencyDto {
  currency: string;
  /** Σ of the balances held in the currency, in that currency. */
  native: Money;
  /** The same balances in the display unit (Σ of the accounts' values). */
  value: Money;
  /** value ÷ Σ of the currencies' positive values (0..1); 0 for a currency worth 0 or less. */
  share: number;
}

/** What a cash group's page shows in place of the investment figures (`GroupGlanceDto.cash`). */
export interface GroupGlanceCashDto {
  /** The accounts' balances by the currency they hold, largest value first; the linked cards are not in it. */
  by_currency: GroupGlanceCurrencyDto[];
  /**
   * What the linked credit cards owe, as the negative amount the group's value nets; null for a
   * group that nets none (or cards owing nothing).
   */
  linked_cards: { label: string; label_i18n_key: string | null; route_path: string; value: Money } | null;
  /**
   * The change of the group's value over the day, the month and the year (today less yesterday's,
   * the previous month-end's and the previous year-end's value, each at its own day's rate): `pl`
   * is the change, `pct` always null, `share` its size against the largest of the three.
   */
  change: { day: PositionGlancePeriodDto; month: PositionGlancePeriodDto; year: PositionGlancePeriodDto };
}

/** The group page's «at a glance» block (`groupGlance.ts`); the client only picks and formats. */
export interface GroupGlanceDto {
  slug: string;
  title: string;
  unit: DisplayUnitCode;
  /**
   * "investment": a group at or under «Inversiones». "cash": a group of the cash bucket — no
   * return figures (`composition` null, the rows' % and P/L null, no `perf_spark`), `cash` set,
   * and `value` the node's value by the node-value rule: its accounts less the linked cards where
   * the group nets them, so the rows add up to it.
   */
  kind: "investment" | "cash";
  /** A cash group's own figures; null on an investment glance. */
  cash: GroupGlanceCashDto | null;
  value: Money;
  /**
   * `day` and `periods` are the group's page card on both kinds: its P/L and %. On a cash glance
   * that is the result of holding the cash (the fx on another currency, interest, fees), without
   * the linked cards — not the change of the balance, which is `cash.change`.
   */
  day: PositionGlancePeriodDto;
  /**
   * Summed over the group's member accounts on the last day any held something (today while one
   * does), the basket composition's rule; null when the deposited figure cannot be computed and
   * on a cash glance.
   */
  composition: PositionGlanceDto["composition"];
  periods: { day: PositionGlancePeriodDto; month: PositionGlancePeriodDto; year: PositionGlancePeriodDto };
  /** The total row (the group itself). */
  total: GroupGlanceRowDto;
  /** Children: held ones heaviest first, then sold-out ones (by total P/L magnitude). */
  rows: GroupGlanceRowDto[];
  /** Where 0 % sits on the scale of the total's and the rows' `perf_spark` (0..1, from the bottom). */
  perf_zero_y: number;
}

/** One member account of a basket, as the breakdown block lists it. */
export interface BasketGlanceMemberDto {
  account_id: number;
  /** The account's name (the dashboard row's). */
  name: string;
  /** The member's own page (`/account/<id>`). */
  route_path: string;
  /** Today's value in the display unit (the dashboard row's `current_value`, the card's member figure). */
  value: Money;
  /**
   * Share of the basket, 0..1: value ÷ Σ of the members' positive values (so the shares of the
   * members with a positive value add up to 1); 0 for a member worth 0 or less.
   */
  share: number;
  /** True while the member holds something today (units, or a cash balance). */
  held: boolean;
  /** The units held today (the dashboard row's position); null for a cash member. */
  units: { amount: number; kind: UnitsKind } | null;
  /**
   * A unit-position member that holds units today: its unit price and average cost, the same
   * figures its own page shows (`positionGlance.ts`: today's price, the FIFO average cost of the
   * units held, compared at the quote currency's minor digits). Null for a cash member and for a
   * member that holds no units today.
   */
  quote: {
    /** In the quote currency. */
    price: Money;
    price_as_of: string;
    /** Average cost per unit, in the quote currency. */
    average_cost: Money;
    /** The colour of the member's price pill. */
    price_vs_cost: PositionGlancePricingDto["price_vs_cost"];
  } | null;
}

/** A point of the basket's value index: its level (1 = the day before its first return) and its place on the chart. */
export interface BasketGlanceSparkPointDto {
  date: string;
  /** The index level: the basket's daily flow-adjusted returns compounded (a growth factor, not money). */
  level: number;
  /** Position 0..1 on the range's time axis (`from` = 0, `to` = 1), by calendar day. */
  x: number;
  /** Height 0..1 between the sparkline's `low` (0) and `high` (1). */
  y: number;
}

/**
 * The basket's value index over one range — the same axis and held-stretch rules as a position's
 * price sparkline (`PositionGlanceSparklineDto`), with index levels in place of unit prices.
 */
export interface BasketGlanceSparklineDto {
  range: PositionGlanceSparkRange;
  /** N days ending today (today included); `total` starts at the index's first day. */
  from: string;
  to: string;
  /** At most ~150 points (evenly sampled; first and last kept); the last is today's level. */
  points: BasketGlanceSparkPointDto[];
  /** The vertical range: covers the range's points and the cost level when there is one. */
  low: number;
  high: number;
  /**
   * The cost reference line's height (0..1): the level at which the basket would be worth its
   * deposited capital — the level on `composition.as_of` × deposited ÷ value on that day (the
   * holdings of that day moving with the index, no further flows). It reads like a position's
   * average-cost line: the cost of what is held now, drawn across the history. Null when the
   * composition is null, its deposited capital is ≤ 0 (all capital withdrawn: no cost level) or
   * the basket was worth nothing then.
   */
  cost_y: number | null;
  /** The stretches any member held something, as 0..1 positions on the axis (ascending, apart). */
  held: { start: number; end: number }[];
}

/**
 * The basket page's «at a glance» block: a portfolio group declared a basket, shown as one
 * position. Every figure, share and comparison is decided by the server (`basketGlance.ts`); the
 * client formats and lays out. Money in the display unit is `{value, currency: unit}`.
 */
export interface BasketGlanceDto {
  /** The group's slug and label (the title line). */
  slug: string;
  title: string;
  unit: DisplayUnitCode;
  /** Today's value: the group's page card value (`card_metrics_by_slug[slug].value.parent`). */
  value: Money;
  /** The members, heaviest first (value descending, then name). */
  members: BasketGlanceMemberDto[];
  /**
   * value = deposited + state bonus + price + dividends, summed over the members on the last day
   * the basket held anything (today while any member holds units or cash), built by the account
   * composition's own rule (`compositionFromParts` in `positionGlance.ts`, the segment rules of
   * `PositionGlanceDto.composition`). A cash member's money counts as deposited capital (its own
   * result — fees, interest — lands in `price`); money moved between members nets out. Null as
   * the account's is (a deposited figure that cannot be computed).
   */
  composition: PositionGlanceDto["composition"];
  /** The basket's value index, one block per `PositionGlanceSparkRange`, in that order; empty when it has no daily return yet. */
  sparklines: BasketGlanceSparklineDto[];
  /** Día / mes / año: the group card's own metrics (`parent` variant P/L, `parent_pct` %). */
  periods: { day: PositionGlancePeriodDto; month: PositionGlancePeriodDto; year: PositionGlancePeriodDto };
}

/** `GET /api/dashboard/page-bundle` — home dashboard in one response. */
export interface DashboardPageBundleResponse {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx_coverage: FxCoverage | null;
  inversionesPerf: InversionesPerfMonthlyResponse;
  upcoming_payments: UpcomingPaymentsDto;
}

/**
 * One period of the home «PL inversiones» combo, built on the server
 * (`inversionesPerfSeries.ts`): class P/L bars, Σ Δ, the YTD and all-time running P/L.
 */
export interface InversionesPerfPoint {
  as_of_date: string;
  delta_retirement: number;
  delta_brokerage: number;
  delta_combined: number;
  ytd_combined: number;
  accumulated_earnings: number;
  /** Fractions (0.05 = 5%), null where the period has no return. Compounded by the server. */
  pct_retirement: number | null;
  pct_brokerage: number | null;
  /** Inversiones' return over the period, its YTD and its all-time return through the point. */
  pct_combined: number | null;
  ytd_pct: number | null;
  accumulated_pct: number | null;
}

/** One calendar year of the «%» view: each return is compounded from the months by the server. */
export interface InversionesYearlyPctPoint {
  as_of_date: string;
  pct_retirement: number | null;
  pct_brokerage: number | null;
  pct_combined: number | null;
  ytd_pct: number | null;
  accumulated_pct: number | null;
}

/** The page bundle's `inversionesPerf`: one point per month of the inversiones consolidation. */
export interface InversionesPerfMonthlyResponse {
  unit: DisplayUnitCode;
  points: InversionesPerfPoint[];
  /** One point per calendar year (a year's % is not a sum of its months' %). */
  yearly_pct: InversionesYearlyPctPoint[];
}

export type ConsolidatedMonthlyPerfRow = {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  /**
   * The YTD % at this row's date: the scope's daily returns of the row's calendar year compounded
   * through its date — the Rentabilidad YTD rule (`periodPctDailyChain.ts`). Absent where the
   * scope keeps the one-step % (liability-only scopes, a legacy group sub-tab) — those % are a
   * cost, not a return; null when no day of the year has a return. On a yearly row it is the
   * latest month's (= the year's YTD through its last month).
   */
  ytd_pct?: number | null;
  /** Net worth's server-paginated rows only: the month's (or year's) income and expenses. */
  income?: number;
  expenses?: number;
};

export interface GroupConsolidatedTablesResponse {
  unit: DisplayUnitCode;
  group_slug: string;
  account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
  /** The server's yearly rollup of `consolidated_monthly`, newest first. */
  consolidated_yearly: ConsolidatedMonthlyPerfRow[];
  /** Chained flow-adjusted period returns; null for non-investment groups. */
  period_returns: PeriodReturnsPayload | null;
}

/** `GET /api/groups/:slug/period-returns` — the Rentabilidad table alone (home dashboard). */
export interface GroupPeriodReturnsResponse {
  unit: DisplayUnitCode;
  group_slug: string;
  period_returns: PeriodReturnsPayload | null;
}

/** Server-side paginated response shape. */
export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
};

/** `GET /api/groups/:slug/consolidated-monthly` — server-paginated detalle por mes. */
export type GroupConsolidatedMonthlyPageResponse = Paginated<ConsolidatedMonthlyPerfRow> & {
  unit: DisplayUnitCode;
  group_slug: string;
  period: "month" | "year";
};

/** `GET /api/groups/:slug/flows` and `GET /api/accounts/:id/flows` */
export type FlowsApiRow = {
  id: number;
  key: string;
  account_id: number;
  account_name: string;
  /** Portfolio bucket (nav leaf) the account files under; null when it has no tree link. */
  bucket_slug: string | null;
  /**
   * Native amount in `currency`. CLP rows are the signed per-account delta; non-CLP rows
   * carry the stored amount unsigned (direction lives in `transfer_direction`/`flow_type`).
   * Cross-currency conversions add the to-leg as `counter_amount`/`counter_currency`.
   */
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
  occurred_on: string;
  /** The stored note, as the movement editors edit it; never shown by the list. */
  note: string | null;
  /** The name the row shows (the expense lines' name rule over the note); null when the movement has no note. */
  name: ShownName | null;
  /** The stored text behind `name`, for the row's tooltip only. */
  name_detail?: ShownNameDetail;
  units_delta: number | null;
  /** A fund switch's to-leg units; null on every other row. */
  counter_units_delta: number | null;
  flow_kind: string | null;
  flow_type: string;
  flow_type_label: string;
  counterpart_account_id: number | null;
  counterpart_account_name: string | null;
  transfer_direction: "out" | "in" | null;
  /** A transfer's origin and target, whichever account views it; null on a single-account movement. */
  from_account_id: number | null;
  from_account_name: string | null;
  to_account_id: number | null;
  to_account_name: string | null;
  /** Money into or out of the row's account; null only on a movement of nothing. */
  money_direction: "in" | "out" | null;
  /** Bank date lies after today; today's balance already includes the row. */
  forward_posted: boolean;
  /** A transfer between two accounts of the page, shown once from its origin (group flows). */
  internal: boolean;
  /** The target's bucket on an internal transfer; null otherwise. */
  counterpart_bucket_slug: string | null;
};

export type FlowsFilterOptions = {
  years: string[];
  types: { value: string; label: string }[];
  accounts: { id: number; name: string }[];
  /** Portfolio buckets present in the rows; labels resolve like sidebar nav nodes. */
  buckets: { slug: string; label: string; label_i18n_key: string | null }[];
};

export type FlowsPageResponse = Paginated<FlowsApiRow> & {
  filter_options: FlowsFilterOptions;
};

/** One grouped chart line's metadata, server-emitted on the nav tree (see `chart_buckets`). */
export interface ChartBucketLineMetaDto {
  data_key: string;
  /** Synthetic negative account id — same id the real grouped block's line carries. */
  account_id: number;
  dep_key: string;
  bar_data_key: string;
  name: string;
  name_i18n_key: string | null;
  color_rgb: string | null;
}

export interface NavNodeChartBucketsDto {
  grouped?: ChartBucketLineMetaDto[];
  ungrouped?: ChartBucketLineMetaDto[];
  /** Pasivos pages: single grouped mode, no Agrupado toggle. */
  liab?: ChartBucketLineMetaDto[];
}

export interface NavTreeNodeDto {
  node_id: string;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  route_path: string;
  active_prefix: string | null;
  nav_end: boolean;
  show_leaf_hyphen: boolean;
  account_id: number | null;
  portfolio_group_id: number | null;
  /** A Pasivos group's `liability_groups.id` (its colour target); absent elsewhere. */
  liability_group_id?: number;
  /** Master account when `account_id` is a liability-view leaf (CC purchases, cupo, ledger). */
  expense_account_id: number | null;
  expense_account_slug: string | null;
  asset_group_slug: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total?: boolean;
  /**
   * Group nodes: the group is declared a basket (`portfolio_groups.basket`, set from the panel's
   * group editor) — a managed set of holdings shown as one position. Absent on leaves.
   */
  basket?: boolean;
  /**
   * The node's page is an investment group page (`group_glance` on its nav-context): a group at
   * or under «Inversiones» that is not a basket. False on every other node.
   */
  investment_glance: boolean;
  /**
   * The node's page is the same group page in its cash form (`group_glance.kind` "cash"): a group
   * of the cash bucket that is not a basket. False on every other node.
   */
  cash_glance: boolean;
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  /** `nav_bucket` = sidebar grouping only (e.g. inversiones, efectivo). */
  group_kind: "bucket" | "reference" | "nav_bucket" | "liability_group";
  /** Long zero tail: listed for chart history; omitted from group tables and strip cards. */
  chart_inactive?: boolean;
  /**
   * Group nodes: every account id in the subtree as the server links it, the chart-inactive
   * leaves the tree omits included — card metrics, table coverage and the value map read
   * membership from here, never from slug prefixes. Absent on account leaves.
   */
  member_account_ids?: number[];
  /**
   * Groups from elsewhere in the tree that belong on this node's page as sibling cards
   * (Efectivo hosts the Pasivos credit-card group, whose balance nets into its total).
   * Server-declared from the single-source chart reference overlays; resolve against the
   * sidebar nav — an unknown slug is skipped, never synthesized.
   */
  linked_card_slugs?: string[];
  /**
   * Grouped chart structure for this node's page — the same bucket lines the real grouped
   * blocks carry, so the loading skeleton renders the final chart shape (grouped from first
   * paint). Absent ⇔ the real payload has no grouped blocks for this node.
   */
  chart_buckets?: NavNodeChartBucketsDto;
  children: NavTreeNodeDto[];
}

export interface SidebarNavResponse {
  /** `DTO_SCHEMA_VERSIONS.sidebar_nav`: the client stores this payload under that version. */
  schema_version: (typeof DTO_SCHEMA_VERSIONS)["sidebar_nav"];
  dashboard: NavTreeNodeDto | null;
  /** `portfolio_groups.slug = net_worth` — label for home route and page title. */
  net_worth: NavTreeNodeDto | null;
  main: NavTreeNodeDto[];
  flows: NavTreeNodeDto | null;
  projections: NavTreeNodeDto | null;
  wealth_percentile: NavTreeNodeDto | null;
  tax_return: NavTreeNodeDto | null;
  rates: NavTreeNodeDto | null;
}
