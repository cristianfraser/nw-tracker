import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "./portfolioNavFromApi";
import type { NavTreeNodeDto } from "./types";

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

/**
 * Nav nodes that each become one bucket of a group page. Chart series are aggregated server-side
 * (server/src/groupChartBuckets.ts); this copy serves non-chart consumers (nav card breakdown
 * coverage / counts).
 */
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

