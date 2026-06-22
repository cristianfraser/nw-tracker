import { navAccountIdSet } from "./portfolioNavDashboardCards";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { AccountListRow, NavTreeNodeDto } from "./types";

export type NavChartBucketMeta = {
  key: string;
  accountId: number;
  dataKey: string;
  depKey: string;
  barDataKey: string;
  name: string;
  /** Nav / portfolio group color (`r,g,b`). */
  color_rgb?: string | null;
};

function syntheticAccountId(index: number): number {
  return -720 - index;
}

/**
 * Nav nodes that become one chart series (portfolio strip children; drill when a sole
 * group wraps multiple leaves). Same rules as Pasivos grouped charts.
 */
export function stripChartBucketNavNodes(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const groupKids = portfolioStripGroupChildren(navNode);
  const accountKids = portfolioStripAccountChildren(navNode);

  if (groupKids.length >= 2) return groupKids;

  if (groupKids.length === 1) {
    const sole = groupKids[0]!;
    const innerAccounts = portfolioStripAccountChildren(sole);
    if (innerAccounts.length >= 2) return innerAccounts;
    const innerGroups = portfolioStripGroupChildren(sole);
    if (innerGroups.length >= 2) return innerGroups;
    return [sole];
  }

  if (accountKids.length >= 2) return accountKids;
  return [];
}

/** Sin agrupar: one nav level deeper than agrupado (flatten per grouped child). */
export function navChartBucketNavNodesUngrouped(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const groupedKids = stripChartBucketNavNodes(navNode);
  const out: NavTreeNodeDto[] = [];
  for (const child of groupedKids) {
    const innerGroups = portfolioStripGroupChildren(child);
    const innerAccounts = portfolioStripAccountChildren(child);
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

export function shouldShowNavGroupedChartToggle(navNode: NavTreeNodeDto): boolean {
  return stripChartBucketNavNodes(navNode).length >= 2 || navChartBucketNavNodesUngrouped(navNode).length >= 2;
}

export function shouldAggregateNavCharts(navNode: NavTreeNodeDto, grouped: boolean): boolean {
  return navChartBucketNavNodes(navNode, grouped).length >= 2;
}

/** Portfolio / asset group slugs under a chart bucket node (group nodes only). */
export function collectNavBucketCoverageKeys(node: NavTreeNodeDto): string[] {
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

/**
 * Map a leaf `asset_groups.slug` to the chart bucket that owns it.
 * Picks the longest matching prefix among `bucketNodes`.
 */
export function chartBucketKeyForAccountAssetSlug(
  accountBucketSlug: string,
  bucketNodes: readonly NavTreeNodeDto[]
): string | null {
  let best: { bucketKey: string; prefixLen: number } | null = null;
  for (const node of bucketNodes) {
    const bucketKey = node.slug;
    for (const prefix of collectNavBucketCoverageKeys(node)) {
      if (accountBucketSlug !== prefix && !accountBucketSlug.startsWith(`${prefix}__`)) continue;
      if (!best || prefix.length > best.prefixLen) {
        best = { bucketKey, prefixLen: prefix.length };
      }
    }
  }
  return best?.bucketKey ?? null;
}

export function buildNavChartBucketPlan(
  navNode: NavTreeNodeDto,
  grouped: boolean,
  listRows?: readonly Pick<AccountListRow, "id" | "bucket_slug" | "chart_inactive">[]
): {
  orderedKeys: readonly string[];
  meta: Record<string, NavChartBucketMeta>;
  idToBucket: (accountId: number) => string | null;
} {
  const bucketNodes = navChartBucketNavNodes(navNode, grouped);
  const orderedKeys: string[] = [];
  const meta: Record<string, NavChartBucketMeta> = {};
  const accountIdToKey = new Map<number, string>();

  bucketNodes.forEach((child, index) => {
    const key = child.slug;
    const accountId = syntheticAccountId(index);
    const safe = key.replace(/[^a-z0-9]/gi, "_");
    const dataKey = `nav_${safe}`;
    orderedKeys.push(key);
    meta[key] = {
      key,
      accountId,
      dataKey,
      depKey: `${dataKey}_dep`,
      barDataKey: `pl_${dataKey}`,
      name: resolveNavTreeLabel(child),
      color_rgb: child.color_rgb ?? null,
    };
    for (const id of navAccountIdSet(child)) {
      accountIdToKey.set(id, key);
    }
  });

  // `chart_inactive` accounts are omitted from the nav tree but kept in group valuation TS.
  if (listRows?.length) {
    for (const row of listRows) {
      if (row.chart_inactive !== true) continue;
      const bucketSlug = row.bucket_slug?.trim();
      if (!bucketSlug || accountIdToKey.has(row.id)) continue;
      const bucketKey = chartBucketKeyForAccountAssetSlug(bucketSlug, bucketNodes);
      if (bucketKey) accountIdToKey.set(row.id, bucketKey);
    }
  }

  return {
    orderedKeys,
    meta,
    idToBucket: (id) => accountIdToKey.get(id) ?? null,
  };
}
