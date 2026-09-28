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
/**
 * A node's first-level children when it holds accounts beside sub-buckets (Acciones: its stocks
 * and the Portafolio IPSA unit) — each one bucket; `null` when it holds only one kind. Mirrors
 * the server's `mixedChartChildren` (the server also orders them by balance; consumers here
 * sort by value themselves).
 */
export function mixedNavChildren(navNode: NavTreeNodeDto): NavTreeNodeDto[] | null {
  const groupKids = portfolioStripGroupChildren(navNode);
  const accountKids = portfolioStripAccountChildren(navNode);
  if (groupKids.length === 0 || accountKids.length === 0) return null;
  return [...groupKids, ...accountKids];
}

export function stripChartBucketNavNodes(navNode: NavTreeNodeDto): NavTreeNodeDto[] {
  const mixed = mixedNavChildren(navNode);
  if (mixed) return mixed;
  const groupKids = portfolioStripGroupChildren(navNode);
  const accountKids = portfolioStripAccountChildren(navNode);

  if (groupKids.length >= 2) return groupKids;

  if (groupKids.length === 1) {
    const sole = groupKids[0]!;
    const soleMixed = mixedNavChildren(sole);
    if (soleMixed) return soleMixed;
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
