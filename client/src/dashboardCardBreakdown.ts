import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import {
  accountBelongsToDashboardBucket,
  accountDashboardBucketSlug,
  isDashboardNwBucketSlug,
} from "./accountDashboardBucket";
import { dashboardBucketRoutePath } from "./portfolioDashboardBuckets";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import i18n from "./i18n";
import type {
  DashboardAccountRow,
  DashboardResponse,
} from "./types";

export type CardGroupMetrics = {
  /** Lifetime net deposits. */
  deposits_clp: number;
  deposits_usd?: number | null;
  /** Cumulative nominal P/L (latest performance row). */
  delta_total_clp: number | null;
  delta_total_usd?: number | null;
  /** Net deposits in the selected calendar month or year. */
  deposits_period_clp: number;
  deposits_period_usd?: number | null;
  /** Nominal P/L in the selected calendar month or year. */
  delta_period_clp: number | null;
  delta_period_usd?: number | null;
};

export type CardGroupMetricsPeriod = "month" | "year";

export type CardBreakdownLine = {
  label: string;
  clp: number;
  usd?: number | null;
  /** 0 = section; 1 = subgroup or category; 2 = leaf account / metric */
  depth: 0 | 1 | 2;
  /** React Router path when this row is navigable. */
  to?: string;
};

/** Nested breakdown tree for dashboard detail cards (`ul` > `li` > `ul` > `li`). */
export type CardBreakdownNode = {
  label: string;
  clp: number;
  usd?: number | null;
  to?: string;
  children: CardBreakdownNode[];
};

export function nestCardBreakdownLines(lines: CardBreakdownLine[]): CardBreakdownNode[] {
  const forest: CardBreakdownNode[] = [];
  let current: CardBreakdownNode | null = null;
  let currentChild: CardBreakdownNode | null = null;

  for (const line of lines) {
    const node: CardBreakdownNode = {
      label: line.label,
      clp: line.clp,
      usd: line.usd,
      to: line.to,
      children: [],
    };
    if (line.depth === 0) {
      forest.push(node);
      current = node;
      currentChild = null;
    } else if (line.depth === 1) {
      if (current) {
        current.children.push(node);
        currentChild = node;
      } else {
        forest.push(node);
        current = node;
        currentChild = null;
      }
    } else if (currentChild) {
      currentChild.children.push(node);
    } else if (current) {
      current.children.push(node);
    } else {
      forest.push(node);
    }
  }
  return forest;
}

function accountDetailPath(accountId: number): string {
  return `/account/${accountId}`;
}

/** Pasivos hipoteca leaf paired with a property row (e.g. suecia), not in `real_estate` accounts. */
function mortgageAccountForPropertyRow(
  allAccounts: DashboardAccountRow[],
  propertyRow: DashboardAccountRow | undefined
): DashboardAccountRow | undefined {
  const mortgages = allAccounts.filter(
    (a) => a.category_slug === "mortgage" && a.current_value_clp != null
  );
  if (!mortgages.length) return undefined;
  if (propertyRow) {
    const key = propertyRow.name.trim().toLowerCase();
    const byName = mortgages.find((m) => m.name.trim().toLowerCase() === key);
    if (byName) return byName;
  }
  return mortgages.length === 1 ? mortgages[0] : undefined;
}

function cashAccountPath(row: DashboardAccountRow): string {
  return accountDetailPath(row.account_id);
}

function accountHasFinitePriorClose(
  row: DashboardAccountRow,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd"
): boolean {
  const close =
    period === "year"
      ? unit === "usd"
        ? row.prior_year_close_usd
        : row.prior_year_close_clp
      : unit === "usd"
        ? row.prior_month_close_usd
        : row.prior_month_close_clp;
  return close != null && Number.isFinite(close);
}

export function cardGroupMetricsFromAccounts(
  rows: DashboardAccountRow[],
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  let deposits_clp = 0;
  let deposits_usd = 0;
  let delta_total_clp = 0;
  let delta_total_usd = 0;
  let deposits_period_clp = 0;
  let deposits_period_usd = 0;
  let delta_period_clp = 0;
  let delta_period_usd = 0;
  let anyUsdDep = false;
  let anyUsdTotalDelta = false;
  let anyUsdPeriodDep = false;
  let anyPeriodDelta = false;
  let anyUsdPeriodDelta = false;
  let anyTotalDelta = false;

  for (const r of rows) {
    deposits_clp += r.deposits_clp;
    if (r.deposits_usd != null && Number.isFinite(r.deposits_usd)) {
      deposits_usd += r.deposits_usd;
      anyUsdDep = true;
    }
    if (r.delta_total_clp != null && Number.isFinite(r.delta_total_clp)) {
      delta_total_clp += r.delta_total_clp;
      anyTotalDelta = true;
    }
    if (r.delta_total_usd != null && Number.isFinite(r.delta_total_usd)) {
      delta_total_usd += r.delta_total_usd;
      anyUsdTotalDelta = true;
    }

    const periodDepClp = period === "month" ? r.deposits_month_clp : r.deposits_year_clp;
    if (periodDepClp != null && Number.isFinite(periodDepClp)) {
      deposits_period_clp += periodDepClp;
    }

    const periodDepUsd = period === "month" ? r.deposits_month_usd : r.deposits_year_usd;
    if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
      deposits_period_usd += periodDepUsd;
      anyUsdPeriodDep = true;
    }

    if (accountHasFinitePriorClose(r, period, "clp")) {
      const periodDeltaClp = period === "month" ? r.delta_month_clp : r.delta_year_clp;
      if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
        delta_period_clp += periodDeltaClp;
        anyPeriodDelta = true;
      }
    }

    if (accountHasFinitePriorClose(r, period, "usd")) {
      const periodDeltaUsd = period === "month" ? r.delta_month_usd : r.delta_year_usd;
      if (periodDeltaUsd != null && Number.isFinite(periodDeltaUsd)) {
        delta_period_usd += periodDeltaUsd;
        anyUsdPeriodDelta = true;
      }
    }
  }

  return {
    deposits_clp,
    deposits_usd: anyUsdDep ? deposits_usd : null,
    delta_total_clp: anyTotalDelta ? delta_total_clp : null,
    delta_total_usd: anyUsdTotalDelta ? delta_total_usd : null,
    deposits_period_clp,
    deposits_period_usd: anyUsdPeriodDep ? deposits_period_usd : null,
    delta_period_clp: anyPeriodDelta ? delta_period_clp : null,
    delta_period_usd: anyUsdPeriodDelta ? delta_period_usd : null,
  };
}

/** Sum deposits + monthly Δ for accounts in a dashboard bucket (big-4 cards). */
export function cardGroupMetricsForGroup(
  accounts: DashboardAccountRow[],
  groupSlug: string,
  period: CardGroupMetricsPeriod,
  filter?: (a: DashboardAccountRow) => boolean
): CardGroupMetrics {
  if (groupSlug === "net_worth") {
    return cardGroupMetricsNetWorth(accounts, period);
  }
  const rows = accounts.filter(
    (a) =>
      accountBelongsToDashboardBucket(a, groupSlug) &&
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp) &&
      (!filter || filter(a))
  );
  return cardGroupMetricsFromAccounts(rows, period);
}

const NW_BUCKET_ORDER = ["real_estate", "retirement", "brokerage", "cash_eqs"] as const;

/** Patrimonio neto: sum metrics across RE, retiro, brokerage, efectivo (same scope as NW total). */
export function cardGroupMetricsNetWorth(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  const rows = accounts.filter((a) => {
    const dashBucket = accountDashboardBucketSlug(a);
    if (!isDashboardNwBucketSlug(dashBucket) || !(NW_BUCKET_ORDER as readonly string[]).includes(dashBucket)) {
      return false;
    }
    if (!accountCountsTowardGroupTotals(a)) return false;
    if (!isChartActiveAccount(a)) return false;
    if (a.current_value_clp == null || !Number.isFinite(a.current_value_clp)) return false;
    return true;
  });
  return cardGroupMetricsFromAccounts(rows, period);
}

function sumUsd(rows: DashboardAccountRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      sum += r.current_value_usd;
      any = true;
    }
  }
  return any ? sum : null;
}

function sumClp(rows: DashboardAccountRow[], pick: (r: DashboardAccountRow) => number): number {
  let s = 0;
  for (const r of rows) {
    s += pick(r);
  }
  return s;
}

function valueRows(accounts: DashboardAccountRow[]): DashboardAccountRow[] {
  return accounts.filter(
    (a) =>
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
}

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

function overviewBalanceAt(
  row: Record<string, string | number | null>,
  dataKey: string
): number | null {
  const v = row[dataKey];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function chileTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Last month-end or prior calendar year-end row in the overview series (anchor = Chile today). */
function priorOverviewClosePoint(
  points: Record<string, string | number | null>[],
  period: CardGroupMetricsPeriod
): Record<string, string | number | null> | null {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) =>
    String(a.as_of_date).localeCompare(String(b.as_of_date))
  );
  const today = chileTodayYmd();
  if (period === "year") {
    const y0 = today.slice(0, 4);
    let best: Record<string, string | number | null> | null = null;
    for (const row of sorted) {
      if (String(row.as_of_date).slice(0, 4) < y0) best = row;
    }
    return best;
  }
  const mk0 = today.slice(0, 7);
  let best: Record<string, string | number | null> | null = null;
  for (const row of sorted) {
    if (String(row.as_of_date).slice(0, 7) < mk0) best = row;
  }
  return best;
}

const DASHBOARD_GROUP_OVERVIEW_KEY = {
  net_worth: "total_nw",
  real_estate: "real_estate",
  retirement: "retirement",
  brokerage: "brokerage",
  cash_eqs: "cash",
} as const;

export type DashboardGroupSlug = keyof typeof DASHBOARD_GROUP_OVERVIEW_KEY;

/** Balance Δ for an arbitrary account subset: Σ current − Σ prior close (same rules as bucket cards). */
export function subsetPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  include: (a: DashboardAccountRow) => boolean
): number | null {
  const rows = accounts.filter(
    (a) =>
      include(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
  if (!rows.length) return null;

  let current = 0;
  let prior = 0;
  let counted = 0;

  for (const r of rows) {
    const close =
      period === "year"
        ? unit === "usd"
          ? r.prior_year_close_usd
          : r.prior_year_close_clp
        : unit === "usd"
          ? r.prior_month_close_usd
          : r.prior_month_close_clp;
    const cur = unit === "usd" ? r.current_value_usd : r.current_value_clp;
    if (close == null || !Number.isFinite(close)) continue;
    if (cur == null || !Number.isFinite(cur)) continue;
    current += cur;
    prior += close;
    counted += 1;
  }

  if (counted === 0) return null;
  return current - prior;
}

export function subsetTitleBalanceDeltaRounded(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  include: (a: DashboardAccountRow) => boolean
): number | null {
  const unit = showUsd ? "usd" : "clp";
  const v = subsetPeriodBalanceDeltaFromAccounts(accounts, period, unit, include);
  return v != null && Number.isFinite(v) ? Math.round(v) : null;
}

/** Single-account card title Δ (prior month/year close vs live mark). */
export function accountCardTitleBalanceDelta(
  row: DashboardAccountRow,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  return subsetTitleBalanceDeltaRounded([row], period, showUsd, () => true);
}

/** Sum deposits + P/L metrics for an arbitrary account subset. */
export function cardGroupMetricsForAccountSubset(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  include: (a: DashboardAccountRow) => boolean
): CardGroupMetrics {
  return cardGroupMetricsFromAccounts(accounts.filter(include), period);
}

/** Sum live dashboard current values for an account subset (CLP always; USD when `showUsd`). */
export function sumCurrentValueClpUsd(
  rows: DashboardAccountRow[],
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  let clp = 0;
  let usd = 0;
  let anyUsd = false;
  for (const r of rows) {
    if (r.current_value_clp != null && Number.isFinite(r.current_value_clp)) {
      clp += r.current_value_clp;
    }
    if (showUsd && r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
      usd += r.current_value_usd;
      anyUsd = true;
    }
  }
  return { clp, apiUsd: anyUsd ? usd : null };
}

export type DashboardBucketTotals = DashboardResponse["totals"];

/** Primary balance for a dashboard bucket (`GET /api/dashboard` totals — single source of truth). */
export function dashboardBucketMainValue(
  totals: DashboardBucketTotals,
  group: DashboardGroupSlug,
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  const clp = totals[`${group}_clp`];
  const usd = totals[`${group}_usd`];
  return {
    clp,
    apiUsd: showUsd && usd != null && Number.isFinite(usd) ? usd : null,
  };
}

/** Sort key for the primary balance shown on a card (matches `DashboardCardValue` / `showUsd`). */
export function dashboardCardMainSortKey(
  clp: number,
  apiUsd: number | null | undefined,
  showUsd: boolean
): number {
  if (showUsd) {
    return apiUsd != null && Number.isFinite(apiUsd) ? apiUsd : Number.NEGATIVE_INFINITY;
  }
  return Number.isFinite(clp) ? clp : Number.NEGATIVE_INFINITY;
}

/** Descending order for detail-row cards by primary balance. */
export function compareDashboardCardMainDesc(
  aClp: number,
  aUsd: number | null | undefined,
  bClp: number,
  bUsd: number | null | undefined,
  showUsd: boolean
): number {
  return dashboardCardMainSortKey(bClp, bUsd, showUsd) - dashboardCardMainSortKey(aClp, aUsd, showUsd);
}

/** Balance Δ: Σ current (live dashboard) − Σ prior period close (performance month/year-end). */
export function groupPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  return subsetPeriodBalanceDeltaFromAccounts(
    accounts,
    period,
    unit,
    (a) =>
      accountBelongsToDashboardBucket(a, groupSlug) &&
      accountCountsTowardGroupTotals(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp) &&
      (!filter || filter(a))
  );
}

/** Fallback: overview bucket total when performance prior close is missing. */
export function groupPeriodBalanceDelta(
  totals: {
    net_worth_clp: number;
    real_estate_clp: number;
    retirement_clp: number;
    brokerage_clp: number;
    cash_eqs_clp: number;
    net_worth_usd?: number | null;
    real_estate_usd?: number;
    retirement_usd?: number;
    brokerage_usd?: number;
    cash_eqs_usd?: number;
  },
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd"
): number | null {
  const dataKey = DASHBOARD_GROUP_OVERVIEW_KEY[groupSlug];
  const current =
    unit === "usd" ? totals[`${groupSlug}_usd`] : totals[`${groupSlug}_clp` as const];
  const prior = priorOverviewClosePoint(overviewPoints, period);
  const prev = prior ? overviewBalanceAt(prior, dataKey) : null;
  if (current == null || prev == null || !Number.isFinite(current) || !Number.isFinite(prev)) {
    return null;
  }
  return current - prev;
}

export function resolveGroupPeriodBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  const fromAccounts = groupPeriodBalanceDeltaFromAccounts(
    accounts,
    groupSlug,
    period,
    unit,
    filter
  );
  if (fromAccounts != null) return fromAccounts;
  return groupPeriodBalanceDelta(totals, overviewPoints, groupSlug, period, unit);
}

/** Card title: Σ live current_value − Σ prior month/year-end close. */
export function cardGroupTitleBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  groupSlug: DashboardGroupSlug,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  filter?: (a: DashboardAccountRow) => boolean
): number | null {
  if (groupSlug === "net_worth") {
    return cardGroupNetWorthTitleBalanceDelta(accounts, totals, overviewPoints, period, showUsd);
  }
  const delta = resolveGroupPeriodBalanceDelta(
    accounts,
    totals,
    overviewPoints,
    groupSlug,
    period,
    showUsd ? "usd" : "clp",
    filter
  );
  return delta != null && Number.isFinite(delta) ? Math.round(delta) : null;
}

/** Net worth card title: sum of bucket balance changes vs prior close. */
export function cardGroupNetWorthTitleBalanceDelta(
  accounts: DashboardAccountRow[],
  totals: Parameters<typeof groupPeriodBalanceDelta>[0],
  overviewPoints: Record<string, string | number | null>[],
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  const unit = showUsd ? "usd" : "clp";
  let sum = 0;
  let any = false;
  for (const slug of NW_BUCKET_ORDER) {
    const d = resolveGroupPeriodBalanceDelta(
      accounts,
      totals,
      overviewPoints,
      slug,
      period,
      unit
    );
    if (d != null && Number.isFinite(d)) {
      sum += d;
      any = true;
    }
  }
  return any ? Math.round(sum) : null;
}

export type SueciaSnapshot = {
  valor_clp: number;
  net_value_clp: number;
  mortgage_clp: number;
  valor_usd?: number | null;
  net_value_usd?: number | null;
  mortgage_usd?: number | null;
};

/** Real estate card: Suecia (net) with valor and mortgage detail lines. */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  suecia: SueciaSnapshot | null | undefined
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (!suecia && props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const propertyRow = props.find((a) => a.category_slug === "property");
  const mortgageRow = mortgageAccountForPropertyRow(accounts, propertyRow);
  const propertyName = props[0]?.name.trim().toLowerCase() ?? "suecia";
  const netFromAccount = props.length ? sumClp(props, (r) => r.current_value_clp ?? 0) : null;
  const netClp = suecia?.net_value_clp ?? netFromAccount ?? 0;
  const groupUsd = props.length ? sumUsd(props) : null;
  const propertyTo =
    propertyRow != null
      ? accountDetailPath(propertyRow.account_id)
      : dashboardBucketRoutePath("real_estate");
  const mortgageTo =
    mortgageRow != null
      ? accountDetailPath(mortgageRow.account_id)
      : liabilitiesSubgroupPath("mortgage");

  lines.push({
    label: propertyName,
    clp: netClp,
    usd: groupUsd,
    depth: 0,
    to: propertyTo,
  });

  if (suecia) {
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: suecia.valor_clp,
      usd: suecia.valor_usd,
      depth: 1,
      to: propertyTo,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: suecia.mortgage_clp,
      usd: suecia.mortgage_usd,
      depth: 1,
      to: mortgageTo,
    });
  } else if (props.length) {
    for (const r of props) {
      lines.push({
        label: r.name,
        clp: r.current_value_clp ?? 0,
        usd: r.current_value_usd ?? null,
        depth: 1,
        to: accountDetailPath(r.account_id),
      });
    }
  }
  return lines;
}

const CASH_CATEGORY_KEYS: Record<string, string> = {
  fondo_reserva: "cash.reserva",
  cuenta_corriente: "cash.checkingAccount",
  cuenta_vista: "cash.cuentaVista",
};

const CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG = "credit_card_shortfall_from_savings";

/** Cash card: savings bucket rows plus optional CC shortfall line. */
export function buildCashCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const cash = valueRows(accounts.filter((a) => accountBelongsToDashboardBucket(a, "cash_eqs")));
  return sortGroupsDesc(
    cash.map((r) => ({
      label:
        r.category_slug === CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG
          ? i18n.t("dashboard.cardBreakdown.creditCardShortfallFromSavings")
          : CASH_CATEGORY_KEYS[r.category_slug]
            ? i18n.t(CASH_CATEGORY_KEYS[r.category_slug]!)
            : r.name,
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      to:
        r.category_slug === CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG
          ? liabilitiesSubgroupPath("credit_card")
          : cashAccountPath(r),
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

const LIABILITY_KEYS = {
  mortgage: "liabilities.mortgage",
  credit_card: "liabilities.creditCard",
} as const;

/** Liabilities card: mortgage and credit card (aligned with dashboard liabilities total). */
export function buildLiabilitiesCardBreakdown(breakdown: {
  mortgage_clp: number;
  credit_card_clp: number;
  mortgage_usd?: number | null;
  credit_card_usd?: number | null;
}): CardBreakdownLine[] {
  const rows = (
    [
      {
        key: "mortgage" as const,
        clp: breakdown.mortgage_clp,
        usd: breakdown.mortgage_usd,
      },
      {
        key: "credit_card" as const,
        clp: breakdown.credit_card_clp,
        usd: breakdown.credit_card_usd,
      },
    ] as const
  ).filter((r) => r.clp > 0);
  return sortGroupsDesc(
    rows.map((r) => ({
      label: i18n.t(LIABILITY_KEYS[r.key]),
      clp: r.clp,
      usd: r.usd,
      to: liabilitiesSubgroupPath(r.key),
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

/** Rounded deposits for card metrics (matches `DashboardCardGroupMetrics`). */
export function roundedMetricDeposits(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  if (kind === "total") {
    if (showUsd) {
      if (metrics.deposits_usd != null && Number.isFinite(metrics.deposits_usd)) {
        return Math.round(metrics.deposits_usd);
      }
      return null;
    }
    return Math.round(metrics.deposits_clp);
  }
  if (showUsd) {
    if (metrics.deposits_period_usd != null && Number.isFinite(metrics.deposits_period_usd)) {
      return Math.round(metrics.deposits_period_usd);
    }
    return null;
  }
  return Math.round(metrics.deposits_period_clp);
}

/** Rounded Δ for card metrics (matches `DashboardCardGroupMetrics`). */
export function roundedMetricDelta(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  const clp = kind === "total" ? metrics.delta_total_clp : metrics.delta_period_clp;
  if (showUsd) {
    const usd = kind === "total" ? metrics.delta_total_usd : metrics.delta_period_usd;
    if (usd != null && Number.isFinite(usd)) return Math.round(usd);
    return null;
  }
  return clp != null && Number.isFinite(clp) ? Math.round(clp) : null;
}

/** Total row: deposits + lifetime Δ (same rounding as the card UI). */
export function cardMainBalanceFromMetrics(metrics: CardGroupMetrics, showUsd: boolean): number | null {
  const deposited = roundedMetricDeposits(metrics, showUsd, "total");
  const delta = roundedMetricDelta(metrics, showUsd, "total");
  if (deposited == null || delta == null) return null;
  return deposited + delta;
}

/** Period row: period deposits + period Δ (same rounding as the card UI). */
export function cardPeriodChangeFromMetrics(metrics: CardGroupMetrics, showUsd: boolean): number | null {
  const deposited = roundedMetricDeposits(metrics, showUsd, "period");
  const delta = roundedMetricDelta(metrics, showUsd, "period");
  if (deposited == null || delta == null) return null;
  return deposited + delta;
}

/** Difference between headline balance and deposits + Δ from metrics (0 = identity holds). */
export function cardMetricsMainBalanceDiff(
  metrics: CardGroupMetrics,
  mainClp: number,
  showUsd: boolean,
  tolerance = 0
): number | null {
  const fromMetrics = cardMainBalanceFromMetrics(metrics, showUsd);
  if (fromMetrics == null) return null;
  const main = showUsd ? mainClp : Math.round(mainClp);
  const diff = main - fromMetrics;
  return Math.abs(diff) <= tolerance ? 0 : diff;
}
