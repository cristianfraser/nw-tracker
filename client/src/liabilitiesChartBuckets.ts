import { navAccountIdSet } from "./portfolioNavDashboardCards";
import { stripChartBucketNavNodes } from "./navChartBuckets";
import { resolveNavTreeLabel } from "./sidebarNavFromApi";
import type { NavTreeNodeDto } from "./types";

export type LiabilitiesChartBucketMeta = {
  key: string;
  accountId: number;
  dataKey: string;
  depKey: string;
  barDataKey: string;
  name: string;
};

function syntheticAccountId(index: number): number {
  return -810 - index;
}

/** Nav nodes that should each become one chart series (child groups or cards). */
export function liabilitiesChartBucketNavNodes(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  return stripChartBucketNavNodes(navNode);
}

export function isLiabilitiesNavPage(navNode: NavTreeNodeDto): boolean {
  return (
    navNode.asset_group_slug === "liabilities" ||
    navNode.slug.startsWith("liabilities_") ||
    navNode.asset_group_slug === "credit_cards" ||
    navNode.slug === "santander"
  );
}

export function shouldAggregateLiabilitiesCharts(navNode: NavTreeNodeDto): boolean {
  if (!isLiabilitiesNavPage(navNode)) return false;
  return liabilitiesChartBucketNavNodes(navNode).length >= 2;
}

export function buildLiabilitiesBucketPlan(navNode: NavTreeNodeDto): {
  orderedKeys: readonly string[];
  meta: Record<string, LiabilitiesChartBucketMeta>;
  idToBucket: (accountId: number) => string | null;
} {
  const bucketNodes = liabilitiesChartBucketNavNodes(navNode);
  const orderedKeys: string[] = [];
  const meta: Record<string, LiabilitiesChartBucketMeta> = {};
  const accountIdToKey = new Map<number, string>();

  bucketNodes.forEach((child, index) => {
    const key = child.slug;
    const accountId = syntheticAccountId(index);
    const safe = key.replace(/[^a-z0-9]/gi, "_");
    const dataKey = `liab_${safe}`;
    orderedKeys.push(key);
    meta[key] = {
      key,
      accountId,
      dataKey,
      depKey: `${dataKey}_dep`,
      barDataKey: `pl_${dataKey}`,
      name: resolveNavTreeLabel(child),
    };
    for (const id of navAccountIdSet(child)) {
      accountIdToKey.set(id, key);
    }
  });

  return {
    orderedKeys,
    meta,
    idToBucket: (id) => accountIdToKey.get(id) ?? null,
  };
}
