export type DisplayUnit = "clp" | "usd";

/** The unit a page was showing before a switch — the one keep-previous data belongs to. */
export function otherDisplayUnit(unit: DisplayUnit): DisplayUnit {
  return unit === "usd" ? "clp" : "usd";
}

const ENTITY = Symbol("entityKeyLength");

/**
 * A display-unit query key with its entity length: how many leading elements name the entity
 * (group, account, scope) — previous data is held across a change of the rest (unit, period,
 * page, filter), never across entities ({@link entityKeyLength}). Declared once, with the key.
 */
function withEntity<K extends readonly unknown[]>(key: K, entityLength: number): K {
  Object.defineProperty(key, ENTITY, { value: entityLength, enumerable: false });
  return key;
}

/** The entity length a key was declared with; a key without one is not a display-unit query. */
export function entityKeyLength(key: readonly unknown[]): number {
  const n = (key as unknown as Record<symbol, unknown>)[ENTITY];
  if (typeof n !== "number") throw new Error(`query key ${JSON.stringify(key)} declares no entity length`);
  return n;
}

export const queryKeys = {
  dashboard: (unit: DisplayUnit) =>
    withEntity(["dashboard", unit] as const, 1),
  /** Without `root`, the prefix of every page's nav-context in that unit (for invalidation). */
  dashboardNav: (unit: DisplayUnit, root?: string) =>
    withEntity((root == null ? ["dashboardNav", unit] : ["dashboardNav", unit, root]) as readonly unknown[], 3),
  dashboardNavSnapshot: (unit: DisplayUnit) =>
    withEntity(["dashboardNavSnapshot", unit] as const, 2),
  dashboardOverview: (unit: DisplayUnit) => ["dashboardOverview", unit] as const,
  dashboardOverviewDaily: (unit: DisplayUnit, days: number) =>
    withEntity(["dashboardOverviewDaily", unit, days] as const, 1),
  inversionesPerfDaily: (unit: DisplayUnit, days: number) =>
    withEntity(["inversionesPerfDaily", unit, days] as const, 1),
  /** `variant` "perf" carries the day-mode P/L levels (`perf_levels`); a separate entity, so
   * neither variant is ever held as the other's placeholder. */
  dailySeries: (scope: string, variant: "base" | "perf", unit: DisplayUnit, days: number) =>
    withEntity(["dailySeries", scope, variant, unit, days] as const, 3),
  groupConsolidatedTables: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    withEntity(["groupConsolidatedTables", group, subgroup ?? null, unit] as const, 2),
  groupPeriodReturns: (group: string, unit: DisplayUnit) =>
    withEntity(["groupPeriodReturns", group, unit] as const, 2),
  latestMovements: (limit: number) => ["latestMovements", limit] as const,
  latestMovementsAll: () => ["latestMovements"] as const,
  groupConsolidatedMonthlyPage: (
    group: string,
    unit: DisplayUnit,
    period: "month" | "year",
    page: number,
    installmentMode: "split" | "total"
  ) =>
    withEntity(["groupConsolidatedMonthlyPage", group, unit, period, page, installmentMode] as const, 2),
  sidebarNav: () => ["sidebarNav"] as const,
  panelNetWorthTree: () => ["panelNetWorthTree"] as const,
  accountsAll: () => ["accountsAll"] as const,
  accountsByPortfolioGroup: (portfolioGroup: string, unit: DisplayUnit) =>
    withEntity(["accounts", "portfolioGroup", portfolioGroup, unit] as const, 3),
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
  usageReport: (days: number) => ["usage", "report", days] as const,
  usageEndpointTrend: (key: string, days: number) => ["usage", "trend", key, days] as const,
  syncStatus: () => ["syncStatus"] as const,
  ingestRunsStatus: () => ["ingestRunsStatus"] as const,
  jobQueue: () => ["jobQueue"] as const,
  liveQuotesStamp: () => ["liveQuotesStamp"] as const,
  importSyncDocumentCoverage: () => ["importSyncDocumentCoverage"] as const,
  genericUniqueMerchants: () => ["genericUniqueMerchants"] as const,
  /** Bare `income()` is the prefix every income invalidation uses. */
  income: (unit?: DisplayUnit) => (unit ? (["income", unit] as const) : (["income"] as const)),
  /** Under `income()`, so every income invalidation reaches it. */
  incomeRentPlaces: () => ["income", "rentPlaces"] as const,
  flowsDeposits: () => ["flowsDeposits"] as const,
  flowsPl: (days?: number) => ["flowsPl", days ?? null] as const,
  flowsDepositsReconciliation: () => ["flowsDepositsReconciliation"] as const,
  flowsRealEstateExpenses: () => ["flowsRealEstateExpenses"] as const,
  /** Prefix of every link-candidates list. */
  realEstateLinkCandidatesAll: () => ["realEstateLinkCandidates"] as const,
  realEstateLinkCandidates: (expenseEntryId: number) =>
    ["realEstateLinkCandidates", expenseEntryId] as const,
  realEstateUnlinkedPurchasesAll: () => ["realEstateUnlinkedPurchases"] as const,
  realEstateUnlinkedPurchases: (params: Record<string, string>) =>
    ["realEstateUnlinkedPurchases", params] as const,
  realEstatePropertyAccounts: () => ["realEstatePropertyAccounts"] as const,
  flowsExpenses: () => ["flowsExpenses"] as const,
  /** Nested under `flowsExpenses()`: every invalidation of the lines refetches the gastos views too. */
  flowsExpensesGastosAll: () => ["flowsExpenses", "gastos"] as const,
  flowsExpensesGastos: (unit: DisplayUnit, excludedBigGroups: readonly string[], includePreTax: boolean) =>
    ["flowsExpenses", "gastos", unit, [...excludedBigGroups].sort().join(","), includePreTax] as const,
  /** Nested under `flowsExpenses()` too: a line edit refetches the overview. Entity = up to the unit. */
  flowsOverview: (unit: DisplayUnit, installmentMode: "split" | "total", days?: number) =>
    withEntity(["flowsExpenses", "overview", unit, installmentMode, days ?? null] as const, 3),
  creditCardConfig: (accountId: string) => ["creditCardConfig", accountId] as const,
  ccFacturadoFinancingLinks: () => ["ccFacturadoFinancingLinks"] as const,
  portfolioGroup: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    withEntity(["portfolioGroup", group, subgroup ?? null, unit] as const, 2),
  groupPageShell: (portfolioGroup: string, unit: DisplayUnit) =>
    withEntity(["groupPageShell", portfolioGroup, unit] as const, 2),
  /** Prefix: every account page bundle (without `id`), or one account's in every unit. */
  accountDetailAll: (id?: string) => (id == null ? ["accountDetail"] : ["accountDetail", id]) as readonly unknown[],
  accountDetail: (id: string, unit: DisplayUnit, granularity: "monthly" | "daily") =>
    withEntity(["accountDetail", id, unit, granularity] as const, 2),
  accountMonthlyPerformance: (id: string, unit: DisplayUnit) =>
    withEntity(["accountMonthlyPerformance", id, unit] as const, 2),
  portfolioGroupCcLedger: (slug: string) =>
    withEntity(["portfolioGroupCcLedger", slug] as const, 2),
  /** One loan's ledger on a mortgage group page (`loanAccountId` null: the group's one loan). */
  portfolioGroupMortgageLedger: (slug: string, loanAccountId: number | null) =>
    withEntity(["portfolioGroupMortgageLedger", slug, loanAccountId] as const, 3),
  groupFlows: (slug: string, filtersKey: string) =>
    withEntity(["groupFlows", slug, filtersKey] as const, 2),
  accountFlowsAll: () => ["accountFlows"] as const,
  accountFlows: (id: string, filtersKey: string) =>
    withEntity(["accountFlows", id, filtersKey] as const, 2),
  movementMirrorCandidates: () => ["movementMirrorCandidates"] as const,
  projections: (unit: string, overridesKey: string) => ["projections", unit, overridesKey] as const,
  wealthPercentile: () => ["wealth-percentile"] as const,
  benchmarks: () => ["benchmarks"] as const,
  mortgagePrepaymentComparison: (accountId: number, benchmark: string, unit: DisplayUnit) =>
    ["mortgagePrepaymentComparison", accountId, benchmark, unit] as const,
  benchmarkComparison: (scope: string, benchmark: string, unit: DisplayUnit) =>
    ["benchmarkComparison", scope, benchmark, unit] as const,
  taxReturn: (taxYear: number | null) => ["tax-return", taxYear] as const,
  taxReturnAll: () => ["tax-return"] as const,
  taxResidency: () => ["tax-residency"] as const,
  usTaxReturn: (taxYear: number | null) => ["tax-return", "us", taxYear] as const,
  dashboardAll: () => ["dashboard"] as const,
  portfolioGroupAll: () => ["portfolioGroup"] as const,
  accountMonthlyPerformanceAll: () => ["accountMonthlyPerformance"] as const,
  expenseLinePiecesAll: () => ["expenseLinePieces"] as const,
  expenseLinePieces: (source: string | null, lineId: number) => ["expenseLinePieces", source, lineId] as const,
  accountValuations: (accountId: number | string) => ["accountValuations", accountId] as const,
  accountImportSpecs: (accountId: number | string) => ["accountImportSpecs", accountId] as const,
};
