import type { ExpensesSpentParams, FlowsExpenseLinesSelector } from "../types";
/**
 * A display unit: a lowercase core currency code the server loads (`clp`, `usd`, `eur`, …;
 * `GET /api/currencies`). Data, not a closed union. A payload held across a switch carries its
 * own `unit` (`heldUnitPayload.ts`).
 */
export type DisplayUnit = string;

/** A string that can name a display unit (three lowercase letters); the server decides if it is loaded. */
export function isDisplayUnitCode(v: unknown): v is DisplayUnit {
  return typeof v === "string" && /^[a-z]{3}$/.test(v);
}

/** A stable key segment for an expense-lines selector (its fields in a fixed order). */
function expenseLinesSelectorKey(selector: FlowsExpenseLinesSelector): string {
  switch (selector.kind) {
    case "facturacion":
      return `facturacion|${selector.account_id}|${selector.billing_month}`;
    case "uncategorized":
    case "deposit_matched":
      return `${selector.kind}|${selector.include_pre_tax ? 1 : 0}`;
    case "big_group":
      return `big_group|${selector.slug}|${selector.include_pre_tax ? 1 : 0}`;
  }
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

/** Which surface an account's flows list belongs to (see `queryKeys.accountFlows`). */
export type AccountFlowsScope = "panel" | "cartola_month";

/** The entity length a key was declared with; a key without one is not a display-unit query. */
export function entityKeyLength(key: readonly unknown[]): number {
  const n = (key as unknown as Record<symbol, unknown>)[ENTITY];
  if (typeof n !== "number") throw new Error(`query key ${JSON.stringify(key)} declares no entity length`);
  return n;
}

export const queryKeys = {
  dashboard: (unit: DisplayUnit) =>
    withEntity(["dashboard", unit] as const, 1),
  /** One page's nav context (`root` = the page's nav node slug): held across a unit switch. */
  dashboardNav: (root: string, unit: DisplayUnit) =>
    withEntity(["dashboardNav", root, unit] as const, 2),
  /** Prefix of every page's nav context, every unit. */
  dashboardNavAll: () => ["dashboardNav"] as const,
  dashboardNavSnapshot: (unit: DisplayUnit) =>
    withEntity(["dashboardNavSnapshot", unit] as const, 2),
  dashboardOverview: (unit: DisplayUnit) => ["dashboardOverview", unit] as const,
  dashboardOverviewDaily: (unit: DisplayUnit, days: number) =>
    withEntity(["dashboardOverviewDaily", unit, days] as const, 1),
  /** `variant` "perf" carries the day-mode P/L levels (`perf_levels`); a separate entity, so
   * neither variant is ever held as the other's placeholder. */
  dailySeries: (scope: string, variant: "base" | "perf", unit: DisplayUnit, days: number) =>
    withEntity(["dailySeries", scope, variant, unit, days] as const, 3),
  groupConsolidatedTables: (group: string, unit: DisplayUnit) =>
    withEntity(["groupConsolidatedTables", group, unit] as const, 2),
  groupPeriodReturns: (group: string, unit: DisplayUnit) =>
    withEntity(["groupPeriodReturns", group, unit] as const, 2),
  latestMovements: (limit: number, unit: DisplayUnit) => withEntity(["latestMovements", limit, unit] as const, 2),
  latestMovementsAll: () => ["latestMovements"] as const,
  groupConsolidatedMonthlyPage: (
    group: string,
    unit: DisplayUnit,
    period: "month" | "year",
    page: number,
    pageSize: number,
    installmentMode: "split" | "total"
  ) =>
    withEntity(["groupConsolidatedMonthlyPage", group, unit, period, page, pageSize, installmentMode] as const, 2),
  sidebarNav: () => ["sidebarNav"] as const,
  panelNetWorthTree: () => ["panelNetWorthTree"] as const,
  accountsAll: () => ["accountsAll"] as const,
  accountsByPortfolioGroup: (portfolioGroup: string, unit: DisplayUnit) =>
    withEntity(["accounts", "portfolioGroup", portfolioGroup, unit] as const, 3),
  currencies: () => ["currencies"] as const,
  /** Prefix keys (no unit) invalidate every unit's copy at once. */
  marketTickerAll: () => ["marketTicker"] as const,
  marketTicker: (unit: DisplayUnit) => withEntity(["marketTicker", unit] as const, 1),
  watchlistAll: () => ["watchlist"] as const,
  watchlist: (unit: DisplayUnit) => withEntity(["watchlist", unit] as const, 1),
  watchlistSymbolSearch: (q: string) => ["watchlist-symbol-search", q] as const,
  /** Prefix key (no unit) invalidates every unit's copy at once. */
  marketSeriesAll: () => ["marketSeries"] as const,
  marketSeries: (unit: DisplayUnit) => withEntity(["marketSeries", unit] as const, 1),
  ratesGlanceAll: () => ["ratesGlance"] as const,
  ratesGlance: (unit: DisplayUnit) => withEntity(["ratesGlance", unit] as const, 1),
  fxBidAskGaps: () => ["fxBidAskGaps"] as const,
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
  income: () => ["income"] as const,
  /** The income page in a unit (one entity: held across a unit switch). */
  incomePage: (unit: DisplayUnit) => withEntity(["income", unit] as const, 1),
  /** Under `income()`, so every income invalidation reaches it. */
  incomeRentPlaces: () => ["income", "rentPlaces"] as const,
  /** Bare `flowsDeposits()` is the prefix every deposits invalidation uses. */
  flowsDeposits: () => ["flowsDeposits"] as const,
  /** The /flows/deposits page in a unit (one entity: held across a unit switch). */
  flowsDepositsPage: (unit: DisplayUnit) => withEntity(["flowsDeposits", unit] as const, 1),
  /** One entity: held across a unit or Diario window change. */
  flowsPl: (unit: DisplayUnit, days?: number) => withEntity(["flowsPl", unit, days ?? null] as const, 1),
  flowsDepositsReconciliation: (unit: DisplayUnit) => withEntity(["flowsDepositsReconciliation", unit] as const, 1),
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
  /**
   * One expense-lines list in a unit (each line's `converted`); a paged list (uncategorized) adds
   * `<page>/<page size>`. Nested under `flowsExpensesLinesAll()`, the prefix every optimistic line
   * patch walks. Entity = the selector («none»: no list asked for): held across a unit or page change,
   * never across lists.
   */
  flowsExpenseLines: (
    unit: DisplayUnit,
    selector: FlowsExpenseLinesSelector | null,
    page?: { page: number; pageSize: number }
  ) =>
    withEntity(
      [
        "flowsExpenses",
        "lines",
        selector ? expenseLinesSelectorKey(selector) : "none",
        unit,
        page ? `${page.page}/${page.pageSize}` : "all",
      ] as const,
      3
    ),
  flowsExpensesLinesAll: () => ["flowsExpenses", "lines"] as const,
  /** The Expenses page's catalogs and summaries (categories, big groups, additional cards). */
  flowsExpensesSummaryAll: () => ["flowsExpenses", "summary"] as const,
  flowsExpensesSummary: (unit: DisplayUnit) => withEntity(["flowsExpenses", "summary", unit] as const, 2),
  /** The purchases one card credit may refund (under `flowsExpenses()`: a line write refetches it). */
  cardRefundCandidates: (unit: DisplayUnit, accountId: number, lineId: number) =>
    withEntity(["flowsExpenses", "refundCandidates", accountId, lineId, unit] as const, 4),
  /** The financing manager's pickers; under `flowsExpenses()`, so every line write refreshes them. */
  flowsExpensesFinancingCandidates: (unit: DisplayUnit) =>
    withEntity(["flowsExpenses", "financingCandidates", unit] as const, 2),
  /**
   * The Expenses page by spending day, both payloads (the page's and its line lists); under
   * `flowsExpenses()`, so every line write refetches it.
   */
  flowsExpensesSpentAll: () => ["flowsExpenses", "spent"] as const,
  /** The spent line lists only (lines grouped by day). */
  flowsExpensesSpentLinesAll: () => ["flowsExpenses", "spent", "lines"] as const,
  /** One entity: held across a unit or any selector change (mode, level, range, groups, pre-tax). */
  flowsExpensesSpent: (p: ExpensesSpentParams) =>
    withEntity(
      ["flowsExpenses", "spent", p.unit, p.mode, p.level, p.range, [...p.excludedBigGroups].sort().join(","), p.includePreTax] as const,
      2
    ),
  /** One entity: held across a unit, month, day or category change. */
  flowsExpensesSpentLines: (p: ExpensesSpentParams, month: string, day: string | null, category: string | null) =>
    withEntity(
      ["flowsExpenses", "spent", "lines", p.unit, p.mode, p.level, [...p.excludedBigGroups].sort().join(","), p.includePreTax, month, day, category] as const,
      3
    ),
  /** Nested under `flowsExpenses()` too: a line edit refetches the overview. One entity: held across a unit, mode or window change. */
  flowsOverview: (unit: DisplayUnit, installmentMode: "split" | "total", days?: number) =>
    withEntity(["flowsExpenses", "overview", unit, installmentMode, days ?? null] as const, 2),
  creditCardConfig: (accountId: string) => ["creditCardConfig", accountId] as const,
  ccFacturadoFinancingLinks: () => ["ccFacturadoFinancingLinks"] as const,
  portfolioGroup: (group: string, unit: DisplayUnit) =>
    withEntity(["portfolioGroup", group, unit] as const, 2),
  /** The mortgage group page; its own prefix, so a loan's writes refresh every unit of it. */
  mortgageGroupGlance: (group: string, unit: DisplayUnit) =>
    withEntity(["mortgageGroupGlance", group, unit] as const, 2),
  mortgageGroupGlanceAll: () => ["mortgageGroupGlance"] as const,
  /** The real-estate group page; its own prefix, so a property's or a loan's writes refresh every unit of it. */
  realEstateGroupGlance: (group: string, unit: DisplayUnit) =>
    withEntity(["realEstateGroupGlance", group, unit] as const, 2),
  realEstateGroupGlanceAll: () => ["realEstateGroupGlance"] as const,
  /** The Liabilities page; its own prefix, so a loan's or a card's writes refresh every unit of it. */
  liabilitiesGlance: (group: string, unit: DisplayUnit) =>
    withEntity(["liabilitiesGlance", group, unit] as const, 2),
  liabilitiesGlanceAll: () => ["liabilitiesGlance"] as const,
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
  /** The credit-card group page's lanes and upcoming payments (billing currency, no unit). */
  portfolioGroupCcLanes: (slug: string) =>
    withEntity(["portfolioGroupCcLanes", slug] as const, 2),
  portfolioGroupCcLanesAll: () => ["portfolioGroupCcLanes"] as const,
  /** One loan's ledger on a mortgage group page (`loanAccountId` null: the group's one loan). */
  groupFlows: (slug: string, filtersKey: string) =>
    withEntity(["groupFlows", slug, filtersKey] as const, 2),
  accountFlowsAll: () => ["accountFlows"] as const,
  /**
   * One account's flows rows. `scope` names the surface: the page's flows panel and the
   * cartola month modal never share a cache entry, so the modal can never be handed the
   * page's full list as held data (entity = account + scope).
   */
  accountFlows: (id: string, scope: AccountFlowsScope, filtersKey: string) =>
    withEntity(["accountFlows", id, scope, filtersKey] as const, 3),
  /**
   * A checking page's statement (paged months). Under the `accountFlows` prefix, so every write that
   * refreshes an account's flows (`resources.accountFlows` / `accountMovements`) refreshes it too.
   */
  checkingStatement: (id: string, filtersKey: string) =>
    withEntity(["accountFlows", id, "checking_statement", filtersKey] as const, 3),
  movementMirrorCandidates: () => ["movementMirrorCandidates"] as const,
  /** One entity: held across a unit or assumptions change. */
  projections: (unit: string, overridesKey: string) => withEntity(["projections", unit, overridesKey] as const, 1),
  wealthPercentile: (unit: DisplayUnit) => withEntity(["wealth-percentile", unit] as const, 1),
  benchmarks: () => ["benchmarks"] as const,
  deptoPrepayments: (accountId: number, benchmark: string, unit: DisplayUnit) =>
    withEntity(["deptoPrepayments", accountId, benchmark, unit] as const, 3),
  /** Every mortgage's prepaid-vs-invested blocks (a payment is written from either depto page). */
  /** Under the `deptoPrepayments` prefix, so a payment written on a loan page reaches it. */
  mortgageGroupPrepayments: (group: string, benchmark: string, unit: DisplayUnit) =>
    withEntity(["deptoPrepayments", "group", group, benchmark, unit] as const, 4),
  deptoPrepaymentsAll: () => ["deptoPrepayments"] as const,
  benchmarkComparison: (scope: string, benchmark: string, unit: DisplayUnit) =>
    withEntity(["benchmarkComparison", scope, benchmark, unit] as const, 3),
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
