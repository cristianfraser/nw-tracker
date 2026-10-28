export type DisplayUnit = "clp" | "usd";

/** The unit a page was showing before a switch — the one keep-previous data belongs to. */
export function otherDisplayUnit(unit: DisplayUnit): DisplayUnit {
  return unit === "usd" ? "clp" : "usd";
}

export const queryKeys = {
  dashboard: (unit: DisplayUnit) => ["dashboard", unit] as const,
  dashboardNav: (unit: DisplayUnit) => ["dashboardNav", unit] as const,
  dashboardNavSnapshot: (unit: DisplayUnit) => ["dashboardNavSnapshot", unit] as const,
  dashboardOverview: (unit: DisplayUnit) => ["dashboardOverview", unit] as const,
  dashboardOverviewDaily: (unit: DisplayUnit, days: number) =>
    ["dashboardOverviewDaily", unit, days] as const,
  dailySeries: (scope: string, unit: DisplayUnit, days: number) =>
    ["dailySeries", scope, unit, days] as const,
  groupConsolidatedTables: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    ["groupConsolidatedTables", group, subgroup ?? null, unit] as const,
  groupPeriodReturns: (group: string, unit: DisplayUnit) =>
    ["groupPeriodReturns", group, unit] as const,
  latestExpenses: (unit: DisplayUnit, limit: number) => ["latestExpenses", unit, limit] as const,
  groupConsolidatedMonthlyPage: (
    group: string,
    unit: DisplayUnit,
    period: "month" | "year",
    page: number
  ) => ["groupConsolidatedMonthlyPage", group, unit, period, page] as const,
  sidebarNav: () => ["sidebarNav"] as const,
  panelNetWorthTree: () => ["panelNetWorthTree"] as const,
  accountsAll: () => ["accountsAll"] as const,
  accountsByPortfolioGroup: (portfolioGroup: string, unit: DisplayUnit) =>
    ["accounts", "portfolioGroup", portfolioGroup, unit] as const,
  ratesInstruments: () => ["ratesInstruments"] as const,
  /** Prefix keys (no unit) invalidate every unit's copy at once. */
  marketTickerAll: () => ["marketTicker"] as const,
  marketTicker: (unit: DisplayUnit) => ["marketTicker", unit] as const,
  watchlistAll: () => ["watchlist"] as const,
  watchlist: (unit: DisplayUnit) => ["watchlist", unit] as const,
  watchlistSymbolSearch: (q: string) => ["watchlist-symbol-search", q] as const,
  marketSeries: () => ["marketSeries"] as const,
  mortgageUfReminder: () => ["mortgageUfReminder"] as const,
  messagesUnread: () => ["messages", "unreadCount"] as const,
  messages: (kind: "notification" | "log") => ["messages", kind] as const,
  syncStatus: () => ["syncStatus"] as const,
  liveQuotesStamp: () => ["liveQuotesStamp"] as const,
  importSyncDocumentCoverage: () => ["importSyncDocumentCoverage"] as const,
  genericUniqueMerchants: () => ["genericUniqueMerchants"] as const,
  /** Bare `income()` is the prefix every income invalidation uses. */
  income: (unit?: DisplayUnit) => (unit ? (["income", unit] as const) : (["income"] as const)),
  flowsDeposits: () => ["flowsDeposits"] as const,
  flowsPl: (days?: number) => ["flowsPl", days ?? null] as const,
  flowsDepositsReconciliation: () => ["flowsDepositsReconciliation"] as const,
  flowsRealEstateExpenses: () => ["flowsRealEstateExpenses"] as const,
  realEstateLinkCandidates: (expenseEntryId: number) =>
    ["realEstateLinkCandidates", expenseEntryId] as const,
  realEstateUnlinkedPurchases: (params: Record<string, string>) =>
    ["realEstateUnlinkedPurchases", params] as const,
  realEstatePropertyAccounts: () => ["realEstatePropertyAccounts"] as const,
  flowsExpenses: () => ["flowsExpenses"] as const,
  /** Nested under `flowsExpenses()`: every invalidation of the lines refetches the gastos views too. */
  flowsExpensesGastosAll: () => ["flowsExpenses", "gastos"] as const,
  flowsExpensesGastos: (unit: DisplayUnit, excludedBigGroups: readonly string[]) =>
    ["flowsExpenses", "gastos", unit, [...excludedBigGroups].sort().join(",")] as const,
  /** Nested under `flowsExpenses()` too: a line edit refetches the overview. Entity = up to the unit. */
  flowsOverview: (unit: DisplayUnit, installmentMode: "split" | "total", days?: number) =>
    ["flowsExpenses", "overview", unit, installmentMode, days ?? null] as const,
  creditCardConfig: (accountId: string) => ["creditCardConfig", accountId] as const,
  ccFacturadoFinancingLinks: () => ["ccFacturadoFinancingLinks"] as const,
  portfolioGroup: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    ["portfolioGroup", group, subgroup ?? null, unit] as const,
  groupPageShell: (portfolioGroup: string, unit: DisplayUnit) =>
    ["groupPageShell", portfolioGroup, unit] as const,
  accountDetail: (id: string, unit: DisplayUnit, granularity: "monthly" | "daily") =>
    ["accountDetail", id, unit, granularity] as const,
  accountMonthlyPerformance: (id: string, unit: DisplayUnit) =>
    ["accountMonthlyPerformance", id, unit] as const,
  portfolioGroupCcLedger: (slug: string) => ["portfolioGroupCcLedger", slug] as const,
  portfolioGroupMortgageLedger: (slug: string) => ["portfolioGroupMortgageLedger", slug] as const,
  groupFlows: (slug: string, filtersKey: string) => ["groupFlows", slug, filtersKey] as const,
  accountFlows: (id: string, filtersKey: string) => ["accountFlows", id, filtersKey] as const,
  movementMirrorCandidates: () => ["movementMirrorCandidates"] as const,
  projections: (unit: string, overridesKey: string) => ["projections", unit, overridesKey] as const,
  wealthPercentile: () => ["wealth-percentile"] as const,
  benchmarks: () => ["benchmarks"] as const,
  mortgagePrepaymentComparison: (accountId: number, benchmark: string, unit: DisplayUnit) =>
    ["mortgagePrepaymentComparison", accountId, benchmark, unit] as const,
  benchmarkComparison: (scope: string, benchmark: string, unit: DisplayUnit) =>
    ["benchmarkComparison", scope, benchmark, unit] as const,
  taxReturn: (taxYear: number | null) => ["tax-return", taxYear] as const,
};
