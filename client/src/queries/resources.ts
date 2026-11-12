import type { QueryClient } from "@tanstack/react-query";
import { queryKeys, type DisplayUnit } from "./keys";

/** One invalidation: a key (a prefix unless `exact`). */
export type Invalidation = { queryKey: readonly unknown[]; exact?: boolean };

/**
 * What a write touches, by resource (docs/untangle-plan.md F12): each mutation declares the
 * resources it changes and every query reading one refetches — the lists are written once, here,
 * so two edits of the same kind cannot invalidate differently (bug 13: the manual expense and
 * pieces edits skipped «Últimos gastos»).
 */
export const resources = {
  /** The expense lines and everything built from them: gastos views, flows overview, «Últimos gastos». */
  expenseLines: (): Invalidation[] => [
    { queryKey: queryKeys.flowsExpenses() },
    { queryKey: queryKeys.latestMovementsAll() },
  ],
  /** The lines' rows only (names, labels): the gastos views and the overview do not move. */
  expenseLineRows: (): Invalidation[] => [
    { queryKey: queryKeys.flowsExpensesLinesAll() },
    { queryKey: queryKeys.latestMovementsAll() },
  ],
  /** A big group on a line: the rows, the gastos views (chart filter, usage), «Últimos gastos». */
  expenseBigGroups: (): Invalidation[] => [
    { queryKey: queryKeys.flowsExpensesGastosAll() },
    { queryKey: queryKeys.flowsExpensesLinesAll() },
    { queryKey: queryKeys.latestMovementsAll() },
  ],
  /** The big-group catalog (labels) on the Expenses page. */
  expenseBigGroupCatalog: (): Invalidation[] => [{ queryKey: queryKeys.flowsExpenses() }],
  expenseLinePieces: (): Invalidation[] => [{ queryKey: queryKeys.expenseLinePiecesAll() }],
  deposits: (): Invalidation[] => [{ queryKey: queryKeys.flowsDeposits() }],
  income: (): Invalidation[] => [{ queryKey: queryKeys.income() }],
  /** Every año tributario's draft (a rent mark or a place's DFL-2 flag moves its codes). */
  taxReturn: (): Invalidation[] => [{ queryKey: queryKeys.taxReturnAll() }],
  /** A declared residency period: the list, and every año tributario's regime. */
  taxResidency: (): Invalidation[] => [{ queryKey: queryKeys.taxResidency() }, { queryKey: queryKeys.taxReturnAll() }],
  /** One account's page bundle (monthly) in a unit. */
  accountPage: (accountId: string | number, unit: DisplayUnit): Invalidation[] => [
    { queryKey: queryKeys.accountDetail(String(accountId), unit, "monthly") },
  ],
  accountFlows: (): Invalidation[] => [{ queryKey: queryKeys.accountFlowsAll() }],
  accountValuations: (accountId: number | string): Invalidation[] => [
    { queryKey: queryKeys.accountValuations(accountId) },
  ],
  realEstateExpenses: (): Invalidation[] => [{ queryKey: queryKeys.flowsRealEstateExpenses() }],
  realEstateCandidates: (): Invalidation[] => [
    { queryKey: queryKeys.realEstateUnlinkedPurchasesAll() },
    { queryKey: queryKeys.realEstateLinkCandidatesAll() },
  ],
  realEstateLinkCandidates: (): Invalidation[] => [{ queryKey: queryKeys.realEstateLinkCandidatesAll() }],
  financingLinks: (): Invalidation[] => [{ queryKey: queryKeys.ccFacturadoFinancingLinks() }],
  sidebarNav: (): Invalidation[] => [{ queryKey: queryKeys.sidebarNav() }],
  movementMirrors: (): Invalidation[] => [{ queryKey: queryKeys.movementMirrorCandidates() }],
  /** Every surface that draws an entity's colour (bundles, group pages, account pages). */
  entityColors: (): Invalidation[] => [
    { queryKey: queryKeys.dashboardAll() },
    { queryKey: queryKeys.portfolioGroupAll() },
    { queryKey: queryKeys.accountDetailAll() },
    { queryKey: queryKeys.accountMonthlyPerformanceAll() },
  ],
  dashboard: (): Invalidation[] => [{ queryKey: queryKeys.dashboardAll() }],
};

/** Invalidates what the resources name (each key once). */
export function invalidateResources(queryClient: QueryClient, ...groups: Invalidation[][]): Promise<void> {
  const seen = new Set<string>();
  const done: Promise<void>[] = [];
  for (const inv of groups.flat()) {
    const id = `${JSON.stringify(inv.queryKey)}|${inv.exact === true}`;
    if (seen.has(id)) continue;
    seen.add(id);
    done.push(queryClient.invalidateQueries({ queryKey: inv.queryKey, exact: inv.exact }));
  }
  return Promise.all(done).then(() => undefined);
}
