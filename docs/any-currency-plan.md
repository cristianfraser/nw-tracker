# Any display currency (CLP, USD, EUR now; any ISO code later)

Status: built 2026-11-12 for CLP, USD and EUR (core currencies). On-demand currencies (any other ISO code, loaded on first use) are the next step. The global display unit (today the CLP/USD toggle) becomes any
**core currency** of the `currencies` table (migration 312: CLP, USD, EUR; UF stays a series unit of
its own). Conversions go through `server/src/rates.ts` only: a direct pair first, else through USD,
else through CLP. EUR/USD lives in `fx_rates` (Yahoo `EURUSD=X`, synced by the `fx_pairs` source);
EUR/CLP reads Banco Central's `eur_daily` directly (a direct pair).

Rules every stream follows:

- **A payload is built per requested unit** (`?unit=<code>`, parsed by `parseDisplayUnit` in
  `server/src/displayUnits.ts`), or carries native `{value, currency}` plus `converted` in the
  requested unit. No `*_usd` twins, no `Record` keyed by a fixed list of units, no
  `unit === "usd"` branches outside `rates.ts` / `valueConvert.ts`.
- **Native transaction currencies are not display units.** A card's dollar sub-balance, a
  statement's `facturado_usd`, an ingest payload's `currency` stay as they are.
- **Parity.** With the unit CLP or USD every figure equals the pre-change payloads (captured from a
  copy of the 2026-11-11 database). EUR is checked by hand against the rates.
- **Caches** are keyed by the unit string; warmers loop over `coreCurrencyCodes()`.
- The tax return, the US 1040, groceries and the fx bid/ask gaps table keep their own currencies:
  they are jurisdiction or native amounts, not the display unit.

## Payload styles today

- **(P)** built per requested unit (`unit` field): mostly a type change plus key plumbing.
- **(B)** pesos always plus `_usd` twins when `include_usd=1`: the dashboard row and nav payloads.
  Each pair becomes one value in the requested unit.
- **(A)** unit-less, carrying both: the flows ledgers (deposits, P/L, reconciliation, income
  lines), market series, wealth percentile. They take `unit` (or native + converted).

## Stream 0 — foundation (single owner, first)

Server: `rates.ts` (`CurrencyCode` / `TsUnit` / `CURRENCY_CODES` / `isCurrencyCode` closed unions →
codes validated against `currencies`; `TsUnit` = core codes + `uf`), `valueConvert.ts`
(`clpToUnitAt` and its shim `clpToUnitAt.ts`), `flowsDeposits.ts` `flowEventInUnit` (move into the
conversion layer; the event's own `amt_usd` leg used only when the unit is USD), `cacheFamilies.ts`
(`CacheUnit`), one `?unit=` param everywhere (`include_usd` / `include_uf` accepted as a deprecated
alias until the client switches) in `routes/dashboard.ts`, `routes/accounts.ts`, `routes/flows.ts`,
`routes/benchmarks.ts`, `routes/market.ts`, `routes/projections.ts`, `routes/exportXlsx.ts`;
`usageLog.ts` params; `visitedPagesWarm.ts`, `dashboardCacheWarmer.ts`, `rentabilidadDailyWarm.ts`
unit loops. Contracts: one `DisplayUnitCode` type replacing the `"clp"|"usd"(|"uf")` literals in
`dto/accounts.ts`, `groups.ts`, `performance.ts`, `dashboard.ts`, `flows.ts`, `market.ts`,
`projections.ts`; a `GET /api/currencies` (code, symbol, minor digits) for the client.

Client: `queries/keys.ts` `DisplayUnit` → string code; `otherDisplayUnit()` → a remembered
previous unit; `DisplayPreferencesContext.tsx` / `displayPreferenceStorageSync.ts` validators;
`AppDisplayPreferencesBar.tsx` options from `/api/currencies`; `api.ts` (≈22 functions, 14
`include_usd`), `queries/hooks.ts`, `fetchers.ts`, `displayUnitQueries.ts`, `mutations.ts`,
`prefetchPageShape.ts`, `resources.ts`, `AppSidebar.tsx`; `format.ts` (`CurrencyDisplayUnit`,
`CURRENCY_SYMBOL`, `formatCurrency`, `formatCompactMoney`, number-flow parts, the USD adaptive
decimals) driven by the currency's symbol and minor digits; `components/charts/chartLayout.ts`
(`ChartDisplayUnit`, axis / tooltip formatters), `flowsDisplay.ts`, `chartColors.ts`; the card value
components (`DashboardCardValue`, `DashboardCardGroupMetrics`, `CompactEntityCard`,
`DetailedGroupCard`, `DeltaMetricFlow`, `AnimatedNumberFlow`) take `(value, unit)`.

## Stream 1 — expense, flow and income surfaces

`/api/flows/overview` (P), `/api/flows/expenses/credit-card/gastos` (P), `/api/income` (lines A,
aggregates P), `/api/flows/expenses/credit-card` (A; lines already carry `values`, to become
`amount` + `converted`), `/api/flows/deposits` (A), `/api/flows/pl` (A),
`/api/flows/deposits/reconciliation` (A), latest movements. Server: `flowsExpensesGastos.ts`,
`lineMoney.ts` (only clp/usd today), `flowsOverview.ts`, `flowsOverviewCash.ts`,
`flowsMortgageCarrying.ts`, `flowMoneyAtDate.ts`, `flowsDeposits.ts`, `flowsPl.ts`,
`flowsDepositsReconciliation.ts`, `flowsExpenses.ts`, `flowsCheckingInflows.ts`,
`additionalCardReimbursements.ts`, `payrollBreakdown.ts`, `flowsCheckingGastos.ts`,
`checkingExpenseRefunds.ts`, `wireExpenseLine.ts`, `latestMovements.ts`, `latestCardPayments.ts`,
`fxConversionWarningScan.ts`. Client: Expenses, FlowsOverview, Income, Deposits,
DepositsReconciliation, FlowsPl pages and charts, `components/income/*`, the expense tables,
`AdditionalCardsSection`, `DashboardFlowsSummary`, `LatestMovementsTable`, `incomeAggregates.ts`.
Also the below-450 px rule of the expense rows (the converted value alone; «≈» when live).

## Stream 2 — dashboard rows, nav cards and bundles (the (B) payloads)

`/api/dashboard/nav-snapshot`, `/nav-context`, `/page-bundle` (`dash`, `fx`, `fx_coverage`),
`/api/accounts?portfolio_group`. `DashboardAccountRow` (19 `_usd` fields), the bucket totals and
prior closes, `totals`, `allocation`, `liabilities_breakdown`, `cash_credit_card_links`, the nav card
DTOs (`NavCardPeriodMetricsDto`, `NavCardAmountDto`, `NavPctCell`), the value map. Server:
`dashboardAccounts.ts`, `dashboardPagePayload.ts`, `dashboardPageBundle.ts`,
`dashboardNwBucketTotals.ts`, `dashboardNavCardMetrics.ts`, `navValueMap.ts`,
`proxyBasketBreakdown.ts`, `cashEqsBucketNet.ts`, `periodPctDailyChain.ts`,
`portfolioGroupValueAtDate.ts`, `dashboardChartMarkTotals.ts`, `brokerageAcciones.ts`
(`DashboardAccountStats`). Client: `dashboardCardBreakdown.ts`, `navCardBreakdown.ts`,
`portfolioNavDashboardCards.ts`, the dashboard card components, `ValueMapPanel`, `ValueTreemap`,
`DashboardPage`, the strip parts of the group and account pages, the placeholders,
`FxCoverageBanner`. Persisted `nav_strip` and `group_shell` versions bump.

## Stream 3 — valuation, daily series, performance, Rentabilidad, benchmarks, export

`/api/dashboard/valuation-timeseries`, `/api/daily-series`, `/api/dashboard/overview-daily`,
`/inversiones-perf-daily`, the group consolidated tables / period returns / consolidated monthly /
performance monthly, the account detail bundle's series and performance, `/api/benchmark-comparison`,
the XLSX export. Server: `valuationTimeseries.ts` (USD milestones keep `level_currency: "usd"` — a
milestone's level is fixed in dollars and converts into the unit), `dailySeries.ts`,
`groupDailySeriesResponse.ts`, `dashboardOverviewDaily.ts`, `netWorthAllTimeHigh.ts`,
`dailyReferenceLines.ts`, `dailyPctSeries.ts`, `dailyPerfLevels.ts`, `detalleDailyChainedPct.ts`,
`accountPerformance*.ts`, `perfKernel.ts`, `periodReturns*.ts`, `groupMonthlyPerfConsolidation.ts`,
`groupConsolidatedTables.ts`, `groupMonthlyPlSeries.ts`, `groupPagePayloads.ts`,
`groupDailySeries.ts`, `inversionesPerfSeries.ts`, `netWorthConsolidation.ts`, `accountValue.ts`,
`accountTodayValue.ts`, `accountMarkDailyCache.ts`, `benchmarkLevels.ts`, `benchmarkComparison.ts`,
`exportWorkbook.ts`. Client: the valuation and perf charts and tables, the group and account page
data hooks and their placeholders, `ExportModal`.

## Stream 4 — cards and liabilities

`/api/mortgage-prepayment-comparison` (P), the page bundle's `upcoming_payments`, the card owed walk
in a unit (`ccOwedWalk.ts`, `ccFinancingCostDaily.ts`, `ccDailyHistorialBlock.ts` — CLP-only
today), `mortgagePrepaymentComparison.ts`, `dashboardCcUpcomingPayments.ts`. Client: the
liabilities sections, the card and mortgage account pages, `CcInstallmentHistoryChart`,
`CreditCardGroupExpensesChart`, the mortgage forms, `UpcomingPaymentsPanel`.

## Stream 5 — market, projections, wealth

`/api/market-ticker`, `/api/watchlist` (`watchlistStats.ts`, `marketTicker.ts`),
`/api/market-series` (A), `/api/projections`, `/api/wealth-percentile` (USD-native thresholds).
Client: Watchlist, the marquee, Rates, Projections, WealthPercentile pages.

## Live rates

Only USD/CLP has a live rate (`fxLive.ts`, `CLP=X` in the poll and the price stream). EUR/USD and
EUR/CLP read their latest stored day for today; a live EUR/USD quote is a follow-up.
