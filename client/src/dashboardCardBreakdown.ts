import {
  accountCountsTowardGroupTotals,
  dashboardAccountCurrentValueClp,
  hasMaterialDashboardBalance,
  isChartActiveAccount,
} from "./accountGroupTotals";
import {
  accountBelongsToDashboardBucket,
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
  /** Balance change vs prior month/year-end close (Σ current − Σ prior; matches title Δ). */
  delta_period_clp: number | null;
  delta_period_usd?: number | null;
};

export type CardGroupMetricsPeriod = "day" | "month" | "year";

/**
 * Month/year-only surfaces (flow pages, detalle tables, CC rollups) clamp the global
 * D | M | Y toggle: `day` renders as the monthly view there — daily rows are a
 * net-worth-surface feature, not a flows one.
 */
export function monthYearMetricsPeriod(period: CardGroupMetricsPeriod): "month" | "year" {
  return period === "year" ? "year" : "month";
}

export type CardBreakdownLine = {
  label: string;
  clp: number;
  usd?: number | null;
  /** 0 = section; 1 = subgroup or category; 2 = leaf account / metric */
  depth: 0 | 1 | 2;
  /** React Router path when this row is navigable. */
  to?: string;
  /** Accounts whose balances roll into this row. */
  account_ids?: number[];
  /** True when every contributing account has a stale sync source. */
  sync_stale?: boolean;
};

/** Nested breakdown tree for dashboard detail cards (`ul` > `li` > `ul` > `li`). */
export type CardBreakdownNode = {
  label: string;
  clp: number;
  usd?: number | null;
  to?: string;
  account_ids?: number[];
  sync_stale?: boolean;
  children: CardBreakdownNode[];
};

export function dashboardAccountRowsById(
  rows: DashboardAccountRow[]
): Map<number, DashboardAccountRow> {
  return new Map(rows.map((r) => [r.account_id, r]));
}

export function syncStaleForAccountIds(
  accountIds: readonly number[],
  rowsById: Map<number, DashboardAccountRow>
): boolean {
  if (accountIds.length === 0) return false;
  return accountIds.every((id) => rowsById.get(id)?.sync_stale === true);
}

export function accountLineMeta(
  row: DashboardAccountRow
): Pick<CardBreakdownLine, "account_ids" | "sync_stale"> {
  return {
    account_ids: [row.account_id],
    sync_stale: row.sync_stale === true,
  };
}

export function groupLineMeta(
  accountIds: number[],
  rowsById: Map<number, DashboardAccountRow>
): Pick<CardBreakdownLine, "account_ids" | "sync_stale"> {
  return {
    account_ids: accountIds,
    sync_stale: syncStaleForAccountIds(accountIds, rowsById),
  };
}

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
      account_ids: line.account_ids,
      sync_stale: line.sync_stale,
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
  // Page-bundle rows carry group/bucket slugs but not category_slug; match either. The
  // master and its liability_view both appear — dedupe by name keeping the lowest id.
  const mortgages = allAccounts
    .filter(
      (a) =>
        (a.category_slug === "mortgage" || a.group_slug === "liabilities__mortgage") &&
        a.current_value_clp != null
    )
    .sort((a, b) => a.account_id - b.account_id);
  const byNameFirst = new Map<string, DashboardAccountRow>();
  for (const m of mortgages) {
    const key = m.name.trim().toLowerCase();
    if (!byNameFirst.has(key)) byNameFirst.set(key, m);
  }
  const unique = [...byNameFirst.values()];
  if (!unique.length) return undefined;
  if (propertyRow) {
    const key = propertyRow.name.trim().toLowerCase();
    const byName = byNameFirst.get(key);
    if (byName) return byName;
  }
  return unique.length === 1 ? unique[0] : undefined;
}

function cashAccountPath(row: DashboardAccountRow): string {
  return accountDetailPath(row.account_id);
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
  let anyTotalDelta = false;
  let anyPeriodDeltaClp = false;
  let anyPeriodDeltaUsd = false;

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

    const periodDepClp =
      period === "month"
        ? r.deposits_month_clp
        : period === "day"
          ? r.deposits_day_clp
          : r.deposits_year_clp;
    if (periodDepClp != null && Number.isFinite(periodDepClp)) {
      deposits_period_clp += periodDepClp;
    }

    const periodDepUsd =
      period === "month"
        ? r.deposits_month_usd
        : period === "day"
          ? r.deposits_day_usd
          : r.deposits_year_usd;
    if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
      deposits_period_usd += periodDepUsd;
      anyUsdPeriodDep = true;
    }

    const periodDeltaClp =
      period === "month" ? r.delta_month_clp : period === "day" ? r.delta_day_clp : r.delta_year_clp;
    if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
      delta_period_clp += periodDeltaClp;
      anyPeriodDeltaClp = true;
    }
    const periodDeltaUsd =
      period === "month" ? r.delta_month_usd : period === "day" ? r.delta_day_usd : r.delta_year_usd;
    if (periodDeltaUsd != null && Number.isFinite(periodDeltaUsd)) {
      delta_period_usd += periodDeltaUsd;
      anyPeriodDeltaUsd = true;
    }
  }

  return {
    deposits_clp,
    deposits_usd: anyUsdDep ? deposits_usd : null,
    delta_total_clp: anyTotalDelta ? delta_total_clp : null,
    delta_total_usd: anyUsdTotalDelta ? delta_total_usd : null,
    deposits_period_clp,
    deposits_period_usd: anyUsdPeriodDep ? deposits_period_usd : null,
    delta_period_clp: anyPeriodDeltaClp ? delta_period_clp : null,
    delta_period_usd: anyPeriodDeltaUsd ? delta_period_usd : null,
  };
}

/** Account scope for bucket card metrics and balance Δ (includes sold-out + chart_inactive). */
export function accountInDashboardGroupScope(
  a: DashboardAccountRow,
  groupSlug: DashboardGroupSlug,
  filter?: (a: DashboardAccountRow) => boolean
): boolean {
  if (!accountCountsTowardGroupTotals(a)) return false;
  if (filter) return filter(a);
  return accountBelongsToDashboardBucket(a, groupSlug);
}

/** Breakdown lines / visible position list (hides chart_inactive and null/zero marks). */
export function accountInDashboardGroupDisplayScope(
  a: DashboardAccountRow,
  groupSlug: DashboardGroupSlug,
  filter?: (a: DashboardAccountRow) => boolean
): boolean {
  if (!accountInDashboardGroupScope(a, groupSlug, filter)) return false;
  if (!isChartActiveAccount(a)) return false;
  return hasMaterialDashboardBalance(a);
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

function valueRows(accounts: DashboardAccountRow[], groupSlug?: DashboardGroupSlug): DashboardAccountRow[] {
  if (groupSlug) {
    return accounts.filter((a) => accountInDashboardGroupDisplayScope(a, groupSlug));
  }
  return accounts.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      hasMaterialDashboardBalance(a)
  );
}

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

export type DashboardGroupSlug = "net_worth" | "real_estate" | "retirement" | "brokerage" | "cash_eqs";

/** Balance Δ for an arbitrary account subset: Σ current − Σ prior close (same rules as bucket cards). */
export function subsetPeriodBalanceDeltaFromAccounts(
  accounts: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  unit: "clp" | "usd",
  include: (a: DashboardAccountRow) => boolean
): number | null {
  const rows = accounts.filter((a) => include(a));
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
        : period === "day"
          ? unit === "usd"
            ? r.prior_day_close_usd
            : r.prior_day_close_clp
          : unit === "usd"
            ? r.prior_month_close_usd
            : r.prior_month_close_clp;
    const cur =
      unit === "usd"
        ? r.current_value_usd != null && Number.isFinite(r.current_value_usd)
          ? r.current_value_usd
          : 0
        : dashboardAccountCurrentValueClp(r);
    if (close == null || !Number.isFinite(close)) continue;
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

/** Sum live dashboard current values for an account subset (CLP always; USD when `showUsd`). */
export function sumCurrentValueClpUsd(
  rows: DashboardAccountRow[],
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  let clp = 0;
  let usd = 0;
  let anyUsd = false;
  for (const r of rows) {
    clp += dashboardAccountCurrentValueClp(r);
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

/** Real estate card: property (net equity) with valor and hipoteca detail lines. */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  allAccounts?: DashboardAccountRow[]
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const propertyRow = props.find(
    (a) => a.category_slug === "property" || a.bucket_slug === "real_estate__property"
  );
  const mortgageRow = mortgageAccountForPropertyRow(allAccounts ?? accounts, propertyRow);
  const propertyName = props[0]?.name.trim().toLowerCase() ?? "suecia";
  const netClp = props.length ? sumClp(props, (r) => r.current_value_clp ?? 0) : 0;
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

  if (
    props.length === 1 &&
    propertyRow != null &&
    mortgageRow?.current_value_clp != null
  ) {
    // The single card path: property rows store equity (net of the linked hipoteca), so
    // gross valor = equity + outstanding mortgage — both straight from account values.
    const mortgageClp = mortgageRow.current_value_clp;
    const mortgageUsd = mortgageRow.current_value_usd ?? null;
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: netClp + mortgageClp,
      usd: groupUsd != null && mortgageUsd != null ? groupUsd + mortgageUsd : null,
      depth: 1,
      to: propertyTo,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: mortgageClp,
      usd: mortgageUsd,
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

export const CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG = "credit_card_shortfall_from_savings";
const CHECKING_ACCOUNTS_BUCKET = "cash_eqs__checking_accounts";

export function isCashSavingsCcShortfallRow(row: { category_slug?: string | null }): boolean {
  return row.category_slug === CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG;
}

export function isCheckingPlacementRow(row: {
  bucket_slug?: string | null;
  category_slug?: string | null;
}): boolean {
  const slug = row.bucket_slug ?? "";
  if (slug === CHECKING_ACCOUNTS_BUCKET || slug.startsWith(`${CHECKING_ACCOUNTS_BUCKET}__`)) {
    return true;
  }
  return row.category_slug === "cuenta_corriente" || row.category_slug === "cuenta_vista";
}

/** Exclude synthetic CC shortfall row; caller scopes accounts to the cash_savings nav subtree. */
export function isCashSavingsAccountRow(row: { category_slug?: string | null }): boolean {
  return !isCashSavingsCcShortfallRow(row);
}

/** Savings rows whose period P/L feeds the cash_eqs bucket card (excludes checking + CC shortfall). */
export function isCashSavingsBucketPeriodPlRow(row: {
  category_slug?: string | null;
  bucket_slug?: string | null;
  dashboard_bucket_slug?: string | null;
}): boolean {
  return (
    accountBelongsToDashboardBucket(row as DashboardAccountRow, "cash_eqs") &&
    !isCheckingPlacementRow(row) &&
    !isCashSavingsCcShortfallRow(row)
  );
}

function cashBreakdownLabel(row: DashboardAccountRow): string {
  if (isCashSavingsCcShortfallRow(row)) {
    return i18n.t("dashboard.cardBreakdown.creditCardShortfallFromSavings");
  }
  if (row.category_slug && CASH_CATEGORY_KEYS[row.category_slug]) {
    return i18n.t(CASH_CATEGORY_KEYS[row.category_slug]!);
  }
  return row.name;
}

function mapCashBreakdownLine(
  row: DashboardAccountRow,
  linkShortfallToCreditCard: boolean
): CardBreakdownLine {
  return {
    label: cashBreakdownLabel(row),
    clp: row.current_value_clp ?? 0,
    usd: row.current_value_usd ?? null,
    to:
      isCashSavingsCcShortfallRow(row) && linkShortfallToCreditCard
        ? liabilitiesSubgroupPath("credit_card")
        : cashAccountPath(row),
    depth: 0,
    ...accountLineMeta(row),
  };
}

/** Cash hub / home card: checking + savings accounts; no CC shortfall line or link. */
export function buildCashEqsCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const cash = valueRows(
    accounts.filter(
      (a) => accountBelongsToDashboardBucket(a, "cash_eqs") && !isCashSavingsCcShortfallRow(a)
    ),
    "cash_eqs"
  );
  return sortGroupsDesc(cash.map((r) => mapCashBreakdownLine(r, false)));
}

/** Ahorros y reservas: account lines under the savings nav subtree (linked tarjeta is `bottomLines`). */
export function buildCashSavingsCardBreakdown(accounts: DashboardAccountRow[]): CardBreakdownLine[] {
  const savings = valueRows(accounts.filter((a) => !isCashSavingsCcShortfallRow(a)));
  return sortGroupsDesc(savings.map((r) => mapCashBreakdownLine(r, false)));
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

/**
 * Rounded Δ for card metrics (matches `DashboardCardGroupMetrics`). USD keeps
 * cents (2 decimals) — the red/green delta pair then renders at the card's least
 * adaptive decimals (`minAdaptiveUsdFractionDigits`); CLP stays whole pesos.
 */
export function roundedMetricDelta(
  metrics: CardGroupMetrics,
  showUsd: boolean,
  kind: "total" | "period"
): number | null {
  const clp = kind === "total" ? metrics.delta_total_clp : metrics.delta_period_clp;
  if (showUsd) {
    const usd = kind === "total" ? metrics.delta_total_usd : metrics.delta_period_usd;
    if (usd != null && Number.isFinite(usd)) return Math.round(usd * 100) / 100;
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

/**
 * Title row: period deposits + period P/L when closes and performance reconcile on the server.
 */
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
