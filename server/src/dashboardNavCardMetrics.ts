/**
 * Server-side card figures for the portfolio nav strip (home + group pages): the ONLY source
 * of a nav node's balance, deposits, P/L and %.
 *
 * One entry per group node of the net_worth nav tree (and the Pasivos root), keyed by
 * portfolio-group slug, with BOTH consumer variants precomputed:
 *   - `child`:  the node as a detail card (home second row, group-page children) and as a
 *               row of its parent's accounts table.
 *   - `parent`: the node as the summary card of its own page (incl. the home Patrimonio neto
 *               card = net_worth root) and its accounts table's «Total» row.
 * plus `value.members`, the un-netted Σ of the node's member rows (a card breakdown line).
 *
 * The rules started as a port of the client's Σ logic (2026-07-15); since 2026-10-28 the
 * client keeps no copy of them — it picks these numbers, and only single-account rows
 * (account table rows, account detail) are projected client-side from their own row.
 */
import type { DashboardAccountStats } from "./brokerageAcciones.js";
import {
  chartBucketGroupChildren as portfolioStripGroupChildren,
  isNavBucketNode,
  resolveDashboardBucketFromNavNode as resolveDashboardBucketSlugFromNavNode,
} from "./groupChartBuckets.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { isNwBucketSlug, nwBucketSlugs } from "./navTreeModel.js";
import { groupNetsLinkedCards } from "./cashEqsBucketNet.js";
import { endChargedFlow, flowAdjustedPct, groupStartFrameFlow } from "./periodReturns.js";
import type { TsUnit } from "./valuationTimeseries.js";

export type CardMetricsPeriod = "day" | "month" | "year";

/** One period of a card's metrics in the payload's unit (null = no row contributes that leg). */
export type CardPeriodMetricsDto = {
  deposits: number | null;
  delta_total: number | null;
  deposits_period: number | null;
  delta_period: number | null;
};

export type NavCardMetricsVariantDto = {
  day: CardPeriodMetricsDto;
  month: CardPeriodMetricsDto;
  year: CardPeriodMetricsDto;
};

/** A flow-adjusted % in the unit (null = no capital base, or the unit's legs are missing). */
export type NavCardPctDto = {
  value: number | null;
  /** Total cell only: the one-step P/L acumulado ÷ net deposits beside the compounded Total. */
  on_deposits?: number | null;
};

export type NavCardValueDto = {
  /** The detail card's balance: the dashboard bucket total (CC-netted cash) or Σ member rows. */
  child: number | null;
  /** The node's own page summary card / accounts-table «Total» row. */
  parent: number | null;
  /** Σ of the member rows the `child` metrics cover, never netted (a card breakdown line). */
  members: number | null;
  /** Some subtree row has no rate for its value in the unit. */
  fx_missing: boolean;
  /** Every subtree row reads a stale sync source. */
  sync_stale: boolean;
};

export type NavCardMetricsDto = {
  value: NavCardValueDto;
  child: NavCardMetricsVariantDto;
  parent: NavCardMetricsVariantDto;
  /**
   * The node's return as ONE row of its parent's accounts table (a bucket listed beside
   * accounts — Portafolio IPSA among Acciones' stocks): over the child-variant scope, with
   * each emptied member's withdrawal charged at the period end (`groupStartFrameFlow`).
   */
  row_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
  /** The node's own return over the `parent` variant's scope (its page's «Total» row). */
  parent_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
  /**
   * The liquidated rows of the node's accounts table, shown as one row: chart-inactive
   * accounts the table lists by themselves and, beside accounts, chart-inactive sub-buckets.
   * Every one that ever held money, whatever the period (the Total column stays complete).
   * Absent when there is none.
   */
  liquidated?: NavLiquidatedRowsDto;
};

export type NavLiquidatedRowsDto = {
  /** Chart-inactive member accounts listed on their own (not under a sub-bucket). */
  account_ids: number[];
  /** Chart-inactive sub-buckets listed beside the node's accounts. */
  group_slugs: string[];
  /** Σ over the rows' accounts (counts-toward-totals only). */
  metrics: NavCardMetricsVariantDto;
  /** Σ balance over the same rows. */
  value: { value: number | null; fx_missing: boolean };
  row_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
};

/** Narrow row view — the fields card metrics read from `DashboardAccountStats` (in one unit). */
export type CardMetricsAccountRow = Pick<
  DashboardAccountStats,
  | "account_id"
  | "group_slug"
  | "bucket_slug"
  | "dashboard_bucket_slug"
  | "chart_inactive"
  | "exclude_from_group_totals"
  | "deposits"
  | "delta_total"
  | "deposits_month"
  | "deposits_year"
  | "deposits_day"
  | "delta_month"
  | "delta_year"
  | "delta_day"
  | "current_value"
  | "prior_day_close"
  | "prior_month_close"
  | "prior_year_close"
  | "clp_basis"
> &
  Partial<Pick<DashboardAccountStats, "fx_missing" | "sync_stale">>;

/** A net-worth bucket slug (`nwBucketSlugs()`). */
type DashboardNwBucketSlug = string;

/* ------------------------------- row predicates ---------------------------------- */

export function accountCountsTowardGroupTotals(row: CardMetricsAccountRow): boolean {
  return row.exclude_from_group_totals !== 1;
}

function accountBelongsToDashboardBucket(row: CardMetricsAccountRow, bucket: string): boolean {
  if (row.dashboard_bucket_slug != null && row.dashboard_bucket_slug !== "") {
    return row.dashboard_bucket_slug === bucket;
  }
  const placement = row.bucket_slug ?? row.group_slug;
  return placement === bucket;
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

/**
 * Pesos are the ledger's own unit: every row carries its deposits and balance in them, so a sum
 * of no finite leg is zero; in any other unit it is a missing conversion (null).
 */
function emptySumIn(unit: TsUnit): 0 | null {
  return unit === "clp" ? 0 : null;
}

/** Σ of the finite values; `empty` when none is finite. */
function sumLeg(values: Iterable<number | null | undefined>, empty: number | null): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : empty;
}

function emptyPeriodMetrics(unit: TsUnit): CardPeriodMetricsDto {
  const empty = emptySumIn(unit);
  return { deposits: empty, delta_total: null, deposits_period: empty, delta_period: null };
}

function periodDeposits(r: CardMetricsAccountRow, period: CardMetricsPeriod): number | null | undefined {
  return period === "month" ? r.deposits_month : period === "day" ? r.deposits_day : r.deposits_year;
}

function periodDelta(r: CardMetricsAccountRow, period: CardMetricsPeriod): number | null | undefined {
  return period === "month" ? r.delta_month : period === "day" ? r.delta_day : r.delta_year;
}

/** Σ of the rows' card metrics for one period (null = no row contributes that leg). */
export function cardMetricsFromRows(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod,
  unit: TsUnit
): CardPeriodMetricsDto {
  const empty = emptySumIn(unit);
  return {
    deposits: sumLeg(
      rows.map((r) => r.deposits),
      empty
    ),
    delta_total: sumLeg(
      rows.map((r) => r.delta_total),
      null
    ),
    deposits_period: sumLeg(
      rows.map((r) => periodDeposits(r, period)),
      empty
    ),
    delta_period: sumLeg(
      rows.map((r) => periodDelta(r, period)),
      null
    ),
  };
}

/** Σ of card metrics already summed per part (same null rule). */
export function sumCardMetrics(parts: readonly CardPeriodMetricsDto[], unit: TsUnit): CardPeriodMetricsDto {
  if (parts.length === 0) return emptyPeriodMetrics(unit);
  const empty = emptySumIn(unit);
  return {
    deposits: sumLeg(
      parts.map((m) => m.deposits),
      empty
    ),
    delta_total: sumLeg(
      parts.map((m) => m.delta_total),
      null
    ),
    deposits_period: sumLeg(
      parts.map((m) => m.deposits_period),
      empty
    ),
    delta_period: sumLeg(
      parts.map((m) => m.delta_period),
      null
    ),
  };
}

/* -------------------------------- bucket metrics ---------------------------------- */


/** A dashboard bucket's card metrics: its counted rows, or `filter` replacing membership. */
function bucketCardMetrics(
  rows: readonly CardMetricsAccountRow[],
  bucket: DashboardNwBucketSlug,
  period: CardMetricsPeriod,
  unit: TsUnit,
  filter?: (row: CardMetricsAccountRow) => boolean
): CardPeriodMetricsDto {
  return cardMetricsFromRows(
    rows.filter((a) => accountInDashboardGroupScope(a, bucket, filter)),
    period,
    unit
  );
}

/* ------------------------------------ row % ------------------------------------- */

type PctLegs = {
  delta: number | null | undefined;
  prior: number | null | undefined;
  flow: number | null | undefined;
  close: number | null | undefined;
};

/** Group flow-adjusted % over member legs (the account rule, zero closes carried per member). */
function groupPctFromLegs(legs: readonly PctLegs[], withPrior: boolean, unit: TsUnit): number | null {
  if (legs.length === 0) return null;
  let nominal = 0;
  let prior = 0;
  let flow = 0;
  let close = 0;
  let endCharged = 0;
  let anyPrior = false;
  for (const l of legs) {
    // An empty member (no value, no prior value, no flow) has no return to report and no
    // weight in the group's: its missing delta must not blank the whole group's %.
    if (
      l.delta == null &&
      l.close === 0 &&
      (l.prior == null || l.prior === 0) &&
      (l.flow == null || l.flow === 0)
    ) {
      continue;
    }
    if (l.delta == null || !Number.isFinite(l.delta)) return null;
    if (l.close == null || !Number.isFinite(l.close)) return null;
    const f = l.flow != null && Number.isFinite(l.flow) ? l.flow : 0;
    nominal += l.delta;
    close += l.close;
    flow += f;
    endCharged += endChargedFlow(f, l.close, unit);
    if (withPrior && l.prior != null && Number.isFinite(l.prior)) {
      prior += l.prior;
      anyPrior = true;
    }
  }
  return flowAdjustedPct(nominal, anyPrior ? prior : null, groupStartFrameFlow(flow, endCharged), close, unit);
}

export function rowPctForRows(rows: readonly CardMetricsAccountRow[], unit: TsUnit): NavCardMetricsDto["row_pct"] {
  const cell = (legs: PctLegs[], withPrior: boolean): NavCardPctDto => ({
    value: groupPctFromLegs(legs, withPrior, unit),
  });
  return {
    day: cell(
      rows.map((r) => ({ delta: r.delta_day, prior: r.prior_day_close, flow: r.deposits_day, close: r.current_value })),
      true
    ),
    month: cell(
      rows.map((r) => ({ delta: r.delta_month, prior: r.prior_month_close, flow: r.deposits_month, close: r.current_value })),
      true
    ),
    year: cell(
      rows.map((r) => ({ delta: r.delta_year, prior: r.prior_year_close, flow: r.deposits_year, close: r.current_value })),
      true
    ),
    total: cell(
      rows.map((r) => ({ delta: r.delta_total, prior: null, flow: r.deposits, close: r.current_value })),
      false
    ),
  };
}

/* ------------------------------- nav-node helpers --------------------------------- */

function isNetWorthPortfolioRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Shared walk's resolver, narrowed to the typed bucket slugs this module works with. */
function resolveDashboardBucketFromNavNode(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  return resolveDashboardBucketSlugFromNavNode(node);
}

/** The dashboard bucket whose total a node's detail card shows (a cash child, a bucket's own node). */
function usesFullDashboardBucketTotals(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  const bucket = resolveDashboardBucketFromNavNode(node);
  if (!bucket) return null;
  // A netting bucket's card is its netted total, which no row sum gives: every node in it shows it.
  if (groupNetsLinkedCards(bucket)) return bucket;
  if (node.slug === bucket) return bucket;
  return null;
}

/** A cash child: its card nets the linked credit cards, its metrics read its raw leaves. */
export function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
  return node.account_id == null && groupNetsLinkedCards(node.slug) && !isNwBucketSlug(node.slug);
}

/** The dashboard buckets a nav hub spreads into (inversiones → retirement + brokerage). */
function dashboardBucketGroupsUnderNavHub(node: NavTreeNodeDto): DashboardNwBucketSlug[] {
  const out: DashboardNwBucketSlug[] = [];
  for (const child of portfolioStripGroupChildren(node)) {
    const g = resolveDashboardBucketFromNavNode(child);
    if (g) out.push(g);
  }
  return out;
}

export function navLeafAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return idSet;
}

/**
 * The accounts a group node's metrics cover — its nav leaves plus every `member_account_ids`
 * entry in its subtree (the chart-inactive members the sidebar tree omits, which an
 * all-inactive sub-bucket keeps only there). Membership is the tree's, never slug prefixes.
 */
export function navMetricsAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const ids = navLeafAccountIdSet(node);
  const visit = (n: NavTreeNodeDto) => {
    for (const id of n.member_account_ids ?? []) ids.add(id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return ids;
}

type ParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardNwBucketSlug }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardNwBucketSlug[] }
  | { kind: "subset_only" };

/** How a node's own summary card composes: one bucket, Σ of buckets, or its subtree rows. */
function parentTitleModeForNavNode(node: NavTreeNodeDto): ParentTitleDeltaMode {
  if (isNetWorthPortfolioRoot(node)) {
    return { kind: "sum_dashboard_groups", groups: nwBucketSlugs() };
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

/* ------------------------------- table row sets ----------------------------------- */

function material(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(v) && Math.abs(v) >= 0.5;
}

/**
 * A chart-inactive account that once held money (never-funded accounts are not liquidated) — in
 * pesos whatever the unit, so the same rows are liquidated in every unit.
 */
function accountWasLiquidated(row: CardMetricsAccountRow): boolean {
  const b = row.clp_basis;
  return row.chart_inactive === true && (material(b.deposits) || material(b.delta_total) || material(b.current_value));
}

/**
 * The rows the client's accounts table groups as «Liquidadas» for `node`: the chart-inactive
 * member accounts no nav leaf or sub-bucket of the node lists, plus — when the table lists
 * sub-buckets beside accounts — its chart-inactive sub-buckets.
 */
export function liquidatedRowsForNode(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[],
  unit: TsUnit,
  chainedGroupPct?: ChainedGroupPct
): NavLiquidatedRowsDto | null {
  const children = node.children ?? [];
  const accountChildren = children.filter(
    (c) => c.account_id != null && c.account_id > 0 && Boolean(c.route_path?.trim())
  );
  const groupChildren = children.filter(
    (c) => c.account_id == null && c.expense_account_id == null
  );
  const groupsAsRows = accountChildren.length > 0 && groupChildren.length > 0;
  const inactiveGroups = groupsAsRows
    ? groupChildren.filter((c) => c.chart_inactive === true && Boolean(c.route_path?.trim()))
    : [];

  const leafIds = navLeafAccountIdSet(node);
  const memberIds = navMetricsAccountIdSet(node);
  const covered = new Set<number>();
  for (const g of groupChildren) for (const id of navMetricsAccountIdSet(g)) covered.add(id);

  const accountRows = rows
    .filter(
      (r) =>
        memberIds.has(r.account_id) &&
        !leafIds.has(r.account_id) &&
        !covered.has(r.account_id) &&
        accountWasLiquidated(r)
    )
    .sort((a, b) => a.account_id - b.account_id);

  if (accountRows.length === 0 && inactiveGroups.length === 0) return null;

  const byId = new Map<number, CardMetricsAccountRow>();
  for (const r of accountRows) {
    if (accountCountsTowardGroupTotals(r)) byId.set(r.account_id, r);
  }
  for (const g of inactiveGroups) {
    for (const r of stripMetricsRows(g, rows)) byId.set(r.account_id, r);
  }
  const metricsRows = [...byId.values()];
  const metrics: NavCardMetricsVariantDto = {
    day: cardMetricsFromRows(metricsRows, "day", unit),
    month: cardMetricsFromRows(metricsRows, "month", unit),
    year: cardMetricsFromRows(metricsRows, "year", unit),
  };
  const accountIds = metricsRows.map((r) => r.account_id).sort((a, b) => a - b);
  return {
    account_ids: accountRows.map((r) => r.account_id),
    group_slugs: inactiveGroups.map((g) => g.slug),
    metrics,
    value: {
      value: sumRowValues(metricsRows, unit),
      fx_missing: metricsRows.some((r) => r.fx_missing === true),
    },
    row_pct: withChainedGroupPct(
      rowPctForRows(metricsRows, unit),
      { kind: "liquidated", parentSlug: node.slug, accountIds },
      unit,
      chainedGroupPct
    ),
  };
}

/** The rows the `parent` variant sums, for its % (a hub's: every counted member). */
function parentScopeRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const mode = parentTitleModeForNavNode(node);
  const subtreeIds = navMetricsAccountIdSet(node);
  if (mode.kind === "dashboard_group") {
    return rows.filter((a) =>
      accountInDashboardGroupScope(a, mode.group, (r) => subtreeIds.has(r.account_id))
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    return rows.filter((a) => subtreeIds.has(a.account_id) && accountCountsTowardGroupTotals(a));
  }
  return rows.filter((a) => subtreeIds.has(a.account_id));
}

/* ------------------------------------ value ------------------------------------- */

/** Dashboard bucket totals (`buildDashboardNwBucketTotals`): the CC-netted cash bucket included. */
export type NavCardBucketTotals = { buckets: Readonly<Record<string, number | null>> };

/** Σ current value in the unit: rows without one count 0 in pesos; null elsewhere when no row carries one. */
export function sumRowValues(rows: readonly CardMetricsAccountRow[], unit: TsUnit): number | null {
  return sumLeg(
    rows.map((r) => r.current_value),
    emptySumIn(unit)
  );
}

function bucketAmount(totals: NavCardBucketTotals, bucket: DashboardNwBucketSlug): number | null {
  if (!(bucket in totals.buckets)) throw new Error(`nav card metrics: no total for bucket ${bucket}`);
  const v = totals.buckets[bucket];
  return v != null && Number.isFinite(v) ? v : null;
}

function sumAmounts(parts: readonly (number | null)[], unit: TsUnit): number | null {
  return sumLeg(parts, emptySumIn(unit));
}

function nodeValue(node: NavTreeNodeDto, input: NavCardMetricsBuildInput): NavCardValueDto {
  const { rows, bucketTotals, unit } = input;
  const subtreeIds = navMetricsAccountIdSet(node);
  const subtreeRows = rows.filter((r) => subtreeIds.has(r.account_id));
  const members = sumRowValues(stripMetricsRows(node, rows), unit);
  const fullBucket = usesFullDashboardBucketTotals(node);
  const child = fullBucket ? bucketAmount(bucketTotals, fullBucket) : members;
  const mode = parentTitleModeForNavNode(node);
  const parent =
    mode.kind === "dashboard_group"
      ? bucketAmount(bucketTotals, mode.group)
      : mode.kind === "sum_dashboard_groups"
        ? sumAmounts(
            mode.groups.map((g) => bucketAmount(bucketTotals, g)),
            unit
          )
        : sumRowValues(subtreeRows, unit);
  return {
    child,
    parent,
    members,
    fx_missing: subtreeRows.some((r) => r.fx_missing === true),
    sync_stale: subtreeRows.length > 0 && subtreeRows.every((r) => r.sync_stale === true),
  };
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
  /** The dashboard bucket totals the payload carries (same unit): a bucket node's balance reads them. */
  bucketTotals: NavCardBucketTotals;
  /** The display unit of the rows and the totals. */
  unit: TsUnit;
  /**
   * A group's period % compounded from its daily returns (`periodPctDailyChain.ts`) — the
   * group's own daily series, or the series over a page's liquidated rows. Absent (tests, pure
   * callers): the one-step cells stay.
   */
  chainedGroupPct?: ChainedGroupPct;
};

export type ChainedGroupScope =
  | { kind: "group"; slug: string }
  | { kind: "liquidated"; parentSlug: string; accountIds: readonly number[] }
  | { kind: "account"; accountId: number };

/** `undefined`: the scope keeps its one-step cell (liabilities only). */
export type ChainedGroupPct = (
  scope: ChainedGroupScope,
  period: CardMetricsPeriod | "total",
  unit: TsUnit
) => number | null | undefined;

/**
 * `pct` with every cell read from `chained` — the scope's daily returns compounded over the
 * period (`periodPctDailyChain.ts`). The one-step Total (P/L ÷ net deposits) moves to the total
 * cell's `on_deposits_*`. A cell `chained` answers `undefined` for (a scope of liabilities only)
 * keeps the one-step value; without a resolver (tests, pure callers) `pct` is returned as is.
 */
export function withChainedGroupPct(
  pct: NavCardMetricsDto["row_pct"],
  scope: ChainedGroupScope,
  unit: TsUnit,
  chained: ChainedGroupPct | undefined
): NavCardMetricsDto["row_pct"] {
  if (!chained) return pct;
  const out = { ...pct };
  for (const period of ["day", "month", "year", "total"] as const) {
    const cell: NavCardPctDto = { ...pct[period] };
    const v = chained(scope, period, unit);
    if (v !== undefined) {
      cell.value = v;
      if (period === "total") cell.on_deposits = pct.total.value;
    }
    out[period] = cell;
  }
  return out;
}

/** The rows a node's detail card covers: counted members (a cash child: its raw leaves). */
export function stripMetricsRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const source = isCashSavingsNavNode(node)
    ? (() => {
        const leafIds = navLeafAccountIdSet(node);
        return rows.filter((a) => leafIds.has(a.account_id));
      })()
    : (() => {
        const ids = navMetricsAccountIdSet(node);
        return rows.filter((a) => ids.has(a.account_id));
      })();
  return source.filter((a) => accountCountsTowardGroupTotals(a));
}

function childVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput
): NavCardMetricsVariantDto {
  const { rows, unit } = input;
  const metricsRows = stripMetricsRows(node, rows);
  const fullBucket = usesFullDashboardBucketTotals(node);

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto =>
    fullBucket ? bucketCardMetrics(rows, fullBucket, period, unit) : cardMetricsFromRows(metricsRows, period, unit);

  return {
    day: metricsFor("day"),
    month: metricsFor("month"),
    year: metricsFor("year"),
  };
}

function parentVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput,
  childVariantBySlug: Map<string, NavCardMetricsVariantDto>
): NavCardMetricsVariantDto {
  const { rows, unit } = input;
  const mode = parentTitleModeForNavNode(node);
  const subtreeIds = navMetricsAccountIdSet(node);
  const subtreeRows = rows.filter((a) => subtreeIds.has(a.account_id));

  const childMetricsOfStripChildren = (period: CardMetricsPeriod): CardPeriodMetricsDto[] => {
    const stripChildren = portfolioStripGroupChildren(node);
    if (stripChildren.length === 0) {
      throw new Error(`nav card metrics: no strip children under nav node ${node.slug}`);
    }
    return stripChildren.map((child) => {
      const v = childVariantBySlug.get(child.slug) ?? childVariantForNode(child, input);
      return period === "month" ? v.month : period === "day" ? v.day : v.year;
    });
  };

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto => {
    if (mode.kind === "dashboard_group") {
      return bucketCardMetrics(rows, mode.group, period, unit, (a) => subtreeIds.has(a.account_id));
    }
    if (mode.kind === "sum_dashboard_groups") {
      return sumCardMetrics(childMetricsOfStripChildren(period), unit);
    }
    return cardMetricsFromRows(subtreeRows, period, unit);
  };

  return {
    day: metricsFor("day"),
    month: metricsFor("month"),
    year: metricsFor("year"),
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
      const liquidated = liquidatedRowsForNode(node, input.rows, input.unit, input.chainedGroupPct);
      const child = childBySlug.get(node.slug)!;
      const parent = parentVariantForNode(node, input, childBySlug);
      const scope: ChainedGroupScope = { kind: "group", slug: node.slug };
      const childRows = stripMetricsRows(node, input.rows);
      const parentRows = parentScopeRows(node, input.rows);
      out[node.slug] = {
        value: nodeValue(node, input),
        child,
        parent,
        row_pct: withChainedGroupPct(rowPctForRows(childRows, input.unit), scope, input.unit, input.chainedGroupPct),
        parent_pct: withChainedGroupPct(
          rowPctForRows(parentRows, input.unit),
          scope,
          input.unit,
          input.chainedGroupPct
        ),
        ...(liquidated ? { liquidated } : {}),
      };
    }
  }
  return out;
}
