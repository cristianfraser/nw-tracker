import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys";

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
    { queryKey: queryKeys.flowsExpensesSpentLinesAll() },
    { queryKey: queryKeys.latestMovementsAll() },
  ],
  /**
   * A big group on a line: the rows, the spent views (chart filter, usage), the summary (the
   * active groups, the chart's default exclusion), «Últimos gastos».
   */
  expenseBigGroups: (): Invalidation[] => [
    { queryKey: queryKeys.flowsExpensesSpentAll() },
    { queryKey: queryKeys.flowsExpensesLinesAll() },
    { queryKey: queryKeys.flowsExpensesSummaryAll() },
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
  /**
   * One account's page bundles in every unit (a unit the page is not showing must not keep an
   * older copy to step back to), and the blocks fetched apart: the
   * prepaid-vs-invested ones of every mortgage, since a property and its mortgage share one
   * ledger and a payment is written or edited from either page, and the pages that read every
   * loan's or card's page: the mortgage group, the card lanes (credit-card group and Liabilities)
   * and the Liabilities page.
   */
  accountPage: (accountId: string | number): Invalidation[] => [
    { queryKey: queryKeys.accountDetailAll(String(accountId)) },
    { queryKey: queryKeys.deptoPrepaymentsAll() },
    { queryKey: queryKeys.mortgageGroupGlanceAll() },
    { queryKey: queryKeys.realEstateGroupGlanceAll() },
    { queryKey: queryKeys.liabilitiesGlanceAll() },
    { queryKey: queryKeys.portfolioGroupCcLanesAll() },
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
    { queryKey: queryKeys.mortgageGroupGlanceAll() },
    { queryKey: queryKeys.realEstateGroupGlanceAll() },
    { queryKey: queryKeys.liabilitiesGlanceAll() },
    { queryKey: queryKeys.portfolioGroupCcLanesAll() },
    { queryKey: queryKeys.accountDetailAll() },
    { queryKey: queryKeys.accountMonthlyPerformanceAll() },
  ],
  dashboard: (): Invalidation[] => [{ queryKey: queryKeys.dashboardAll() }],
  /** The home bundle and the nav contexts, every display unit (what an account write moves there). */
  dashboardAndNav: (): Invalidation[] => [
    { queryKey: queryKeys.dashboardAll() },
    { queryKey: queryKeys.dashboardNavAll() },
  ],
  /** Movements written from an account page's form: its bundles, every flows list, the dashboard (every unit). */
  accountMovements: (accountId: string | number): Invalidation[] => [
    { queryKey: queryKeys.accountDetailAll(String(accountId)) },
    { queryKey: queryKeys.accountFlowsAll() },
    // A movement on a loan's or a card's page moves the mortgage group and Liabilities pages.
    { queryKey: queryKeys.mortgageGroupGlanceAll() },
    { queryKey: queryKeys.realEstateGroupGlanceAll() },
    { queryKey: queryKeys.liabilitiesGlanceAll() },
    { queryKey: queryKeys.deptoPrepaymentsAll() },
    { queryKey: queryKeys.dashboardAll() },
    { queryKey: queryKeys.dashboardNavAll() },
  ],
  /** The account lists: sidebar tree, the panel's tree, the accounts list. */
  accountLists: (): Invalidation[] => [
    { queryKey: queryKeys.sidebarNav() },
    { queryKey: queryKeys.panelNetWorthTree() },
    { queryKey: queryKeys.accountsAll() },
  ],
  /** An account created, renamed, moved, deleted or excluded from totals in the panel. */
  panelAccounts: (): Invalidation[] => [
    { queryKey: queryKeys.accountsAll() },
    { queryKey: queryKeys.panelNetWorthTree() },
    { queryKey: queryKeys.sidebarNav() },
    { queryKey: queryKeys.dashboardAll() },
  ],
  /** A buy / sell rate saved from the rates page: its review list and everything the page draws. */
  ratesPage: (): Invalidation[] => [
    { queryKey: queryKeys.marketSeriesAll() },
    { queryKey: queryKeys.ratesGlanceAll() },
    { queryKey: queryKeys.fxBidAskGaps() },
  ],
  /** The watchlist page and the marquee built from it. */
  watchlist: (): Invalidation[] => [
    { queryKey: queryKeys.watchlistAll() },
    { queryKey: queryKeys.marketTickerAll() },
  ],
  jobQueue: (): Invalidation[] => [{ queryKey: queryKeys.jobQueue() }],
  ingestRuns: (): Invalidation[] => [{ queryKey: queryKeys.ingestRunsStatus() }],
  genericUniqueMerchants: (): Invalidation[] => [{ queryKey: queryKeys.genericUniqueMerchants() }],
  messagesUnread: (): Invalidation[] => [{ queryKey: queryKeys.messagesUnread() }],
  /** Every query (the empty key is a prefix of all): a write that rewrites movements, a finished ingest run. */
  everything: (): Invalidation[] => [{ queryKey: [] }],
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
