import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { isNwBucketSlug } from "./navTreeModel.js";

/**
 * Server-side chart bucketing for portfolio-group / Pasivos pages — the single source of the
 * "Agrupado" bucket lines (previously re-derived on the client from already-clipped series, which
 * corrupted the grouped totals). Bucket nodes are selected from the same {@link NavTreeNodeDto}
 * tree the sidebar uses; the aggregation itself runs on the **unclipped** valuation block and the
 * display clip is applied afterwards (see valuationTimeseries.ts).
 */
export type ChartBucketMeta = {
  key: string;
  /** Synthetic negative account id for the bucket line (nav: -720-i, liab: -810-i). */
  accountId: number;
  dataKey: string;
  depKey: string;
  barDataKey: string;
  name: string;
  /** i18n key resolved by the client at render (nav node `label_i18n_key`); `null` → use `name`. */
  name_i18n_key: string | null;
  color_rgb: string | null;
};

export type ChartBucketPlan = {
  orderedKeys: string[];
  meta: Record<string, ChartBucketMeta>;
  /** Map a timeseries/perf account id to its bucket key (`null` = keep as its own line/bar). */
  idToBucket: (accountId: number) => string | null;
};

export function isNavBucketNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "nav_bucket";
}

export function isLiabilityGroupNavNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "liability_group";
}

/** The net-worth bucket a nav node IS (its `nw_bucket` role), or null. */
export function resolveDashboardBucketFromNavNode(n: NavTreeNodeDto): string | null {
  return n.account_id == null && isNwBucketSlug(n.slug) ? n.slug : null;
}

/** Group node that becomes one chart series / strip card (single source; client picks emitted structure). */
export function isChartBucketCardNode(n: NavTreeNodeDto): boolean {
  if (!n.route_path?.trim() || isLiabilityGroupNavNode(n)) return false;
  // A hub that is not itself a net-worth bucket (Inversiones) is spread into its children.
  if (isNavBucketNode(n) && !isNwBucketSlug(n.slug)) return false;
  if (n.account_id != null || n.expense_account_id != null) return false;
  if (resolveDashboardBucketFromNavNode(n) != null) return true;
  if (n.asset_group_slug === "liabilities") return true;
  if (n.portfolio_group_id != null && (n.api_group || n.api_subgroup)) return true;
  if (n.portfolio_group_id != null && n.kind_slug) return true;
  return false;
}

function isChartBucketAccountNode(n: NavTreeNodeDto): boolean {
  return n.account_id != null && n.account_id > 0 && Boolean(n.route_path?.trim());
}

/** Group children for a chart bucket row; flattens `nav_bucket` hubs that are not net-worth buckets. */
export function chartBucketGroupChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  for (const child of root.children ?? []) {
    if (isNavBucketNode(child) && !isNwBucketSlug(child.slug)) {
      out.push(...chartBucketGroupChildren(child));
      continue;
    }
    if (isChartBucketCardNode(child)) out.push(child);
  }
  return out;
}

function chartBucketAccountChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  return (root.children ?? []).filter(isChartBucketAccountNode);
}

/** A nav node's CLP mark on a day: its account, or the sum over a group's subtree. */
function navNodeMarkClp(n: NavTreeNodeDto, ymd: string): number {
  const ids = n.account_id != null && n.account_id > 0 ? [n.account_id] : collectSubtreeAccountIds(n);
  let sum = 0;
  let any = false;
  for (const id of ids) {
    const mark = accountMarkClpAtYmd(id, ymd);
    if (mark != null && Number.isFinite(mark.value_clp)) {
      sum += mark.value_clp;
      any = true;
    }
  }
  return any ? sum : Number.NEGATIVE_INFINITY;
}

/**
 * Graph ordering for account-node buckets, and for the first-level children of a bucket that
 * holds accounts beside sub-buckets: yesterday's close (CLP mark; a group's is its subtree's)
 * descending, then label. A group-only bucket keeps the hand-set nav order — matching the
 * per-account row ordering (see groupTabOrdering.ts). Yesterday's, not today's (2026-11-04): an
 * order read from live prices made the sidebar and every page using it depend on every price,
 * so each move refetched them (`X-Live-Inputs`); the order now holds for the day.
 */
function sortNavNodesByMarkDesc(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  const yesterday = chileCalendarAddDays(chileCalendarTodayYmd(), -1);
  const value = new Map<NavTreeNodeDto, number>();
  for (const n of nodes) value.set(n, navNodeMarkClp(n, yesterday));
  return [...nodes].sort((a, b) => {
    const va = value.get(a)!;
    const vb = value.get(b)!;
    if (va !== vb) return vb - va;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

/**
 * A bucket's first-level chart children when it holds accounts beside sub-buckets (Acciones:
 * its stocks and the Portafolio IPSA unit) — each one line, by balance. `null` for a bucket
 * that holds only one kind (the rules below apply there).
 */
function mixedChartChildren(navNode: NavTreeNodeDto): NavTreeNodeDto[] | null {
  const groupKids = chartBucketGroupChildren(navNode);
  const accountKids = chartBucketAccountChildren(navNode);
  if (groupKids.length === 0 || accountKids.length === 0) return null;
  return sortNavNodesByMarkDesc([...groupKids, ...accountKids]);
}

/** Nav nodes that each become one chart series in "Agrupado" mode (single source; client picks). */
export function stripChartBucketNavNodes(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const mixed = mixedChartChildren(navNode);
  if (mixed) return mixed;

  const groupKids = chartBucketGroupChildren(navNode);
  const accountKids = chartBucketAccountChildren(navNode);

  if (groupKids.length >= 2) return groupKids;

  if (groupKids.length === 1) {
    const sole = groupKids[0]!;
    const soleMixed = mixedChartChildren(sole);
    if (soleMixed) return soleMixed;
    const innerAccounts = chartBucketAccountChildren(sole);
    if (innerAccounts.length >= 2) return sortNavNodesByMarkDesc(innerAccounts);
    const innerGroups = chartBucketGroupChildren(sole);
    if (innerGroups.length >= 2) return innerGroups;
    return [sole];
  }

  if (accountKids.length >= 2) return sortNavNodesByMarkDesc(accountKids);
  return [];
}

/** "Sin agrupar": one nav level deeper than agrupado (flatten per grouped child). */
function navChartBucketNavNodesUngrouped(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const groupedKids = stripChartBucketNavNodes(navNode);
  const out: NavTreeNodeDto[] = [];
  for (const child of groupedKids) {
    const mixed = mixedChartChildren(child);
    const innerGroups = chartBucketGroupChildren(child);
    const innerAccounts = chartBucketAccountChildren(child);
    if (mixed) {
      out.push(...mixed);
    } else if (innerGroups.length >= 2) {
      out.push(...innerGroups);
    } else if (innerAccounts.length >= 2) {
      out.push(...sortNavNodesByMarkDesc(innerAccounts));
    } else {
      out.push(child);
    }
  }
  return out;
}

export function navChartBucketNavNodes(navNode: NavTreeNodeDto, grouped: boolean): NavTreeNodeDto[] {
  return grouped ? stripChartBucketNavNodes(navNode) : navChartBucketNavNodesUngrouped(navNode);
}

/** ≥2 buckets in this mode → the client shows grouped lines; otherwise raw per-account lines. */
export function shouldAggregateNavCharts(navNode: NavTreeNodeDto, grouped: boolean): boolean {
  return navChartBucketNavNodes(navNode, grouped).length >= 2;
}

export function isLiabilitiesChartNavNode(navNode: NavTreeNodeDto): boolean {
  return (
    navNode.asset_group_slug === "liabilities" ||
    navNode.slug.startsWith("liabilities_") ||
    isLiabilityGroupNavNode(navNode)
  );
}

export function shouldAggregateLiabilitiesCharts(navNode: NavTreeNodeDto): boolean {
  return isLiabilitiesChartNavNode(navNode) && stripChartBucketNavNodes(navNode).length >= 2;
}

/** Operational account ids under a nav subtree (own id + operational alias + liability source id). */
function collectSubtreeAccountIds(node: NavTreeNodeDto): number[] {
  const ids: number[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) {
      ids.push(n.account_id);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return ids;
}

/**
 * Members of a liability bucket: a liability group's own member list (`member_account_ids`, which
 * keeps the cards the nav tree hides — retired masters); an account bucket is itself. No
 * account-name heuristics.
 */
function liabilityBucketAccountIds(node: NavTreeNodeDto): number[] {
  if (node.account_id == null && node.member_account_ids) return [...node.member_account_ids];
  return collectSubtreeAccountIds(node);
}

function buildBucketPlanFromNodes(
  bucketNodes: readonly NavTreeNodeDto[],
  opts: { idBase: number; keyPrefix: "nav" | "liab"; memberIds: (node: NavTreeNodeDto) => number[] }
): ChartBucketPlan {
  const orderedKeys: string[] = [];
  const meta: Record<string, ChartBucketMeta> = {};
  const accountIdToKey = new Map<number, string>();

  bucketNodes.forEach((child, index) => {
    const key = child.slug;
    const safe = key.replace(/[^a-z0-9]/gi, "_");
    const dataKey = `${opts.keyPrefix}_${safe}`;
    orderedKeys.push(key);
    meta[key] = {
      key,
      accountId: opts.idBase - index,
      dataKey,
      depKey: `${dataKey}_dep`,
      barDataKey: `pl_${dataKey}`,
      name: child.label,
      name_i18n_key: child.label_i18n_key,
      color_rgb: child.color_rgb ?? null,
    };
    for (const id of opts.memberIds(child)) {
      if (!accountIdToKey.has(id)) accountIdToKey.set(id, key);
    }
  });

  return {
    orderedKeys,
    meta,
    idToBucket: (id) => accountIdToKey.get(id) ?? null,
  };
}

export function buildNavChartBucketPlan(navNode: NavTreeNodeDto, grouped: boolean): ChartBucketPlan {
  return buildBucketPlanFromNodes(navChartBucketNavNodes(navNode, grouped), {
    idBase: -720,
    keyPrefix: "nav",
    memberIds: collectSubtreeAccountIds,
  });
}

export function buildLiabilitiesChartBucketPlan(navNode: NavTreeNodeDto): ChartBucketPlan {
  return buildBucketPlanFromNodes(stripChartBucketNavNodes(navNode), {
    idBase: -810,
    keyPrefix: "liab",
    memberIds: liabilityBucketAccountIds,
  });
}

/**
 * A page's grouped chart structure — the ONE decision every grouped payload reads (the valuation
 * blocks, the monthly P/L bars, the daily series, the sidebar's chart skeleton): a Pasivos page has
 * one liabilities plan; any other page a plan per Agrupado mode with ≥2 buckets. Null when the page
 * draws no grouped chart.
 */
export type PageChartPlan =
  | { kind: "liabilities"; plan: ChartBucketPlan }
  | { kind: "nav"; grouped: ChartBucketPlan | null; ungrouped: ChartBucketPlan | null };

export function pageChartPlan(navNode: NavTreeNodeDto): PageChartPlan | null {
  if (isLiabilitiesChartNavNode(navNode)) {
    return shouldAggregateLiabilitiesCharts(navNode)
      ? { kind: "liabilities", plan: buildLiabilitiesChartBucketPlan(navNode) }
      : null;
  }
  const grouped = shouldAggregateNavCharts(navNode, true) ? buildNavChartBucketPlan(navNode, true) : null;
  const ungrouped = shouldAggregateNavCharts(navNode, false) ? buildNavChartBucketPlan(navNode, false) : null;
  return grouped || ungrouped ? { kind: "nav", grouped, ungrouped } : null;
}

/** Client projection of {@link ChartBucketMeta} — one grouped chart line, emitted on the nav tree. */
export type ChartBucketLineMetaDto = {
  data_key: string;
  /** Synthetic negative account id — same id the real grouped block's line carries. */
  account_id: number;
  dep_key: string;
  bar_data_key: string;
  name: string;
  name_i18n_key: string | null;
  color_rgb: string | null;
};

export type NavNodeChartBucketsDto = {
  grouped?: ChartBucketLineMetaDto[];
  ungrouped?: ChartBucketLineMetaDto[];
  /** Pasivos pages: single grouped mode, no Agrupado toggle. */
  liab?: ChartBucketLineMetaDto[];
};

function planLineMetaDtos(plan: ChartBucketPlan): ChartBucketLineMetaDto[] {
  return plan.orderedKeys.map((key) => {
    const m = plan.meta[key]!;
    return {
      data_key: m.dataKey,
      account_id: m.accountId,
      dep_key: m.depKey,
      bar_data_key: m.barDataKey,
      name: m.name,
      name_i18n_key: m.name_i18n_key,
      color_rgb: m.color_rgb,
    };
  });
}

/**
 * Grouped chart structure for a nav node, emitted on the sidebar-nav payload so the client's
 * loading skeleton renders the same bucket lines the real payload will carry. Emission conditions
 * mirror `buildGroupedChartPayload` (valuationTimeseries.ts) exactly: a mode is present here iff
 * the real payload emits that grouped block, so payload-presence toggles agree skeleton↔real.
 */
export function chartBucketsDtoForNavNode(navNode: NavTreeNodeDto): NavNodeChartBucketsDto | null {
  const plan = pageChartPlan(navNode);
  if (!plan) return null;
  if (plan.kind === "liabilities") return { liab: planLineMetaDtos(plan.plan) };
  return {
    ...(plan.grouped ? { grouped: planLineMetaDtos(plan.grouped) } : {}),
    ...(plan.ungrouped ? { ungrouped: planLineMetaDtos(plan.ungrouped) } : {}),
  };
}
