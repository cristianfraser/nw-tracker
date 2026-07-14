import { resolveOperationalAccountId } from "./accountSource.js";
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

function isNavBucketNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "nav_bucket";
}

function isLiabilityGroupNavNode(n: NavTreeNodeDto): boolean {
  return n.group_kind === "liability_group";
}

function resolveDashboardBucketFromNavNode(n: NavTreeNodeDto): string | null {
  const dash = n.dashboard_bucket_slug?.trim();
  if (dash && isDashboardNwBucketSlug(dash)) return dash;
  const asset = n.asset_group_slug?.trim();
  if (asset && isDashboardNwBucketSlug(asset)) return asset;
  if (isDashboardNwBucketSlug(n.slug)) return n.slug;
  return null;
}

/** Group node that becomes one chart series (ported from client `isPortfolioStripCardNode`). */
function isChartBucketCardNode(n: NavTreeNodeDto): boolean {
  if (!n.route_path?.trim() || isLiabilityGroupNavNode(n)) return false;
  if (isNavBucketNode(n) && n.slug !== "cash_eqs") return false;
  if (n.account_id != null || n.expense_account_id != null) return false;
  if (resolveDashboardBucketFromNavNode(n) != null) return true;
  if (n.asset_group_slug === "liabilities") return true;
  if (n.asset_group_slug === "credit_cards" && (n.children?.length ?? 0) > 0) return true;
  if (n.portfolio_group_id != null && (n.api_group || n.api_subgroup)) return true;
  return false;
}

function isChartBucketAccountNode(n: NavTreeNodeDto): boolean {
  return n.account_id != null && n.account_id > 0 && Boolean(n.route_path?.trim());
}

/** Group children for a chart bucket row; flattens `nav_bucket` hubs (except cash_eqs). */
function chartBucketGroupChildren(root: NavTreeNodeDto): NavTreeNodeDto[] {
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

/** Nav nodes that each become one chart series in "Agrupado" mode (ported from client). */
export function stripChartBucketNavNodes(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const groupKids = chartBucketGroupChildren(navNode);
  const accountKids = chartBucketAccountChildren(navNode);

  if (groupKids.length >= 2) return groupKids;

  if (groupKids.length === 1) {
    const sole = groupKids[0]!;
    const innerAccounts = chartBucketAccountChildren(sole);
    if (innerAccounts.length >= 2) return innerAccounts;
    const innerGroups = chartBucketGroupChildren(sole);
    if (innerGroups.length >= 2) return innerGroups;
    return [sole];
  }

  if (accountKids.length >= 2) return accountKids;
  return [];
}

/** "Sin agrupar": one nav level deeper than agrupado (flatten per grouped child). */
function navChartBucketNavNodesUngrouped(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const groupedKids = stripChartBucketNavNodes(navNode);
  const out: NavTreeNodeDto[] = [];
  for (const child of groupedKids) {
    const innerGroups = chartBucketGroupChildren(child);
    const innerAccounts = chartBucketAccountChildren(child);
    if (innerGroups.length >= 2) {
      out.push(...innerGroups);
    } else if (innerAccounts.length >= 2) {
      out.push(...innerAccounts);
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
      const op = resolveOperationalAccountId(n.account_id);
      if (op > 0) ids.push(op);
      if (n.source_account_id != null && n.source_account_id > 0) ids.push(n.source_account_id);
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
 * config (catches inactive/superseded masters the nav tree omits — e.g. santander ·1617); other
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
