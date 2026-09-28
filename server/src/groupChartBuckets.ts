import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import type { NavTreeNodeDto } from "./navTree.js";

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

const DASHBOARD_NW_BUCKET_SLUGS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

function isDashboardNwBucketSlug(slug: string): boolean {
  return DASHBOARD_NW_BUCKET_SLUGS.has(slug);
}

export function isNavBucketNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "nav_bucket";
}

export function isLiabilityGroupNavNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "liability_group";
}

export function resolveDashboardBucketFromNavNode(n: NavTreeNodeDto): string | null {
  const dash = n.dashboard_bucket_slug?.trim();
  if (dash && isDashboardNwBucketSlug(dash)) return dash;
  const asset = n.asset_group_slug?.trim();
  if (asset && isDashboardNwBucketSlug(asset)) return asset;
  if (isDashboardNwBucketSlug(n.slug)) return n.slug;
  return null;
}

/** Group node that becomes one chart series / strip card (single source; client picks emitted structure). */
export function isChartBucketCardNode(n: NavTreeNodeDto): boolean {
  if (!n.route_path?.trim() || isLiabilityGroupNavNode(n)) return false;
  if (isNavBucketNode(n) && n.slug !== "cash_eqs") return false;
  if (n.account_id != null || n.expense_account_id != null) return false;
  if (resolveDashboardBucketFromNavNode(n) != null) return true;
  if (n.asset_group_slug === "liabilities") return true;
  if (n.asset_group_slug === "credit_cards" && (n.children?.length ?? 0) > 0) return true;
  if (n.portfolio_group_id != null && (n.api_group || n.api_subgroup)) return true;
  if (n.portfolio_group_id != null && n.kind_slug) return true;
  return false;
}

function isChartBucketAccountNode(n: NavTreeNodeDto): boolean {
  return n.account_id != null && n.account_id > 0 && Boolean(n.route_path?.trim());
}

/** Group children for a chart bucket row; flattens `nav_bucket` hubs (except cash_eqs). */
export function chartBucketGroupChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  for (const child of root.children ?? []) {
    if (isNavBucketNode(child) && child.slug !== "cash_eqs") {
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

/** Today's CLP mark of a nav node: its account, or the sum over a group's subtree. */
function navNodeMarkClp(n: NavTreeNodeDto, today: string): number {
  const ids = n.account_id != null && n.account_id > 0 ? [n.account_id] : collectSubtreeAccountIds(n);
  let sum = 0;
  let any = false;
  for (const id of ids) {
    const mark = accountMarkClpAtYmd(id, today);
    if (mark != null && Number.isFinite(mark.value_clp)) {
      sum += mark.value_clp;
      any = true;
    }
  }
  return any ? sum : Number.NEGATIVE_INFINITY;
}

/**
 * Graph ordering for account-node buckets, and for the first-level children of a bucket that
 * holds accounts beside sub-buckets: current valuation (today's CLP mark; a group's is its
 * subtree's) descending, then label. A group-only bucket keeps the hand-set nav order —
 * matching the per-account row ordering (see groupTabOrdering.ts).
 */
function sortNavNodesByMarkDesc(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  const today = chileCalendarTodayYmd();
  const value = new Map<NavTreeNodeDto, number>();
  for (const n of nodes) value.set(n, navNodeMarkClp(n, today));
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
    navNode.asset_group_slug === "credit_cards" ||
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

/** Credit-card issuer child slugs (`santander`, `bci`) under a CC-parent bucket node. */
function creditCardIssuerChildSlugs(node: NavTreeNodeDto): string[] {
  const out: string[] = [];
  for (const c of node.children ?? []) {
    if (getCreditCardGroupBySlug(c.slug)) out.push(c.slug);
  }
  return out;
}

/**
 * Members of a liability bucket. CC issuer groups and the CC parent resolve via `credit_card_groups`
 * config (catches inactive/superseded masters the nav tree omits — e.g. santander ·0161); other
 * buckets (mortgage) use nav-subtree membership. No account-name heuristics.
 */
function liabilityBucketAccountIds(node: NavTreeNodeDto): number[] {
  if (getCreditCardGroupBySlug(node.slug)) {
    return listCreditCardGroupMasterAccountIds(node.slug);
  }
  if (node.slug === "liabilities_credit_card" || node.api_subgroup === "credit_card") {
    const issuers = creditCardIssuerChildSlugs(node);
    if (issuers.length > 0) {
      const ids = new Set<number>();
      for (const issuer of issuers) {
        for (const id of listCreditCardGroupMasterAccountIds(issuer)) ids.add(id);
      }
      return [...ids];
    }
  }
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
  if (isLiabilitiesChartNavNode(navNode)) {
    if (!shouldAggregateLiabilitiesCharts(navNode)) return null;
    return { liab: planLineMetaDtos(buildLiabilitiesChartBucketPlan(navNode)) };
  }
  const out: NavNodeChartBucketsDto = {};
  for (const grouped of [true, false] as const) {
    if (!shouldAggregateNavCharts(navNode, grouped)) continue;
    out[grouped ? "grouped" : "ungrouped"] = planLineMetaDtos(buildNavChartBucketPlan(navNode, grouped));
  }
  return out.grouped || out.ungrouped ? out : null;
}
