import {
  accountCountsTowardGroupTotals,
  hasMaterialDashboardBalance,
  isChartActiveAccount,
} from "./accountGroupTotals";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import i18n from "./i18n";
import type { SurfacePeriod } from "./surfaceDisplayPrefs";
import type { DashboardAccountRow, NavCardAmountDto } from "./types";

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
  /** Balance change vs prior month/year-end close (Σ current − Σ prior). */
  delta_period_clp: number | null;
  delta_period_usd?: number | null;
};

export type CardGroupMetricsPeriod = SurfacePeriod;

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

/** The property's loan row (server `loan_account_id`), when it has a value. */
function mortgageAccountForPropertyRow(
  allAccounts: DashboardAccountRow[],
  propertyRow: DashboardAccountRow | undefined
): DashboardAccountRow | undefined {
  const loanId = propertyRow?.loan_account_id;
  if (loanId == null) return undefined;
  const loan = allAccounts.find((a) => a.account_id === loanId);
  return loan?.current_value_clp != null ? loan : undefined;
}

export type CardGroupMetricsByPeriod = Record<CardGroupMetricsPeriod, CardGroupMetrics>;

function finiteOr<T>(v: number | null | undefined, fallback: T): number | T {
  return v != null && Number.isFinite(v) ? v : fallback;
}

/** One account row's card metrics for a period (a group's are the server's, never summed here). */
function cardMetricsForAccountRow(
  r: DashboardAccountRow | null,
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  if (!r) {
    return {
      deposits_clp: 0,
      deposits_usd: null,
      delta_total_clp: null,
      delta_total_usd: null,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: null,
      delta_period_usd: null,
    };
  }
  const depClp =
    period === "month" ? r.deposits_month_clp : period === "day" ? r.deposits_day_clp : r.deposits_year_clp;
  const depUsd =
    period === "month" ? r.deposits_month_usd : period === "day" ? r.deposits_day_usd : r.deposits_year_usd;
  const deltaClp =
    period === "month" ? r.delta_month_clp : period === "day" ? r.delta_day_clp : r.delta_year_clp;
  const deltaUsd =
    period === "month" ? r.delta_month_usd : period === "day" ? r.delta_day_usd : r.delta_year_usd;
  return {
    deposits_clp: r.deposits_clp,
    deposits_usd: finiteOr(r.deposits_usd, null),
    delta_total_clp: finiteOr(r.delta_total_clp, null),
    delta_total_usd: finiteOr(r.delta_total_usd, null),
    deposits_period_clp: finiteOr(depClp, 0),
    deposits_period_usd: finiteOr(depUsd, null),
    delta_period_clp: finiteOr(deltaClp, null),
    delta_period_usd: finiteOr(deltaUsd, null),
  };
}

/** All three period slices of one account row — cards render día/mes/año rows at once. */
export function cardMetricsByPeriodForAccountRow(
  row: DashboardAccountRow | null
): CardGroupMetricsByPeriod {
  return {
    day: cardMetricsForAccountRow(row, "day"),
    month: cardMetricsForAccountRow(row, "month"),
    year: cardMetricsForAccountRow(row, "year"),
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

function sortGroupsDesc<T extends { clp: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.clp - a.clp);
}

export type DashboardGroupSlug = "net_worth" | "real_estate" | "retirement" | "brokerage" | "cash_eqs";

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

/**
 * Real estate card: property (net equity) with valor and hipoteca detail lines. `total` is the
 * node's server balance (`value.members`) — the head line, never a Σ of the rows here.
 */
export function buildRealEstateCardBreakdown(
  accounts: DashboardAccountRow[],
  total: NavCardAmountDto,
  /** The real-estate node's own page (`route_path`): the head line's link without a property row. */
  nodeRoute: string,
  allAccounts?: DashboardAccountRow[]
): CardBreakdownLine[] {
  const props = valueRows(accounts.filter((a) => a.group_slug === "real_estate"));
  if (props.length === 0) return [];

  const lines: CardBreakdownLine[] = [];
  const rows = allAccounts ?? accounts;

  if (props.length === 1) {
    // One property: the head line IS the property (the group total, net of its loan), with its
    // valor and hipoteca under it. Property rows store equity (net of the linked hipoteca), so
    // gross valor = equity + outstanding mortgage, both straight from account values. The head
    // line keeps the old lowercase card label (portfolioNavDashboardCards.test.ts pins it).
    const propertyRow = props.find(
      (a) => a.category_slug === "property" || a.bucket_slug === "real_estate__property"
    );
    const mortgageRow = mortgageAccountForPropertyRow(rows, propertyRow);
    const netClp = total.clp;
    const groupUsd = total.usd;
    const propertyTo = propertyRow != null ? accountDetailPath(propertyRow.account_id) : nodeRoute;
    lines.push({ label: props[0]!.name.trim().toLowerCase(), clp: netClp, usd: groupUsd, depth: 0, to: propertyTo });
    if (propertyRow != null && mortgageRow?.current_value_clp != null) {
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
    lines.push({
      label: r.name,
      clp: r.current_value_clp ?? 0,
      usd: r.current_value_usd ?? null,
      depth: 0,
      to,
    });
    const loan = mortgageAccountForPropertyRow(rows, r);
    if (loan?.current_value_clp == null || r.current_value_clp == null) continue;
    const loanUsd = loan.current_value_usd ?? null;
    const rUsd = r.current_value_usd ?? null;
    lines.push({
      label: i18n.t("realEstate.propertyValue"),
      clp: r.current_value_clp + loan.current_value_clp,
      usd: rUsd != null && loanUsd != null ? rUsd + loanUsd : null,
      depth: 1,
      to,
    });
    lines.push({
      label: i18n.t("realEstate.mortgage"),
      clp: loan.current_value_clp,
      usd: loanUsd,
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

