import type { AccountMonthlyPerformanceRow } from "./accounts";
import type { FxCoverage } from "./core";
import type { DashboardAccountRow, DashboardResponse, FxLatest, ValuationTimeseriesResponse, ValueSeriesType } from "./dashboard";

/** `GET /api/groups/:slug/performance-monthly` — derived, not stored. */
export interface GroupMonthlyPerformanceBarAccount {
  account_id: number;
  name: string;
  bar_data_key: string;
  color_rgb?: string;
}

export interface GroupMonthlyPerformanceResponse {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
}

export interface DashboardChartShapeLine {
  dataKey: string;
  name: string;
  valueSeriesType: ValueSeriesType;
  account_id?: number;
  color_rgb?: string;
}

/**
 * Dashboard chart skeleton — line specs, x-axis start, and which optional sections exist —
 * so every chart/section mounts empty (correct shape) before the page bundle resolves.
 */
export interface DashboardChartShape {
  /** Earliest valuation date; chart x-axes start on its month. Null on an empty DB. */
  first_month: string | null;
  overview_lines: DashboardChartShapeLine[];
  primary_lines: DashboardChartShapeLine[];
  has_patrimonio_usd_chart: boolean;
  has_perf_sections: boolean;
}

/** `GET /api/dashboard/nav-snapshot` — card strip shape (no valuation TS). */
export interface DashboardNavSnapshotResponse {
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  nw_bucket_totals: DashboardNavContextResponse["nw_bucket_totals"];
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
  accounts: DashboardAccountRow[];
  liabilities_breakdown: DashboardResponse["liabilities_breakdown"];
  dashboard_layout?: DashboardResponse["dashboard_layout"];
  cash_credit_card_links: DashboardResponse["cash_credit_card_links"];
  /** Live NW bucket totals + prior closes (same as page-bundle `dash.totals` buckets). */
  nw_bucket_totals: Pick<
    DashboardResponse["totals"],
    | "net_worth_clp"
    | "real_estate_clp"
    | "retirement_clp"
    | "brokerage_clp"
    | "cash_eqs_clp"
    | "prior_closes"
  > &
    Partial<
      Pick<
        DashboardResponse["totals"],
        "net_worth_usd" | "real_estate_usd" | "retirement_usd" | "brokerage_usd" | "cash_eqs_usd"
      >
    >;
  overview: ValuationTimeseriesResponse["overview"];
  fx_coverage: FxCoverage | null;
  /** Month/year metrics for the inversiones nav hub (canonical consolidated series). */
  inversiones_period_metrics?: {
    month: {
      closing_clp: number;
      prior_closing_clp: number | null;
      net_capital_flow_clp: number;
      nominal_pl_clp: number | null;
      balance_delta_clp: number | null;
    } | null;
    year: {
      closing_clp: number;
      prior_closing_clp: number | null;
      net_capital_flow_clp: number;
      nominal_pl_clp: number | null;
      balance_delta_clp: number | null;
    } | null;
  };
}

/** `GET /api/dashboard/page-bundle` — home dashboard in one response. */
export interface DashboardPageBundleResponse {
  dash: DashboardResponse;
  ts: ValuationTimeseriesResponse;
  fx: FxLatest | null;
  fx_coverage: FxCoverage | null;
  retirementPerf: GroupMonthlyPerformanceResponse | null;
  brokeragePerf: GroupMonthlyPerformanceResponse | null;
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
};

export interface GroupConsolidatedTablesResponse {
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[];
  consolidated_monthly: ConsolidatedMonthlyPerfRow[];
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
  unit: "clp" | "usd" | "uf";
  group_slug: string;
  period: "month" | "year";
};

/** `GET /api/groups/:slug/flows` and `GET /api/accounts/:id/flows` */
export type FlowsApiRow = {
  id: number;
  key: string;
  account_id: number;
  account_name: string;
  category_slug: string;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
  flow_type: string;
  flow_type_label: string;
  counterpart_account_id: number | null;
  counterpart_account_name: string | null;
  transfer_direction: "out" | "in" | null;
};

export type FlowsFilterOptions = {
  years: string[];
  types: { value: string; label: string }[];
  accounts: { id: number; name: string }[];
  categories: string[];
};

export type FlowsPageResponse = Paginated<FlowsApiRow> & {
  filter_options: FlowsFilterOptions;
};

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
  /** Master account when `account_id` is a liability-view leaf (CC purchases, cupo, ledger). */
  source_account_id: number | null;
  expense_account_id: number | null;
  expense_account_slug: string | null;
  asset_group_slug: string | null;
  kind_slug: string | null;
  dashboard_bucket_slug: string | null;
  exclude_from_parent_total?: boolean;
  api_group: string | null;
  api_subgroup: string | null;
  color_rgb: string | null;
  color: string | null;
  /** `nav_bucket` = sidebar grouping only (e.g. inversiones, efectivo). */
  group_kind: "bucket" | "reference" | "nav_bucket" | "liability_group";
  /** Long zero tail: listed for chart history; omitted from group tables and strip cards. */
  chart_inactive?: boolean;
  children: NavTreeNodeDto[];
}

export interface SidebarNavResponse {
  dashboard: NavTreeNodeDto | null;
  /** `portfolio_groups.slug = net_worth` — label for home route and page title. */
  net_worth: NavTreeNodeDto | null;
  main: NavTreeNodeDto[];
  flows: NavTreeNodeDto | null;
  projections: NavTreeNodeDto | null;
  rates: NavTreeNodeDto | null;
}
