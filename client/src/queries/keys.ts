export type DisplayUnit = "clp" | "usd";

export const queryKeys = {
  dashboard: (unit: DisplayUnit) => ["dashboard", unit] as const,
  dashboardNav: (unit: DisplayUnit) => ["dashboardNav", unit] as const,
  dashboardNavSnapshot: (unit: DisplayUnit) => ["dashboardNavSnapshot", unit] as const,
  dashboardOverview: (unit: DisplayUnit) => ["dashboardOverview", unit] as const,
  groupConsolidatedTables: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    ["groupConsolidatedTables", group, subgroup ?? null, unit] as const,
  sidebarNav: () => ["sidebarNav"] as const,
  accountsAll: () => ["accountsAll"] as const,
  accountsByPortfolioGroup: (portfolioGroup: string, unit: DisplayUnit) =>
    ["accounts", "portfolioGroup", portfolioGroup, unit] as const,
  assetTree: () => ["assetTree"] as const,
  portfolioTree: () => ["portfolioTree"] as const,
  ratesInstruments: () => ["ratesInstruments"] as const,
  marketTicker: () => ["marketTicker"] as const,
  marketSeries: () => ["marketSeries"] as const,
  fxCoverage: () => ["fxCoverage"] as const,
  messagesUnread: () => ["messages", "unreadCount"] as const,
  messages: (kind: "notification" | "log") => ["messages", kind] as const,
  syncStatus: () => ["syncStatus"] as const,
  importSyncDocumentCoverage: () => ["importSyncDocumentCoverage"] as const,
  genericUniqueMerchants: () => ["genericUniqueMerchants"] as const,
  income: () => ["income"] as const,
  flowsDeposits: () => ["flowsDeposits"] as const,
  flowsExpenses: () => ["flowsExpenses"] as const,
  flowsRealEstateExpenses: () => ["flowsRealEstateExpenses"] as const,
  realEstateLinkCandidates: (expenseEntryId: number) =>
    ["realEstateLinkCandidates", expenseEntryId] as const,
  flowsCreditCardExpenses: () => ["flowsCreditCardExpenses"] as const,
  portfolioGroup: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    ["portfolioGroup", group, subgroup ?? null, unit] as const,
  groupPageShell: (portfolioGroup: string, unit: DisplayUnit) =>
    ["groupPageShell", portfolioGroup, unit] as const,
  accountDetail: (
    id: string,
    unit: DisplayUnit,
    granularity: "monthly" | "daily",
    ccOffsetsKey: string
  ) => ["accountDetail", id, unit, granularity, ccOffsetsKey] as const,
  accountMonthlyPerformance: (id: string, unit: DisplayUnit) =>
    ["accountMonthlyPerformance", id, unit] as const,
  accountMovements: (id: number) => ["accountMovements", id] as const,
};
