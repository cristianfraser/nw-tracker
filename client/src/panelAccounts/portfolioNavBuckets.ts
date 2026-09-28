import { navAccountIdSet } from "../portfolioNavDashboardCards";
import type { NavTreeNodeDto } from "../types";

/**
 * Portfolio groups under net worth that take accounts: no group children, or accounts already
 * beside them (Acciones: its stocks beside Portafolio IPSA). A hub of sub-buckets only never
 * links its own accounts. Same rule as the server (`resolveBucketParentAssetSlug`).
 */
export function listLeafPortfolioGroupBuckets(
  netWorthRoot: NavTreeNodeDto | null
): { slug: string; label: string; portfolio_group_id: number }[] {
  if (!netWorthRoot) return [];
  const out: { slug: string; label: string; portfolio_group_id: number }[] = [];
  const walk = (node: NavTreeNodeDto) => {
    if (node.portfolio_group_id != null && node.account_id == null) {
      const hasGroupChild = node.children.some(
        (c) => c.portfolio_group_id != null && c.account_id == null
      );
      const hasAccountChild = node.children.some((c) => c.account_id != null);
      if (!hasGroupChild || hasAccountChild) {
        out.push({
          slug: node.slug,
          label: node.label,
          portfolio_group_id: node.portfolio_group_id,
        });
      }
    }
    for (const c of node.children) walk(c);
  };
  walk(netWorthRoot);
  return out;
}

export function countAccountsInNavSubtree(node: NavTreeNodeDto): number {
  return navAccountIdSet(node).size;
}

/** Slug of the deepest portfolio group holding the account as a direct child (its current home bucket). */
export function leafBucketSlugForAccount(
  netWorthRoot: NavTreeNodeDto | null,
  accountId: number
): string | null {
  if (!netWorthRoot) return null;
  let found: string | null = null;
  const walk = (node: NavTreeNodeDto) => {
    if (node.portfolio_group_id != null && node.account_id == null) {
      if (node.children.some((c) => c.account_id === accountId)) found = node.slug;
    }
    for (const c of node.children) walk(c);
  };
  walk(netWorthRoot);
  return found;
}
