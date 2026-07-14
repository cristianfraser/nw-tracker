import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import type { NavTreeNodeDto } from "./types";

/**
 * Nav nodes that each become one chart series in "Agrupado" mode. The chart series themselves are
 * now aggregated server-side (see server/src/groupChartBuckets.ts); this client copy is retained
 * only for non-chart consumers (nav card breakdown coverage / counts).
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
