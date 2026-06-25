import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import {
  buildCashEqsCardBreakdown,
  buildCashSavingsCardBreakdown,
  buildLiabilitiesCardBreakdown,
  buildRealEstateCardBreakdown,
  cardGroupMetricsForDashboardBucket,
  cardGroupMetricsFromAccounts,
  cardGroupTitleBalanceDelta,
  hasCanonicalDashboardPriorCloses,
  dashboardBucketMainValue,
  periodBalanceChangeFromAccountRows,
  subsetTitleBalanceDeltaRounded,
  sumCardGroupMetrics,
  sumCurrentValueClpUsd,
  type CardBreakdownLine,
  type CardGroupMetrics,
  type CardGroupMetricsPeriod,
  type DashboardGroupSlug,
  isCashSavingsCcShortfallRow,
} from "./dashboardCardBreakdown";
import { buildNavCardBreakdown } from "./navCardBreakdown";
import i18n from "./i18n";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import { DASHBOARD_NET_WORTH_BUCKET_SLUGS } from "./portfolioDashboardBuckets";
import { collectNavBucketCoverageKeys } from "./navChartBuckets";
import {
  collectNavAccountDataKeys,
  dashboardBucketGroupsUnderNavHub,
  isNavHubNode,
  portfolioStripGroupChildren,
  resolveDashboardBucketFromNavNode,
} from "./portfolioNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

function accountBucketSlug(row: Pick<DashboardAccountRow, "bucket_slug" | "group_slug">): string {
  return (row.bucket_slug ?? row.group_slug ?? "").trim();
}

/**
 * `chart_inactive` accounts omitted from the nav tree still belong in metrics scope when their
 * bucket matches this node (same placement rule as group-page account enrich).
 */
export function accountInNavMetricsScope(
  row: Pick<DashboardAccountRow, "account_id" | "bucket_slug" | "group_slug" | "chart_inactive">,
  navNode: NavTreeNodeDto,
  navLeafIds: Set<number>
): boolean {
  if (navLeafIds.has(row.account_id)) return true;
  if (!row.chart_inactive) return false;
  const bucket = accountBucketSlug(row);
  if (!bucket) return false;
  const normalized = bucket.replace(/__/g, "_");
  if (normalized === navNode.slug) return true;
  for (const prefix of collectNavBucketCoverageKeys(navNode)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) return true;
    if (bucket === prefix || bucket.startsWith(`${prefix}__`)) return true;
  }
  const asset = navNode.asset_group_slug?.trim();
  if (asset && (bucket === asset || bucket.startsWith(`${asset}__`))) return true;
  return bucket === navNode.slug || bucket.startsWith(`${navNode.slug}__`);
}

/** Nav subtree account ids for card metrics (includes chart-inactive group members). */
export function navMetricsAccountIdSet(
  navNode: NavTreeNodeDto,
  all: readonly Pick<
    DashboardAccountRow,
    "account_id" | "bucket_slug" | "group_slug" | "chart_inactive"
  >[] = []
): Set<number> {
  const leafIds = navLeafAccountIdSet(navNode);
  const ids = new Set(leafIds);
  for (const row of all) {
    if (ids.has(row.account_id)) continue;
    if (accountInNavMetricsScope(row, navNode, leafIds)) ids.add(row.account_id);
  }
  return ids;
}

function isNetWorthPortfolioRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Account ids referenced anywhere under `navNode` (including the node itself). */
export function navAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  for (const k of collectNavAccountDataKeys(navNode)) {
    const n = Number(k);
    if (Number.isFinite(n)) idSet.add(n);
  }
  return idSet;
}

/**
 * Nav leaf `account_id` values only (not `source_account_id`).
 * Use for dashboard row sums so Pasivos liability_view + master are not double-counted.
 */
/** Account ids under `navNode` marked `chart_inactive` (history charts only). */
export function navChartInactiveAccountIds(navNode: NavTreeNodeDto): Set<number> {
  const ids = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.chart_inactive && n.account_id != null && n.account_id > 0) {
      ids.add(n.account_id);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(navNode);
  return ids;
}

export function navLeafAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(navNode);
  return idSet;
}

export function dashboardRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  const idSet = navMetricsAccountIdSet(navNode, all);
  return all.filter((a) => idSet.has(a.account_id));
}

/** Nav subtree rows visible in breakdown lines (hides chart_inactive + null marks). */
export function dashboardDisplayRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  return dashboardRowsForNavSubtree(all, navNode).filter((a) => isChartActiveAccount(a));
}

/** Nav children that render as strip cards (balance filtering is server-side on shape APIs). */
export function routableNavStripChildren(navChildren: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return navChildren.filter((c) => Boolean(c.route_path?.trim()));
}

export type NavChildTitleDeltaModel =
  | { mode: "dashboard_group"; group: DashboardGroupSlug; groupRowFilter?: (a: DashboardAccountRow) => boolean }
  | { mode: "subset" };

/** Main balance + deposits/Δ metrics for a nav child card (bucket totals or nav subtree). */
function rowsForCashSavingsCard(
  all: DashboardAccountRow[],
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  const leafIds = navLeafAccountIdSet(navChild);
  return all.filter((a) => leafIds.has(a.account_id) && !isCashSavingsCcShortfallRow(a));
}

function cashSavingsLinkedBottomLines(
  dash: Pick<DashboardResponse, "dashboard_layout">
): CardBreakdownLine[] | undefined {
  const card =
    dash.dashboard_layout?.find((c) => c.slug === "cash_eqs") ??
    dash.dashboard_layout?.find((c) => c.slug === "cash_savings");
  const linked = card?.linked_balances ?? [];
  if (!linked.length) return undefined;
  return linked.map((lb) => ({
    label: lb.label_i18n_key ? i18n.t(lb.label_i18n_key) : lb.label,
    clp: lb.clp,
    usd: lb.usd ?? null,
    depth: 0,
    to: lb.route_path,
  }));
}

export function stripMetricsRowsForNavChild(
  dash: Pick<DashboardResponse, "accounts">,
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  const sourceRows = isCashSavingsNavNode(navChild)
    ? rowsForCashSavingsCard(dash.accounts, navChild)
    : dashboardRowsForNavSubtree(dash.accounts, navChild);
  return sourceRows.filter((a) => accountCountsTowardGroupTotals(a));
}

/** @deprecated Same as {@link stripMetricsRowsForNavChild}. */
export function stripPlMetricsRowsForNavChild(
  dash: Pick<DashboardResponse, "accounts">,
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  return stripMetricsRowsForNavChild(dash, navChild);
}

function usesFullDashboardBucketTotals(navChild: NavTreeNodeDto): DashboardGroupSlug | null {
  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (!bucket || bucket === "net_worth") return null;
  if (bucket === "cash_eqs") return "cash_eqs";
  if (navChild.slug === bucket) return bucket;
  return null;
}

/** Title Δ for a nav strip child: full bucket totals on home cards, subtree sum on subgroup pages. */
export function titleBalanceDeltaForNavChild(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  overviewPoints: Record<string, string | number | null>[],
  navChild: NavTreeNodeDto,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  const metricsRows = stripMetricsRowsForNavChild(dash, navChild);
  const fullBucket = usesFullDashboardBucketTotals(navChild);
  if (fullBucket) {
    return cardGroupTitleBalanceDelta(
      dash.accounts,
      dash.totals,
      overviewPoints,
      fullBucket,
      period,
      showUsd
    );
  }
  return periodBalanceChangeFromAccountRows(metricsRows, period, showUsd);
}

export function mainValueAndMetricsForNavChild(
  dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout">,
  navChild: NavTreeNodeDto,
  metricsPeriod: CardGroupMetricsPeriod,
  showUsd: boolean
): { clp: number; apiUsd: number | null; metrics: CardGroupMetrics } {
  const metricsRows = stripMetricsRowsForNavChild(dash, navChild);
  const fullBucket = usesFullDashboardBucketTotals(navChild);
  const metrics =
    fullBucket && hasCanonicalDashboardPriorCloses(dash.totals.prior_closes)
      ? cardGroupMetricsForDashboardBucket(
          dash.totals,
          fullBucket,
          dash.accounts,
          metricsPeriod,
          showUsd
        )
      : cardGroupMetricsFromAccounts(metricsRows, metricsPeriod);
  if (fullBucket === "cash_eqs") {
    return { ...dashboardBucketMainValue(dash.totals, "cash_eqs", showUsd), metrics };
  }
  if (fullBucket) {
    return { ...dashboardBucketMainValue(dash.totals, fullBucket, showUsd), metrics };
  }
  return { ...sumCurrentValueClpUsd(metricsRows, showUsd), metrics };
}

/**
 * Title Δ / main balance: always sum accounts under this nav node's portfolio subtree.
 * (No per-account `dashboard_bucket_slug` tagging — matches breakdown lines.)
 */
export function titleDeltaModelForNavChild(_navChild: NavTreeNodeDto): NavChildTitleDeltaModel {
  return { mode: "subset" };
}

export type PortfolioNavParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardGroupSlug; groupRowFilter?: (a: DashboardAccountRow) => boolean }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardGroupSlug[] }
  | { kind: "subset_only" };

export type ConsolidatedHubPeriodMetricsSlice = {
  closing_clp: number;
  prior_closing_clp: number | null;
  net_capital_flow_clp: number;
  nominal_pl_clp: number | null;
  balance_delta_clp: number | null;
};

export type InversionesPeriodMetricsDto = {
  month: ConsolidatedHubPeriodMetricsSlice | null;
  year: ConsolidatedHubPeriodMetricsSlice | null;
};

/** Period row from canonical consolidated hub series; lifetime fields come from child buckets. */
export function cardGroupMetricsFromConsolidatedHubPeriodMetrics(
  hubMetrics: InversionesPeriodMetricsDto,
  period: CardGroupMetricsPeriod,
  lifetime: Pick<
    CardGroupMetrics,
    "deposits_clp" | "deposits_usd" | "delta_total_clp" | "delta_total_usd"
  >
): CardGroupMetrics {
  const slice = period === "month" ? hubMetrics.month : hubMetrics.year;
  if (!slice) {
    return {
      ...lifetime,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: null,
      delta_period_usd: null,
    };
  }
  return {
    ...lifetime,
    deposits_period_clp: slice.net_capital_flow_clp,
    deposits_period_usd: null,
    delta_period_clp: slice.balance_delta_clp,
    delta_period_usd: null,
  };
}

export function titleBalanceDeltaForAccountIds(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  overviewPoints: Record<string, string | number | null>[],
  accountIds: Set<number>,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  model: NavChildTitleDeltaModel
): number | null {
  const inIds = (a: DashboardAccountRow) => accountIds.has(a.account_id);
  if (model.mode === "dashboard_group") {
    return cardGroupTitleBalanceDelta(
      dash.accounts,
      dash.totals,
      overviewPoints,
      model.group,
      period,
      showUsd,
      (a) => inIds(a) && (!model.groupRowFilter || model.groupRowFilter(a))
    );
  }
  return subsetTitleBalanceDeltaRounded(dash.accounts, period, showUsd, inIds);
}

export function parentTitleBalanceDelta(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  overviewPoints: Record<string, string | number | null>[],
  accountIds: Set<number>,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  mode: PortfolioNavParentTitleDeltaMode
): number | null {
  const inIds = (a: DashboardAccountRow) => accountIds.has(a.account_id);
  if (mode.kind === "dashboard_group") {
    return cardGroupTitleBalanceDelta(
      dash.accounts,
      dash.totals,
      overviewPoints,
      mode.group,
      period,
      showUsd,
      (a) => inIds(a) && (!mode.groupRowFilter || mode.groupRowFilter(a))
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    let sum = 0;
    let any = false;
    for (const g of mode.groups) {
      const d = cardGroupTitleBalanceDelta(
        dash.accounts,
        dash.totals,
        overviewPoints,
        g,
        period,
        showUsd,
        inIds
      );
      if (d != null && Number.isFinite(d)) {
        sum += d;
        any = true;
      }
    }
    return any ? Math.round(sum) : null;
  }
  return subsetTitleBalanceDeltaRounded(dash.accounts, period, showUsd, inIds);
}

/**
 * Main balance for portfolio strip compact card: dashboard bucket totals when the page maps to a
 * bucket; otherwise sum of live values under the nav subtree (e.g. Pasivos subset).
 */
export function portfolioNavParentMainValue(
  dash: Pick<DashboardResponse, "totals">,
  mode: PortfolioNavParentTitleDeltaMode,
  navSubtreeRows: DashboardAccountRow[],
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  if (mode.kind === "dashboard_group") {
    return dashboardBucketMainValue(dash.totals, mode.group, showUsd);
  }
  if (mode.kind === "sum_dashboard_groups") {
    let clp = 0;
    let usd = 0;
    let anyUsd = false;
    for (const g of mode.groups) {
      const part = dashboardBucketMainValue(dash.totals, g, showUsd);
      clp += part.clp;
      if (part.apiUsd != null) {
        usd += part.apiUsd;
        anyUsd = true;
      }
    }
    return { clp, apiUsd: anyUsd ? usd : null };
  }
  return sumCurrentValueClpUsd(navSubtreeRows, showUsd);
}

/** Deposits / period Δ metrics aligned with {@link portfolioNavParentMainValue}. */
export function portfolioNavParentMetrics(
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "dashboard_layout" | "net_worth_period_metrics"
  > & {
    inversiones_period_metrics?: InversionesPeriodMetricsDto;
  },
  mode: PortfolioNavParentTitleDeltaMode,
  navSubtreeRows: DashboardAccountRow[],
  period: CardGroupMetricsPeriod,
  parentNavNode?: NavTreeNodeDto,
  showUsd = false
): CardGroupMetrics {
  if (
    parentNavNode?.slug === "inversiones" &&
    dash.inversiones_period_metrics &&
    mode.kind === "sum_dashboard_groups"
  ) {
    const stripChildren = portfolioStripGroupChildren(parentNavNode);
    if (stripChildren.length === 0) {
      throw new Error(
        `portfolioNavParentMetrics: no strip children under nav node ${parentNavNode.slug}`
      );
    }
    const lifetime = sumCardGroupMetrics(
      stripChildren.map((child) =>
        mainValueAndMetricsForNavChild(dash, child, period, showUsd).metrics
      )
    );
    return cardGroupMetricsFromConsolidatedHubPeriodMetrics(
      dash.inversiones_period_metrics,
      period,
      lifetime
    );
  }
  if (mode.kind === "dashboard_group" && hasCanonicalDashboardPriorCloses(dash.totals.prior_closes)) {
    return cardGroupMetricsForDashboardBucket(
      dash.totals,
      mode.group,
      dash.accounts,
      period,
      showUsd,
      (a) =>
        navSubtreeRows.some((r) => r.account_id === a.account_id) &&
        (!mode.groupRowFilter || mode.groupRowFilter(a))
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    if (!parentNavNode) {
      throw new Error("portfolioNavParentMetrics: sum_dashboard_groups requires parentNavNode");
    }
    const stripChildren = portfolioStripGroupChildren(parentNavNode);
    if (stripChildren.length === 0) {
      throw new Error(
        `portfolioNavParentMetrics: no strip children under nav node ${parentNavNode.slug}`
      );
    }
    return sumCardGroupMetrics(
      stripChildren.map((child) =>
        mainValueAndMetricsForNavChild(dash, child, period, showUsd).metrics
      )
    );
  }
  return cardGroupMetricsFromAccounts(navSubtreeRows, period);
}

/** Parent title balance Δ mode from the matched nav node (`asset_group_slug`, hub children, or subtree). */
export function portfolioNavParentTitleModeForNavNode(
  node: NavTreeNodeDto | null | undefined
): PortfolioNavParentTitleDeltaMode {
  if (!node) return { kind: "subset_only" };

  /** Home Patrimonio neto: bucket totals (incl. CC-adjusted cash), not raw account subtree sum. */
  if (isNetWorthPortfolioRoot(node)) {
    return { kind: "sum_dashboard_groups", groups: DASHBOARD_NET_WORTH_BUCKET_SLUGS };
  }

  const bucket = resolveDashboardBucketFromNavNode(node);
  if (bucket) {
    const stripKids = portfolioStripGroupChildren(node);
    /** Portfolio subgroups (APV, AFP) are not separate dashboard buckets — only foreign bucket slugs force subset rollup. */
    const childBuckets = stripKids
      .map((c) => resolveDashboardBucketFromNavNode(c))
      .filter((g): g is DashboardGroupSlug => g != null && g !== "net_worth");
    if (childBuckets.some((g) => g !== bucket)) {
      return { kind: "subset_only" };
    }
    return { kind: "dashboard_group", group: bucket };
  }

  if (isNavHubNode(node)) {
    const groups = dashboardBucketGroupsUnderNavHub(node);
    if (groups.length > 0) return { kind: "sum_dashboard_groups", groups };
  }

  if (node.asset_group_slug === "liabilities" || node.slug.startsWith("liabilities")) {
    return { kind: "subset_only" };
  }

  return { kind: "subset_only" };
}

export type NavChildBreakdownResult = {
  lines: CardBreakdownLine[];
  bottomLines?: CardBreakdownLine[];
  pinBottom?: boolean;
};

type BreakdownDash = Pick<
  DashboardResponse,
  "suecia_snapshot" | "liabilities_breakdown" | "dashboard_layout"
>;

function breakdownByAssetGroup(
  assetGroup: string,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  switch (assetGroup) {
    case "real_estate":
      return { lines: buildRealEstateCardBreakdown(rows, dash.suecia_snapshot ?? null) };
    case "cash_eqs": {
      const lines = buildCashEqsCardBreakdown(rows);
      return lines.length ? { lines } : null;
    }
    case "liabilities": {
      const lb = dash.liabilities_breakdown;
      if (!lb) return null;
      return { lines: buildLiabilitiesCardBreakdown(lb) };
    }
    default:
      return null;
  }
}

function breakdownByNavSlug(
  slug: string,
  _rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  if (slug === "liabilities_credit_card") {
    const lb = dash.liabilities_breakdown;
    if (!lb || lb.credit_card_clp <= 0) return null;
    return {
      lines: [
        {
          label: i18n.t("liabilities.creditCard"),
          clp: lb.credit_card_clp,
          usd: lb.credit_card_usd ?? null,
          depth: 0,
          to: liabilitiesSubgroupPath("credit_card"),
        },
      ],
    };
  }
  if (slug === "liabilities_mortgage") {
    const lb = dash.liabilities_breakdown;
    if (!lb || lb.mortgage_clp <= 0) return null;
    return {
      lines: [
        {
          label: i18n.t("liabilities.mortgage"),
          clp: lb.mortgage_clp,
          usd: lb.mortgage_usd ?? null,
          depth: 0,
          to: liabilitiesSubgroupPath("mortgage"),
        },
      ],
    };
  }
  return null;
}

export function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
  if (node.slug === "cash_savings") return true;
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash === "cash_eqs" && node.slug !== "cash_eqs") return true;
  return node.asset_group_slug === "cash_eqs__cash_savings";
}

/** Breakdown lines for a nav child — domain-specific buckets, then nav-tree children. */
export function breakdownForNavChild(
  navChild: NavTreeNodeDto,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  const bySlug = breakdownByNavSlug(navChild.slug, rows, dash);
  if (bySlug) return bySlug;

  if (isCashSavingsNavNode(navChild)) {
    const cardRows = rowsForCashSavingsCard(rows, navChild);
    const lines = buildCashSavingsCardBreakdown(cardRows);
    const bottomLines = cashSavingsLinkedBottomLines(dash);
    if (!lines.length && !bottomLines?.length) return null;
    return {
      lines,
      ...(bottomLines?.length ? { bottomLines, pinBottom: true } : {}),
    };
  }

  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (bucket === "cash_eqs" && navChild.slug === "cash_eqs") {
    const byCash = breakdownByAssetGroup("cash_eqs", rows, dash);
    const bottomLines = cashSavingsLinkedBottomLines(dash);
    if (!byCash?.lines.length && !bottomLines?.length) return null;
    return {
      lines: byCash?.lines ?? [],
      ...(bottomLines?.length ? { bottomLines, pinBottom: true } : {}),
    };
  }

  const asset = navChild.asset_group_slug;
  if (asset === "real_estate" || asset === "liabilities") {
    const byAsset = breakdownByAssetGroup(asset, rows, dash);
    if (byAsset) return byAsset;
  }
  if (navChild.slug.startsWith("liabilities_")) {
    return breakdownByAssetGroup("liabilities", rows, dash);
  }

  const navLines = buildNavCardBreakdown(navChild, rows);
  if (navLines?.length) return { lines: navLines };

  return null;
}
