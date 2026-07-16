/**
 * Server-side card metrics for the portfolio nav strip (home + group pages).
 *
 * One entry per group node of the net_worth nav tree, keyed by portfolio-group slug, with
 * BOTH consumer variants precomputed:
 *   - `child`:  what `mainValueAndMetricsForNavChild` / `titleBalanceDeltaForNavChild`
 *               showed for the node as a detail card (home second row, group-page children).
 *   - `parent`: what `portfolioNavParentMetrics` / `parentTitleBalanceDelta` showed for the
 *               node as the compact parent card of its own page (incl. the home Patrimonio
 *               neto card = net_worth root).
 *
 * This is a faithful port of the client Σ logic (client/src/dashboardCardBreakdown.ts +
 * portfolioNavDashboardCards.ts as of 2026-07-15) so the client can render precomputed
 * numbers instead of summing server rows — same rationale as groupChartBuckets.ts. The
 * client keeps only single-account projections (compact account cards, account detail).
 */
import type { DashboardAccountStats } from "./brokerageAcciones.js";
import type { NavTreeNodeDto } from "./navTree.js";
import type { InversionesPeriodMetrics } from "./netWorthConsolidation.js";

export type CardMetricsPeriod = "month" | "year";

/** Mirror of the client `CardGroupMetrics` (null-vs-0 semantics preserved exactly). */
export type CardPeriodMetricsDto = {
  deposits_clp: number;
  deposits_usd: number | null;
  delta_total_clp: number | null;
  delta_total_usd: number | null;
  deposits_period_clp: number;
  deposits_period_usd: number | null;
  delta_period_clp: number | null;
  delta_period_usd: number | null;
};

export type CardTitleDeltaDto = {
  month_clp: number | null;
  month_usd: number | null;
  year_clp: number | null;
  year_usd: number | null;
};

export type NavCardMetricsVariantDto = {
  month: CardPeriodMetricsDto;
  year: CardPeriodMetricsDto;
  title_delta: CardTitleDeltaDto;
};

export type NavCardMetricsDto = {
  child: NavCardMetricsVariantDto;
  parent: NavCardMetricsVariantDto;
};

/** Narrow row view — the fields card metrics read from `DashboardAccountStats`. */
export type CardMetricsAccountRow = Pick<
  DashboardAccountStats,
  | "account_id"
  | "group_slug"
  | "bucket_slug"
  | "dashboard_bucket_slug"
  | "category_slug"
  | "chart_inactive"
  | "exclude_from_group_totals"
  | "deposits_clp"
  | "deposits_usd"
  | "delta_total_clp"
  | "delta_total_usd"
  | "deposits_month_clp"
  | "deposits_month_usd"
  | "deposits_year_clp"
  | "deposits_year_usd"
  | "delta_month_clp"
  | "delta_month_usd"
  | "delta_year_clp"
  | "delta_year_usd"
  | "prior_month_close_clp"
  | "prior_month_close_usd"
  | "prior_year_close_clp"
  | "prior_year_close_usd"
  | "current_value_clp"
  | "current_value_usd"
>;

/** `${bucket}_clp` / `${bucket}_usd` current totals + prior closes (buildDashboardNwBucketTotals). */
export type BucketTotalsForCardMetrics = {
  prior_closes: {
    month_end?: string | null;
    month: Record<string, number | null | undefined>;
    year: Record<string, number | null | undefined>;
  };
} & Record<string, unknown>;

const DASHBOARD_NW_BUCKET_SLUGS = ["real_estate", "retirement", "brokerage", "cash_eqs"] as const;
type DashboardNwBucketSlug = (typeof DASHBOARD_NW_BUCKET_SLUGS)[number];

function isDashboardNwBucketSlug(slug: string): slug is DashboardNwBucketSlug {
  return (DASHBOARD_NW_BUCKET_SLUGS as readonly string[]).includes(slug);
}

/* ------------------------------- row predicates ---------------------------------- */

function accountCountsTowardGroupTotals(row: CardMetricsAccountRow): boolean {
  return row.exclude_from_group_totals !== 1;
}

function accountBelongsToDashboardBucket(row: CardMetricsAccountRow, bucket: string): boolean {
  if (row.dashboard_bucket_slug != null && row.dashboard_bucket_slug !== "") {
    return row.dashboard_bucket_slug === bucket;
  }
  const placement = row.bucket_slug ?? row.group_slug;
  return placement === bucket;
}

const CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG = "credit_card_shortfall_from_savings";
const CHECKING_ACCOUNTS_BUCKET = "cash_eqs__checking_accounts";

function isCashSavingsCcShortfallRow(row: CardMetricsAccountRow): boolean {
  return row.category_slug === CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG;
}

function isCheckingPlacementRow(row: CardMetricsAccountRow): boolean {
  const slug = row.bucket_slug ?? "";
  if (slug === CHECKING_ACCOUNTS_BUCKET || slug.startsWith(`${CHECKING_ACCOUNTS_BUCKET}__`)) {
    return true;
  }
  return row.category_slug === "cuenta_corriente" || row.category_slug === "cuenta_vista";
}

/** Savings rows whose period P/L feeds the cash_eqs bucket card (excludes checking + CC shortfall). */
function isCashSavingsBucketPeriodPlRow(row: CardMetricsAccountRow): boolean {
  return (
    accountBelongsToDashboardBucket(row, "cash_eqs") &&
    !isCheckingPlacementRow(row) &&
    !isCashSavingsCcShortfallRow(row)
  );
}

/** Bucket-card scope: counts-toward-totals rows in the bucket, or `filter` REPLACING membership. */
function accountInDashboardGroupScope(
  row: CardMetricsAccountRow,
  bucket: DashboardNwBucketSlug,
  filter?: (row: CardMetricsAccountRow) => boolean
): boolean {
  if (!accountCountsTowardGroupTotals(row)) return false;
  if (filter) return filter(row);
  return accountBelongsToDashboardBucket(row, bucket);
}

/* --------------------------------- metric sums ----------------------------------- */

function emptyPeriodMetrics(): CardPeriodMetricsDto {
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

/** Port of client `cardGroupMetricsFromAccounts`. */
export function cardMetricsFromRows(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod
): CardPeriodMetricsDto {
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

    const periodDepClp = period === "month" ? r.deposits_month_clp : r.deposits_year_clp;
    if (periodDepClp != null && Number.isFinite(periodDepClp)) {
      deposits_period_clp += periodDepClp;
    }

    const periodDepUsd = period === "month" ? r.deposits_month_usd : r.deposits_year_usd;
    if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
      deposits_period_usd += periodDepUsd;
      anyUsdPeriodDep = true;
    }

    const periodDeltaClp = period === "month" ? r.delta_month_clp : r.delta_year_clp;
    if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
      delta_period_clp += periodDeltaClp;
      anyPeriodDeltaClp = true;
    }
    const periodDeltaUsd = period === "month" ? r.delta_month_usd : r.delta_year_usd;
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

/** Port of client `sumCardGroupMetrics`. */
export function sumCardMetrics(parts: readonly CardPeriodMetricsDto[]): CardPeriodMetricsDto {
  if (parts.length === 0) return emptyPeriodMetrics();
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

  for (const m of parts) {
    deposits_clp += m.deposits_clp;
    if (m.deposits_usd != null && Number.isFinite(m.deposits_usd)) {
      deposits_usd += m.deposits_usd;
      anyUsdDep = true;
    }
    if (m.delta_total_clp != null && Number.isFinite(m.delta_total_clp)) {
      delta_total_clp += m.delta_total_clp;
      anyTotalDelta = true;
    }
    if (m.delta_total_usd != null && Number.isFinite(m.delta_total_usd)) {
      delta_total_usd += m.delta_total_usd;
      anyUsdTotalDelta = true;
    }
    deposits_period_clp += m.deposits_period_clp;
    if (m.deposits_period_usd != null && Number.isFinite(m.deposits_period_usd)) {
      deposits_period_usd += m.deposits_period_usd;
      anyUsdPeriodDep = true;
    }
    if (m.delta_period_clp != null && Number.isFinite(m.delta_period_clp)) {
      delta_period_clp += m.delta_period_clp;
      anyPeriodDelta = true;
    }
    if (m.delta_period_usd != null && Number.isFinite(m.delta_period_usd)) {
      delta_period_usd += m.delta_period_usd;
      anyUsdPeriodDelta = true;
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

/* -------------------------------- title deltas ----------------------------------- */

function dashboardAccountCurrentValueClp(row: CardMetricsAccountRow): number {
  const v = row.current_value_clp;
  return v != null && Number.isFinite(v) ? v : 0;
}

/** Port of client `subsetPeriodBalanceDeltaFromAccounts` (Σ current − Σ prior close). */
function subsetPeriodBalanceDelta(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod,
  unit: "clp" | "usd"
): number | null {
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

function subsetTitleBalanceDeltaRounded(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod,
  unit: "clp" | "usd"
): number | null {
  const v = subsetPeriodBalanceDelta(rows, period, unit);
  return v != null && Number.isFinite(v) ? Math.round(v) : null;
}

/** Port of client `bucketPeriodBalanceDeltaFromTotals` (current bucket total − prior close). */
function bucketPeriodBalanceDeltaFromTotals(
  totals: BucketTotalsForCardMetrics,
  bucket: DashboardNwBucketSlug,
  period: CardMetricsPeriod,
  unit: "clp" | "usd"
): number | null {
  if (!totals.prior_closes.month_end?.trim()) return null;
  const current = totals[`${bucket}_${unit}`];
  const priorBlock = period === "year" ? totals.prior_closes.year : totals.prior_closes.month;
  const prior = priorBlock[`${bucket}_${unit}`];
  if (current == null || typeof current !== "number" || !Number.isFinite(current)) return null;
  if (prior == null || !Number.isFinite(prior)) return null;
  return current - prior;
}

/** Port of client `resolveGroupPeriodBalanceDelta` + rounding (`cardGroupTitleBalanceDelta`). */
function bucketTitleBalanceDelta(
  rows: readonly CardMetricsAccountRow[],
  totals: BucketTotalsForCardMetrics,
  bucket: DashboardNwBucketSlug,
  period: CardMetricsPeriod,
  unit: "clp" | "usd",
  filter?: (row: CardMetricsAccountRow) => boolean
): number | null {
  const fromTotals = bucketPeriodBalanceDeltaFromTotals(totals, bucket, period, unit);
  const delta =
    fromTotals != null
      ? fromTotals
      : subsetPeriodBalanceDelta(
          rows.filter((a) => accountInDashboardGroupScope(a, bucket, filter)),
          period,
          unit
        );
  return delta != null && Number.isFinite(delta) ? Math.round(delta) : null;
}

/* -------------------------------- bucket metrics ---------------------------------- */

/** Port of client `cardGroupMetricsForDashboardBucket` (incl. cash_eqs savings-P/L override). */
function bucketCardMetrics(
  rows: readonly CardMetricsAccountRow[],
  bucket: DashboardNwBucketSlug,
  period: CardMetricsPeriod,
  filter?: (row: CardMetricsAccountRow) => boolean
): CardPeriodMetricsDto {
  const base = cardMetricsFromRows(
    rows.filter((a) => accountInDashboardGroupScope(a, bucket, filter)),
    period
  );
  if (bucket === "cash_eqs") {
    const savingsRows = rows.filter(
      (a) => isCashSavingsBucketPeriodPlRow(a) && accountInDashboardGroupScope(a, "cash_eqs", filter)
    );
    const savingsPl = cardMetricsFromRows(savingsRows, period);
    return {
      ...base,
      delta_period_clp:
        savingsPl.delta_period_clp != null && Number.isFinite(savingsPl.delta_period_clp)
          ? Math.round(savingsPl.delta_period_clp)
          : null,
      delta_period_usd:
        savingsPl.delta_period_usd != null && Number.isFinite(savingsPl.delta_period_usd)
          ? Math.round(savingsPl.delta_period_usd)
          : null,
    };
  }
  return base;
}

/* ------------------------------- nav-node helpers --------------------------------- */

function isNavBucketNode(node: NavTreeNodeDto): boolean {
  return node.group_kind === "nav_bucket";
}

function isLiabilityGroupNavNode(node: NavTreeNodeDto): boolean {
  return node.group_kind === "liability_group";
}

function isNetWorthPortfolioRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Port of client `resolveDashboardBucketFromNavNode`. */
function resolveDashboardBucketFromNavNode(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash && isDashboardNwBucketSlug(dash)) return dash;
  const asset = node.asset_group_slug?.trim();
  if (asset && isDashboardNwBucketSlug(asset)) return asset;
  if (isDashboardNwBucketSlug(node.slug)) return node.slug;
  return null;
}

/** Port of client `usesFullDashboardBucketTotals`. */
function usesFullDashboardBucketTotals(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  const bucket = resolveDashboardBucketFromNavNode(node);
  if (!bucket) return null;
  if (bucket === "cash_eqs") return "cash_eqs";
  if (node.slug === bucket) return bucket;
  return null;
}

/** Port of client `isCashSavingsNavNode`. */
function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
  if (node.slug === "cash_savings") return true;
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash === "cash_eqs" && node.slug !== "cash_eqs") return true;
  return node.asset_group_slug === "cash_eqs__cash_savings";
}

/** Port of client `isPortfolioStripCardNode`. */
function isPortfolioStripCardNode(node: NavTreeNodeDto): boolean {
  if (!node.route_path?.trim() || isLiabilityGroupNavNode(node)) return false;
  if (isNavBucketNode(node) && node.slug !== "cash_eqs") return false;
  if (node.account_id != null || node.expense_account_id != null) return false;
  if (resolveDashboardBucketFromNavNode(node) != null) return true;
  if (node.asset_group_slug === "liabilities") return true;
  if (node.asset_group_slug === "credit_cards" && (node.children?.length ?? 0) > 0) return true;
  if (node.portfolio_group_id != null && (node.api_group || node.api_subgroup)) return true;
  return false;
}

/** Port of client `portfolioStripGroupChildren` (flattens nav_bucket hubs except cash_eqs). */
function portfolioStripGroupChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  for (const child of root.children ?? []) {
    if (isNavBucketNode(child) && child.slug !== "cash_eqs") {
      out.push(...portfolioStripGroupChildren(child));
      continue;
    }
    if (isPortfolioStripCardNode(child)) out.push(child);
  }
  return out;
}

/** Port of client `dashboardBucketGroupsUnderNavHub`. */
function dashboardBucketGroupsUnderNavHub(node: NavTreeNodeDto): DashboardNwBucketSlug[] {
  const out: DashboardNwBucketSlug[] = [];
  for (const child of portfolioStripGroupChildren(node)) {
    const g = resolveDashboardBucketFromNavNode(child);
    if (g) out.push(g);
  }
  return out;
}

function navLeafAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return idSet;
}

/** Port of client `collectNavBucketCoverageKeys` (group nodes only). */
function collectNavBucketCoverageKeys(node: NavTreeNodeDto): string[] {
  const keys = new Set<string>();
  const visit = (n: NavTreeNodeDto) => {
    keys.add(n.slug);
    const ag = n.asset_group_slug?.trim();
    if (ag) keys.add(ag);
    for (const c of n.children ?? []) {
      if (c.account_id == null) visit(c);
    }
  };
  visit(node);
  return [...keys];
}

function accountBucketSlug(row: CardMetricsAccountRow): string {
  return (row.bucket_slug ?? row.group_slug ?? "").trim();
}

/** Port of client `accountInNavMetricsScope` (chart-inactive bucket members outside the tree). */
function accountInNavMetricsScope(
  row: CardMetricsAccountRow,
  node: NavTreeNodeDto,
  navLeafIds: Set<number>
): boolean {
  if (navLeafIds.has(row.account_id)) return true;
  if (!row.chart_inactive) return false;
  const bucket = accountBucketSlug(row);
  if (!bucket) return false;
  const normalized = bucket.replace(/__/g, "_");
  if (normalized === node.slug) return true;
  for (const prefix of collectNavBucketCoverageKeys(node)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) return true;
    if (bucket === prefix || bucket.startsWith(`${prefix}__`)) return true;
  }
  const asset = node.asset_group_slug?.trim();
  if (asset && (bucket === asset || bucket.startsWith(`${asset}__`))) return true;
  return bucket === node.slug || bucket.startsWith(`${node.slug}__`);
}

/** Port of client `navMetricsAccountIdSet`. */
function navMetricsAccountIdSet(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): Set<number> {
  const leafIds = navLeafAccountIdSet(node);
  const ids = new Set(leafIds);
  for (const row of rows) {
    if (ids.has(row.account_id)) continue;
    if (accountInNavMetricsScope(row, node, leafIds)) ids.add(row.account_id);
  }
  return ids;
}

type ParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardNwBucketSlug }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardNwBucketSlug[] }
  | { kind: "subset_only" };

/** Port of client `portfolioNavParentTitleModeForNavNode`. */
function parentTitleModeForNavNode(node: NavTreeNodeDto): ParentTitleDeltaMode {
  if (isNetWorthPortfolioRoot(node)) {
    return { kind: "sum_dashboard_groups", groups: DASHBOARD_NW_BUCKET_SLUGS };
  }
  const bucket = resolveDashboardBucketFromNavNode(node);
  if (bucket) {
    const stripKids = portfolioStripGroupChildren(node);
    const childBuckets = stripKids
      .map((c) => resolveDashboardBucketFromNavNode(c))
      .filter((g): g is DashboardNwBucketSlug => g != null);
    if (childBuckets.some((g) => g !== bucket)) {
      return { kind: "subset_only" };
    }
    return { kind: "dashboard_group", group: bucket };
  }
  if (isNavBucketNode(node)) {
    const groups = dashboardBucketGroupsUnderNavHub(node);
    if (groups.length > 0) return { kind: "sum_dashboard_groups", groups };
  }
  return { kind: "subset_only" };
}

/* ----------------------------------- builder -------------------------------------- */

export type NavCardMetricsBuildInput = {
  /**
   * Nav roots whose group nodes get entries — the net_worth portfolio tree plus the Pasivos
   * root (whose DB-driven `liability_groups` children are NOT part of the net_worth tree).
   * Later roots override earlier ones on slug collision: both trees carry a `liabilities`
   * node, and the Pasivos-root version (with liability children) is the one its page renders.
   */
  navRoots: readonly NavTreeNodeDto[];
  rows: readonly CardMetricsAccountRow[];
  totals: BucketTotalsForCardMetrics;
  /** Consolidated hub series for the inversiones parent card (same value the payload serves). */
  inversiones: InversionesPeriodMetrics | null;
};

/** Port of client `stripMetricsRowsForNavChild` (cash-savings node uses raw leaf ids minus shortfall). */
function stripMetricsRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const source = isCashSavingsNavNode(node)
    ? (() => {
        const leafIds = navLeafAccountIdSet(node);
        return rows.filter((a) => leafIds.has(a.account_id) && !isCashSavingsCcShortfallRow(a));
      })()
    : (() => {
        const ids = navMetricsAccountIdSet(node, rows);
        return rows.filter((a) => ids.has(a.account_id));
      })();
  return source.filter((a) => accountCountsTowardGroupTotals(a));
}

function childVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput
): NavCardMetricsVariantDto {
  const { rows, totals } = input;
  const metricsRows = stripMetricsRows(node, rows);
  const fullBucket = usesFullDashboardBucketTotals(node);

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto =>
    fullBucket ? bucketCardMetrics(rows, fullBucket, period) : cardMetricsFromRows(metricsRows, period);

  const titleFor = (period: CardMetricsPeriod, unit: "clp" | "usd"): number | null =>
    fullBucket
      ? bucketTitleBalanceDelta(rows, totals, fullBucket, period, unit)
      : subsetTitleBalanceDeltaRounded(metricsRows, period, unit);

  return {
    month: metricsFor("month"),
    year: metricsFor("year"),
    title_delta: {
      month_clp: titleFor("month", "clp"),
      month_usd: titleFor("month", "usd"),
      year_clp: titleFor("year", "clp"),
      year_usd: titleFor("year", "usd"),
    },
  };
}

/** Period fields from the consolidated hub slice over child-sum lifetime fields. */
function hubMetricsFromConsolidated(
  slice: { net_capital_flow_clp: number; balance_delta_clp: number | null } | null,
  lifetime: CardPeriodMetricsDto
): CardPeriodMetricsDto {
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

function parentVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput,
  childVariantBySlug: Map<string, NavCardMetricsVariantDto>
): NavCardMetricsVariantDto {
  const { rows, totals, inversiones } = input;
  const mode = parentTitleModeForNavNode(node);
  const subtreeIds = navMetricsAccountIdSet(node, rows);
  const subtreeRows = rows.filter((a) => subtreeIds.has(a.account_id));

  const childMetricsOfStripChildren = (period: CardMetricsPeriod): CardPeriodMetricsDto[] => {
    const stripChildren = portfolioStripGroupChildren(node);
    if (stripChildren.length === 0) {
      throw new Error(`nav card metrics: no strip children under nav node ${node.slug}`);
    }
    return stripChildren.map((child) => {
      const v = childVariantBySlug.get(child.slug) ?? childVariantForNode(child, input);
      return period === "month" ? v.month : v.year;
    });
  };

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto => {
    if (node.slug === "inversiones" && inversiones && mode.kind === "sum_dashboard_groups") {
      const lifetime = sumCardMetrics(childMetricsOfStripChildren(period));
      const slice = period === "month" ? inversiones.month : inversiones.year;
      return hubMetricsFromConsolidated(slice, lifetime);
    }
    if (mode.kind === "dashboard_group") {
      return bucketCardMetrics(rows, mode.group, period, (a) => subtreeIds.has(a.account_id));
    }
    if (mode.kind === "sum_dashboard_groups") {
      return sumCardMetrics(childMetricsOfStripChildren(period));
    }
    return cardMetricsFromRows(subtreeRows, period);
  };

  const titleFor = (period: CardMetricsPeriod, unit: "clp" | "usd"): number | null => {
    if (mode.kind === "dashboard_group") {
      return bucketTitleBalanceDelta(rows, totals, mode.group, period, unit, (a) =>
        subtreeIds.has(a.account_id)
      );
    }
    if (mode.kind === "sum_dashboard_groups") {
      let sum = 0;
      let any = false;
      for (const g of mode.groups) {
        const d = bucketTitleBalanceDelta(rows, totals, g, period, unit, (a) =>
          subtreeIds.has(a.account_id)
        );
        if (d != null && Number.isFinite(d)) {
          sum += d;
          any = true;
        }
      }
      return any ? Math.round(sum) : null;
    }
    return subsetTitleBalanceDeltaRounded(subtreeRows, period, unit);
  };

  return {
    month: metricsFor("month"),
    year: metricsFor("year"),
    title_delta: {
      month_clp: titleFor("month", "clp"),
      month_usd: titleFor("month", "usd"),
      year_clp: titleFor("year", "clp"),
      year_usd: titleFor("year", "usd"),
    },
  };
}

/**
 * Metrics for every group node of the given nav roots (roots included), keyed by slug.
 * Account leaves are skipped — compact account cards are single-row projections the client
 * keeps computing from its row. Each root is processed with its own child-variant map so a
 * slug shared across trees (e.g. `liabilities`) always composes from its own tree's children.
 */
export function buildNavCardMetricsBySlug(
  input: NavCardMetricsBuildInput
): Record<string, NavCardMetricsDto> {
  const out: Record<string, NavCardMetricsDto> = {};
  for (const navRoot of input.navRoots) {
    const groupNodes: NavTreeNodeDto[] = [];
    const visit = (n: NavTreeNodeDto) => {
      if (n.account_id == null && n.expense_account_id == null) groupNodes.push(n);
      for (const c of n.children ?? []) visit(c);
    };
    visit(navRoot);

    const childBySlug = new Map<string, NavCardMetricsVariantDto>();
    for (const node of groupNodes) {
      childBySlug.set(node.slug, childVariantForNode(node, input));
    }

    for (const node of groupNodes) {
      out[node.slug] = {
        child: childBySlug.get(node.slug)!,
        parent: parentVariantForNode(node, input, childBySlug),
      };
    }
  }
  return out;
}
