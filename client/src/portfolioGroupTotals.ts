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

/** USD counterpart for nav-strip totals (null when no row has `current_value_usd`). */
export function sumDashboardRowsUsdForNavNode(
  navNode: NavTreeNodeDto,
  accounts: DashboardAccountRow[]
): number | undefined {
  const ids = navAccountIdSet(navNode);
  let usd = 0;
  let anyUsd = false;
  for (const a of accounts) {
    if (!ids.has(a.account_id)) continue;
    if (a.exclude_from_group_totals === 1) continue;
    if (a.current_value_usd != null && Number.isFinite(a.current_value_usd)) {
      usd += a.current_value_usd;
      anyUsd = true;
    }
  }
  return anyUsd ? usd : undefined;
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

export function sumDashboardRowsUsdForNavGroup(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  portfolioGroupSlug: string,
  accounts: DashboardAccountRow[]
): number | undefined {
  const node = findPortfolioGroupInNav(netWorthRoot, portfolioGroupSlug);
  if (!node) return undefined;
  return sumDashboardRowsUsdForNavNode(node, accounts);
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

export function sumCashSavingsAdjustedUsdForNav(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  accounts: DashboardAccountRow[],
  linkedCreditCardBalanceUsd: number | null | undefined
): number | undefined {
  const raw = sumDashboardRowsUsdForNavGroup(netWorthRoot, "cash_savings", accounts);
  if (raw === undefined) return undefined;
  if (linkedCreditCardBalanceUsd == null || !Number.isFinite(linkedCreditCardBalanceUsd)) {
    return raw;
  }
  const cc = Math.round(linkedCreditCardBalanceUsd);
  return cc > 0 ? raw - cc : raw;
}
