import {
  accountCountsTowardGroupTotals,
  hasMaterialDashboardBalance,
  isChartActiveAccount,
} from "./accountGroupTotals";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import i18n from "./i18n";
import type { SurfacePeriod } from "./surfaceDisplayPrefs";
import type { DashboardAccountRow } from "./types";
import type { DisplayUnit } from "./queries/keys";
import { currencyHasAdaptiveCardDecimals } from "./format";

/** One period of a card's metrics, in the payload's unit (the server's `NavCardPeriodMetricsDto`). */
export type CardGroupMetrics = {
  /** Lifetime net deposits. */
  deposits: number | null;
  /** Cumulative nominal P/L (latest performance row). */
  delta_total: number | null;
  /** Net deposits in the selected calendar month or year. */
  deposits_period: number | null;
  /** Balance change vs prior month/year-end close. */
  delta_period: number | null;
};

export type CardGroupMetricsPeriod = SurfacePeriod;

export type CardBreakdownLine = {
  label: string;
  /** In the payload's unit (null: no rate). */
  value: number | null;
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
  value: number | null;
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
      value: line.value,
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

/** The property's loan row (server `loan_account_id`), when it has a value. */
function mortgageAccountForPropertyRow(
  allAccounts: DashboardAccountRow[],
  propertyRow: DashboardAccountRow | undefined
): DashboardAccountRow | undefined {
  const loanId = propertyRow?.loan_account_id;
  if (loanId == null) return undefined;
  const loan = allAccounts.find((a) => a.account_id === loanId);
  return loan?.current_value != null ? loan : undefined;
}

export type CardGroupMetricsByPeriod = Record<CardGroupMetricsPeriod, CardGroupMetrics>;

function finiteOr<T>(v: number | null | undefined, fallback: T): number | T {
  return v != null && Number.isFinite(v) ? v : fallback;
}

/** One account row's card metrics for a period (a group's are the server's, never summed here). */
function cardMetricsForAccountRow(
  r: DashboardAccountRow | null,
  period: CardGroupMetricsPeriod,
  unit: DisplayUnit
): CardGroupMetrics {
  // Pesos are the ledger's own unit: a row always carries them (a missing leg is a zero).
  const missing = unit === "clp" ? 0 : null;
  if (!r) return { deposits: missing, delta_total: null, deposits_period: missing, delta_period: null };
  const dep = period === "month" ? r.deposits_month : period === "day" ? r.deposits_day : r.deposits_year;
  const delta = period === "month" ? r.delta_month : period === "day" ? r.delta_day : r.delta_year;
  return {
    deposits: finiteOr(r.deposits, missing),
    delta_total: finiteOr(r.delta_total, null),
    deposits_period: finiteOr(dep, missing),
    delta_period: finiteOr(delta, null),
  };
}

/** All three period slices of one account row — cards render día/mes/año rows at once. */
export function cardMetricsByPeriodForAccountRow(
  row: DashboardAccountRow | null,
  unit: DisplayUnit
): CardGroupMetricsByPeriod {
  return {
    day: cardMetricsForAccountRow(row, "day", unit),
    month: cardMetricsForAccountRow(row, "month", unit),
    year: cardMetricsForAccountRow(row, "year", unit),
  };
}

/** Breakdown lines / visible position list (counted, chart-active, non-zero balance). */
function valueRows(accounts: DashboardAccountRow[]): DashboardAccountRow[] {
  return accounts.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      hasMaterialDashboardBalance(a)
  );
}

function sortGroupsDesc<T extends { value: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => dashboardCardMainSortKey(b.value) - dashboardCardMainSortKey(a.value));
}

export type DashboardGroupSlug = "net_worth" | "real_estate" | "retirement" | "brokerage" | "cash_eqs";

/** Sort key for the primary balance shown on a card (a missing value sorts last). */
export function dashboardCardMainSortKey(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Descending order for detail-row cards by primary balance. */
export function compareDashboardCardMainDesc(a: number | null | undefined, b: number | null | undefined): number {
  return dashboardCardMainSortKey(b) - dashboardCardMainSortKey(a);
}

/**
 * Real estate card: property (net equity) with valor and hipoteca detail lines. `total` is the
 * node's server balance (`value.members`) — the head line, never a Σ of the rows here.
 */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  total: number | null,
  /** The real-estate node's own page (`route_path`): the head line's link without a property row. */
  nodeRoute: string,
  allAccounts?: DashboardAccountRow[]
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const rows = allAccounts ?? accounts;
  const plus = (x: number | null | undefined, y: number | null | undefined) => (x != null && y != null ? x + y : null);

  if (props.length === 1) {
    // One property: the head line IS the property (the group total, net of its loan), with its
    // valor and hipoteca under it. Property rows store equity (net of the linked hipoteca), so
    // gross valor = equity + outstanding mortgage, both straight from account values. The head
    // line keeps the old lowercase card label (portfolioNavDashboardCards.test.ts pins it).
    const propertyRow = props.find(
      (a) => a.category_slug === "property" || a.bucket_slug === "real_estate__property"
    );
    const mortgageRow = mortgageAccountForPropertyRow(rows, propertyRow);
    const propertyTo = propertyRow != null ? accountDetailPath(propertyRow.account_id) : nodeRoute;
    lines.push({ label: props[0]!.name, value: total, depth: 0, to: propertyTo });
    if (propertyRow != null && mortgageRow?.current_value != null) {
      const mortgage = mortgageRow.current_value;
      lines.push({
        label: i18n.t("realEstate.propertyValue"),
        value: plus(total, mortgage),
        depth: 1,
        to: propertyTo,
      });
      lines.push({
        label: i18n.t("realEstate.mortgage"),
        value: mortgage,
        depth: 1,
        to: accountDetailPath(mortgageRow.account_id),
      });
    }
    return lines;
  }

  // Several properties: no head line (the card's title carries the group total) — each
  // property at the first level with the name the server gives, and under one with a loan its
  // valor and hipoteca (the property's row and its own loan's, `loan_account_id`).
  for (const r of props) {
    const to = accountDetailPath(r.account_id);
    lines.push({ label: r.name, value: r.current_value, depth: 0, to });
    const loan = mortgageAccountForPropertyRow(rows, r);
    if (loan?.current_value == null || r.current_value == null) continue;
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      value: r.current_value + loan.current_value,
      depth: 1,
      to,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      value: loan.current_value,
      depth: 1,
      to: accountDetailPath(loan.account_id),
    });
  }
  return lines;
}

const LIABILITY_KEYS = {
  mortgage: "liabilities.mortgage",
  credit_card: "liabilities.creditCard",
} as const;

/** Liabilities card: mortgage and credit card (aligned with dashboard liabilities total). */
export function buildLiabilitiesCardBreakdown(breakdown: {
  mortgage: number | null;
  credit_card: number | null;
}): CardBreakdownLine[] {
  const rows = (["mortgage", "credit_card"] as const)
    .map((key) => ({ key, value: breakdown[key] }))
    .filter((r) => r.value != null && r.value > 0);
  return sortGroupsDesc(
    rows.map((r) => ({
      label: i18n.t(LIABILITY_KEYS[r.key]),
      value: r.value,
      to: liabilitiesSubgroupPath(r.key),
    }))
  ).map((r) => ({ ...r, depth: 0 as const }));
}

/** Rounded deposits for card metrics (matches `DashboardCardGroupMetrics`): whole units. */
export function roundedMetricDeposits(metrics: CardGroupMetrics, kind: "total" | "period"): number | null {
  const v = kind === "total" ? metrics.deposits : metrics.deposits_period;
  return v != null && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Rounded Δ for card metrics (matches `DashboardCardGroupMetrics`). A currency with minor units
 * keeps cents (2 decimals) — the red/green delta pair then renders at the card's least adaptive
 * decimals (`minAdaptiveUsdFractionDigits`); pesos stay whole.
 */
export function roundedMetricDelta(
  metrics: CardGroupMetrics,
  unit: DisplayUnit,
  kind: "total" | "period"
): number | null {
  const v = kind === "total" ? metrics.delta_total : metrics.delta_period;
  if (v == null || !Number.isFinite(v)) return null;
  return currencyHasAdaptiveCardDecimals(unit) ? Math.round(v * 100) / 100 : Math.round(v);
}
