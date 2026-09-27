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

/** Σ `current_value_usd` of a nav subtree's rows (undefined when no row has one). */
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

export function sumDashboardRowsUsdForNavGroup(
  netWorthRoot: NavTreeNodeDto | null | undefined,
  portfolioGroupSlug: string,
  accounts: DashboardAccountRow[]
): number | undefined {
  const node = findPortfolioGroupInNav(netWorthRoot, portfolioGroupSlug);
  if (!node) return undefined;
  return sumDashboardRowsUsdForNavNode(node, accounts);
}

/**
 * Ahorros y reservas USD total for a CLP payload shown in USD (`dashPickForNavStrip`'s
 * CLP→USD placeholder), mirroring the server's `cashNetOfLinkedCreditCards`: the linked card
 * balance (the `linked_balances` footer) is subtracted signed — a total in credit adds.
 */
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
  return raw - linkedCreditCardBalanceUsd;
}
