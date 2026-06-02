import { navAccountIdSet } from "./portfolioNavDashboardCards";
import type { DashboardAccountRow, NavTreeNodeDto } from "./types";

/** Find a portfolio group node by slug under `netWorth` (depth-first). */
export function findPortfolioGroupInNav(
  root: NavTreeNodeDto | null | undefined,
  slug: string
): NavTreeNodeDto | null {
  if (!root) return null;
  if (root.slug === slug) return root;
  for (const c of root.children ?? []) {
    const hit = findPortfolioGroupInNav(c, slug);
    if (hit) return hit;
  }
  return null;
}

/** Sum dashboard account rows for any nav subtree (`navAccountIdSet`). */
export function sumDashboardRowsForNavNode(
  navNode: NavTreeNodeDto,
  accounts: DashboardAccountRow[]
): number {
  const ids = navAccountIdSet(navNode);
  let clp = 0;
  for (const a of accounts) {
    if (!ids.has(a.account_id)) continue;
    if (a.exclude_from_group_totals === 1) continue;
    if (a.current_value_clp == null || !Number.isFinite(a.current_value_clp)) continue;
    clp += a.current_value_clp;
  }
  return clp;
}

/** Sum dashboard account rows for a portfolio group subtree (same model as server tree rollup). */
export function sumDashboardRowsForNavGroup(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  portfolioGroupSlug: string,
  accounts: DashboardAccountRow[]
): number {
  const node = findPortfolioGroupInNav(netWorthRoot, portfolioGroupSlug);
  if (!node) return 0;
  return sumDashboardRowsForNavNode(node, accounts);
}

/** Ahorros y reservas NW total aligned with server `sumCashSavingsNwAdjusted`. */
export function sumCashSavingsAdjustedForNav(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  accounts: DashboardAccountRow[],
  linkedCreditCardBalanceClp: number
): number {
  const raw = sumDashboardRowsForNavGroup(netWorthRoot, "cash_savings", accounts);
  const cc = Math.round(linkedCreditCardBalanceClp);
  return cc > 0 ? raw - cc : raw;
}
