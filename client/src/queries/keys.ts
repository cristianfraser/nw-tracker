export type DisplayUnit = "clp" | "usd";

export const queryKeys = {
  dashboard: (unit: DisplayUnit) => ["dashboard", unit] as const,
  sidebarNav: () => ["sidebarNav"] as const,
  ratesInstruments: () => ["ratesInstruments"] as const,
  marketTicker: () => ["marketTicker"] as const,
  marketSeries: () => ["marketSeries"] as const,
  messagesUnread: () => ["messages", "unreadCount"] as const,
  messages: (kind: "notification" | "log") => ["messages", kind] as const,
  syncStatus: () => ["syncStatus"] as const,
  income: () => ["income"] as const,
  flowsDeposits: () => ["flowsDeposits"] as const,
  flowsExpenses: () => ["flowsExpenses"] as const,
  portfolioGroup: (group: string, subgroup: string | undefined, unit: DisplayUnit) =>
    ["portfolioGroup", group, subgroup ?? null, unit] as const,
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
