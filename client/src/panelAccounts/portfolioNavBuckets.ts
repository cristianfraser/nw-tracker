import { navAccountIdSet } from "../portfolioNavDashboardCards";
import type { NavTreeNodeDto } from "../types";

/** Leaf portfolio groups that accept panel stock creates (`brokerage_acciones`, `brokerage_crypto`, …). */
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
      if (!hasGroupChild) {
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
