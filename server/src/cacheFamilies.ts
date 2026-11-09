/**
 * Every cache family the server keeps (docs/untangle-plan.md F2), declared once: its key prefix,
 * what it reads and what drops it. `cacheRegistry.ts` walks this table on every invalidation;
 * nothing else names a prefix. A leaf module (types only), so the domain modules import their key
 * builders from here without pulling the cache in, and the cache imports no domain module.
 *
 * What drops an entry:
 * - the change log (`mark_input_changes`, filled by triggers in whichever connection wrote,
 *   `markInputTriggers.ts`), applied before any cached read and after every API write:
 *   - a mark row (a table a historical mark reads changed) drops every family — only the named
 *     accounts' entries of an account-scoped family;
 *   - a write row (any other change of a logged table) drops the families that read the table:
 *     `valuation` families read every logged table but {@link EXPENSE_METADATA_TABLES}, `any`
 *     families read them all;
 * - a historical market-data notice (`invalidateMarketDataAggregations("historical")`: EOD closes,
 *   fx/UF rows, fund units written by this process): the families with `historicalMarket`;
 * - a live-quote tick: the `liveTick: "affected"` families' entries that read a moved price
 *   (`cacheDependencies.ts`), or all of them when the tick cannot say what moved;
 * - the Chile day rollover: everything but the mark series (entries bake in "today").
 *
 * Inside a transaction a `bypassInTransaction` family builds without caching (a report-only import
 * reads rows it then rolls back); a `response` family's values are API payloads, marked for
 * one-time serialization (`jsonResponse.ts`).
 */

export type CacheFamilyReads = "valuation" | "any";

export type CacheFamily = {
  /** Longest matching prefix wins: a family may sit under another's prefix. */
  prefix: string;
  reads: CacheFamilyReads;
  /** Keys `<prefix><accountId>` or `<prefix><accountId>|…`: a mark row naming accounts drops only theirs. */
  accountScoped: boolean;
  historicalMarket: boolean;
  liveTick: "keep" | "affected";
  bypassInTransaction: boolean;
  response: boolean;
  /** Entries record no live inputs (the history tier reads none by contract). */
  untracked?: boolean;
};

/**
 * Tables no `valuation` family reads: the expense, income, document and check metadata the
 * Expenses, income and tax pages show (categories, notes, big groups, receipts, bills, payslip
 * lines, …). A write to one drops only the `any` families (the API payloads that show them).
 */
export const EXPENSE_METADATA_TABLES: ReadonlySet<string> = new Set([
  "art107_instruments", "bank_account_balance_checks", "bank_account_balance_snapshots", "bank_transfer_notices",
  "broker_read_coverage", "categories", "cc_bank_cupo_captures", "cc_bank_cupo_checks", "cc_bank_cupo_snapshots",
  "cc_expense_big_groups", "cc_expense_categories", "cc_expense_generic_unique_merchants",
  "cc_expense_line_categories",
  "crypto_trade_details", "expense_accounts", "expense_category_rules",
  "expense_entries", "expense_groups", "f22_settlements", "flow_big_groups", "flow_categories", "flow_evidence", "flow_income_overrides", "flow_link_rejections", "flow_notes", "flow_orphan_assignments", "flow_parts", "flow_refunds", "flows",
  "grocery_branch_merchants", "grocery_brands",
  "grocery_product_aliases", "grocery_products", "grocery_receipt_items", "grocery_receipts", "import_batches",
  "income_entries", "incoming_wire_booking_notices", "incoming_wire_notices", "market_display_series",
  "merchant_document_sources", "merchant_receipt_items", "merchant_receipts", "merchant_subscription_notices",
  "mortgage_sheet_imports", "movement_mirror_pair_rejections", "movement_transfer_notices", "outside_parties",
  "payment_processor_receipts", "payment_receipt_charges", "payroll_afp_rates", "payroll_parameters",
  "payslip_advances", "payslip_lines", "pension_account_reads", "recurring_payment_patterns", "recurring_payments", "sii_f22_filed",
  "sii_informed_dj", "transfer_counterparty_accounts", "unemployment_fund_reads", "utility_bills",
  "utility_service_accounts", "vendor_catalog",
]);

const aggregation = { bypassInTransaction: false, response: false } as const;
const response = { bypassInTransaction: true, response: true } as const;
/** An aggregation built afresh inside a transaction, not an API payload. */
const pagePart = { bypassInTransaction: true, response: false } as const;

/** The history tier (`historyTierMemo`): results computed only from evidence dated before today. */
export const HISTORY_TIER_PREFIX = "hist.";
export const DASHBOARD_PAGE_BUNDLE_PREFIX = "dashboard.page_bundle|";
export const DAILY_SERIES_RESPONSE_PREFIX = "daily.series|response|";
const CC_LEDGER_PREFIX = "cc.ledger|";

export const CACHE_FAMILIES: Readonly<Record<string, CacheFamily>> = {
  history: {
    prefix: HISTORY_TIER_PREFIX,
    reads: "valuation",
    accountScoped: false,
    historicalMarket: true,
    liveTick: "keep",
    untracked: true,
    ...pagePart,
  },
  // Daily aggregations over the per-account mark series (`markSeriesStore.ts`).
  daily_series: { prefix: "daily.series|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  daily_series_response: { prefix: DAILY_SERIES_RESPONSE_PREFIX, reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  daily_overview: { prefix: "daily.overview|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  /** The net worth's all-time high (`netWorthAllTimeHigh.ts`): today's live point can set a new one. */
  net_worth_ath: { prefix: "daily.overview|ath|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  daily_reference_sources: { prefix: "daily.refsrc|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  depto_ledger: { prefix: "depto.ledger|", reads: "valuation", accountScoped: false, historicalMarket: false, liveTick: "keep", ...aggregation },
  /** A card's billing detail bundle and its base part (`ccBillingDetailCache.ts`): the bundle prices unpaid dollars at the live rate. */
  cc_billing_detail: { prefix: "cc.billing_detail|", reads: "valuation", accountScoped: true, historicalMarket: false, liveTick: "affected", ...aggregation },
  /** A card's evidence memos (normalized post-close lines, payment events, plan interest, revaluation). */
  cc_billing_parts: { prefix: "cc.billing_parts|", reads: "valuation", accountScoped: true, historicalMarket: false, liveTick: "keep", ...aggregation },
  /** Card ledger payloads: they read card config, labels and plan edits as well as the billing detail. */
  cc_ledger: { prefix: CC_LEDGER_PREFIX, reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  account_monthly_perf: { prefix: "account.monthly_perf|", reads: "valuation", accountScoped: true, historicalMarket: true, liveTick: "affected", ...aggregation },
  group_consolidated_monthly: { prefix: "group.consolidated_monthly|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...pagePart },
  group_closing_by_date: { prefix: "group.valuation_closing_by_date|", reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  /** The home page bundle (`dashboard.page_bundle|<unit>`); «Próximos pagos» reads bill rows and declared payments. */
  home_bundle: { prefix: DASHBOARD_PAGE_BUNDLE_PREFIX, reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  account_detail_bundle: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}account_detail|`, reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  /** A group page's responses (valuation series, tables, monthly P/L series, Rentabilidad, reference totals). */
  group_responses: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}group|`, reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  sidebar_nav: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}sidebar_nav`, reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  dashboard_overview: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}overview|`, reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  /** The dashboard account rows, one per account and the list, and the pieces they share. */
  dashboard_account_rows: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}account_row`, reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...pagePart },
  /** The account rows list: an API payload itself. */
  dashboard_account_rows_list: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}account_rows|`, reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  /** The nav snapshot and the nav context (`dashboardAccounts.ts`). */
  dashboard_nav: { prefix: `${DASHBOARD_PAGE_BUNDLE_PREFIX}nav_`, reads: "valuation", accountScoped: false, historicalMarket: true, liveTick: "affected", ...response },
  /** The flows overview payloads (`flowsOverview.ts`): they bake in the P/L leg. */
  flows_overview: { prefix: "flows.overview|", reads: "any", accountScoped: false, historicalMarket: true, liveTick: "affected", ...aggregation },
  /**
   * The flows overview's inputs (income, expense lines, deposits, the Expenses payloads): no live
   * quote, but the live dollar rate the expense lines priced unpaid dollars at
   * (`syncFlowsInputsWithLiveUsdRates`, `flowsMortgageCarrying.ts`).
   */
  flows_inputs: { prefix: "flows.overview.inputs|", reads: "any", accountScoped: false, historicalMarket: true, liveTick: "keep", ...aggregation },
  /** A checking account's display balance at a date (`checkingCartolaBalances.ts`). */
  checking_balance: { prefix: "checking.balance|", reads: "valuation", accountScoped: true, historicalMarket: false, liveTick: "keep", ...aggregation },
};

export type CacheFamilyName = keyof typeof CACHE_FAMILIES;

export type CacheUnit = "clp" | "usd" | "uf";

export function cacheKeyAccountMonthlyPerf(accountId: number, unit: CacheUnit): string {
  return `account.monthly_perf|${accountId}|${unit}`;
}

/** Callers append `|<rows fingerprint>` (and `|raw|…`). */
export function cacheKeyGroupConsolidatedMonthly(groupSlug: string, unit: CacheUnit): string {
  return `group.consolidated_monthly|${groupSlug}|${unit}`;
}

export function cacheKeyGroupClosingByDate(slug: string, unit: CacheUnit): string {
  return `group.valuation_closing_by_date|${slug}|${unit}`;
}

export function cacheKeyCcBillingDetail(accountId: number): string {
  return `cc.billing_detail|${accountId}`;
}

export function cacheKeyCcBillingDetailBase(accountId: number): string {
  return `cc.billing_detail|${accountId}|base`;
}

/** One of a card's evidence memos (`part`: what it holds, plus whatever else keys it). */
export function cacheKeyCcBillingPart(accountId: number, part: string): string {
  return `cc.billing_parts|${accountId}|${part}`;
}

export function cacheKeyCcLedgerAccount(accountId: number): string {
  return `${CC_LEDGER_PREFIX}account|${accountId}`;
}

export function cacheKeyCcLedgerGroup(slug: string): string {
  return `${CC_LEDGER_PREFIX}group|${slug}`;
}

export function cacheKeyDashboardPageBundle(unit: CacheUnit): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}${unit}`;
}

export function cacheKeyAccountDetailBundle(accountId: number, unit: CacheUnit, granularity: string): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}account_detail|${accountId}|${unit}|${granularity}`;
}

export function cacheKeyGroupResponse(kind: string, slug: string, unit: CacheUnit): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}group|${kind}|${slug}|${unit}`;
}

export const CACHE_KEY_SIDEBAR_NAV = `${DASHBOARD_PAGE_BUNDLE_PREFIX}sidebar_nav`;

export function cacheKeyDashboardOverview(unit: CacheUnit): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}overview|${unit}`;
}

/** `name`: `account_rows|<unit>`, `account_row|<id>|<unit>`, `account_rows_ctx|<unit>`, … */
export function cacheKeyDashboardAccountRows(name: `account_row${string}`): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}${name}`;
}

/** `name`: `nav_snapshot|<unit>` or `nav_context|…`. */
export function cacheKeyDashboardNav(name: `nav_${string}`): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}${name}`;
}

export function cacheKeyGroupDailySeriesResponse(rest: string): string {
  return `${DAILY_SERIES_RESPONSE_PREFIX}group|${rest}`;
}

export function cacheKeyAccountDailySeriesResponse(rest: string): string {
  return `${DAILY_SERIES_RESPONSE_PREFIX}account|${rest}`;
}

export function cacheKeyDailySeries(rest: string): string {
  return `daily.series|${rest}`;
}

export function cacheKeyDailyOverview(unit: CacheUnit, days: number): string {
  return `daily.overview|${unit}|${days}`;
}

export function cacheKeyNetWorthAth(unit: CacheUnit): string {
  return `daily.overview|ath|${unit}`;
}

export function cacheKeyDailyReferenceSource(sourceSlug: string, unit: CacheUnit, days: number): string {
  return `daily.refsrc|${sourceSlug}|${unit}|${days}`;
}

export const CACHE_KEY_DEPTO_LEDGER = "depto.ledger|rows";

export function cacheKeyFlowsOverview(rest: string): string {
  return `flows.overview|${rest}`;
}

export function cacheKeyFlowsInputs(rest: string): string {
  return `flows.overview.inputs|${rest}`;
}

export function cacheKeyCheckingBalance(accountId: number, asOfYmd: string, cutoff: string): string {
  return `checking.balance|${accountId}|${asOfYmd}|${cutoff}`;
}
