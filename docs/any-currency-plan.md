# Any display currency (CLP, USD, EUR now; any ISO code later)

Status: built 2026-11-12 for CLP, USD and EUR as DISPLAY units. The 2026-11-12 audit (below,
«Remaining work») found what is still fixed to CLP and USD: display leaks, closed currency lists in
storage and contracts, and code that models only pesos and dollars as held currencies. On-demand
currencies (any other ISO code, loaded on first use) come after that. The global display unit (today the CLP/USD toggle) becomes any
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
(`CacheUnit`), one `?unit=` param everywhere (the `include_usd` / `include_uf` flags retired) in `routes/dashboard.ts`, `routes/accounts.ts`, `routes/flows.ts`,
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

Every core pair has a live rate (C6, done 2026-11-12): USD/CLP (`CLP=X`) and every pair `currencies`
loads from Yahoo (EUR/USD, `EURUSD=X`), in the poll and the price stream, on the forex day of
`forexDay.ts`, its day close written once into `fx_rates`. Today's EUR/CLP is EUR/USD × USD/CLP while
EUR/USD has a quote of today, else Banco Central's direct `eur_daily` (published a day late).

## Remaining work (audit of 2026-11-12)

Four read-only audits (client, server logic, contracts, storage + ingest + copy) looked for
anything still fixed to CLP / USD. Classes: **D** a figure shown in the wrong currency in EUR,
**R** a fixed rate or currency pair, **S** storage named after one currency, **L** a label naming
a currency, **N** native (correct as it is: card facturado, tax, cartola balances, rate tables).
Earlier passes missed these because they searched for `_usd` twins and `include_usd`; these sites
never had a twin. Phases run in order; each keeps CLP / USD payloads byte-identical to captures
from a copy of the database taken before it, and adds EUR tests on synthetic fixtures.

### Phase A — display leaks (D / R / L)

**Done 2026-11-12** (all eleven items and the guard). With the unit CLP or UF every payload is
unchanged; in USD and EUR amounts are now rounded to the currency's minor digits (gastos and income
rows had been whole dollars: up to ~3 USD per row), and today's dollar card payments and USD
milestone read the live USD/CLP rate. Known leftovers: the card's upcoming-payment `owed` is still a
`{clp, usd}` pair (Phase C3); an income line's legacy `amount_usd` leg (Phase B); upcoming items
other than cards are not rounded; the property summary's value falls back to the summary's
latest valuation (in the unit) behind the ledger's pesos.

1. Account page (`StandardAccountDetailPage.tsx`): the position table, broker holdings, state
   contribution and the USD cash tile format with `formatClp` whatever the unit; the contracts
   behind them (`AccountPositionSnapshot`, `EquityBrokerHolding`, `AccountSummaryResponse`
   deposits / latest valuation, `AccountDepositInflowsResponse`) get one value in the requested
   unit. The cash tile's native balance shows in its own currency always (it reads «—» outside
   USD today).
2. FX coverage (`fxCoverage.ts`, `FxCoverageBanner`, the `fxCoverage.*` strings): check every
   pair the requested unit walks through `rates.ts`, and name the pair and unit in the copy.
3. Gastos and income month rows: one value in the unit, rounded by the currency's minor digits;
   `_clp` field names and `BigGroupUsage.total_clp` renamed.
4. `flowsOverview.ts` still calls the legacy CLP + USD deposits builder; the reconciliation keeps
   twins. Both build in the unit.
5. Hand conversions through pesos (`flowsOverviewCash.ts`, the flow legs, card upcoming
   payments, the USD milestones) go through `rates.ts`.
6. Client cells pinned to one currency: `BigExpenseGroupsSection`, `DeptoAccountSummaryCards`,
   `StackedExpensesChart`, `CreditCardSummaryCards`, `DashboardCardValue`'s «US$».
7. Export columns, property aportes (CLP only), `ZERO_CLOSE_EPS` and every `unit === "clp"`
   rounding read the currency's minor digits.
8. **Done 2026-11-12** (rate rows of kind `fx_pair`, migration 313; projections per-currency inflation and money inputs in any core currency). Market: watchlist / marquee chip and market series gain EUR/USD; projections get an inflation
   per currency (EUR falls back to USD's today) and inputs typed in the display unit.
9. **Done 2026-11-12.** Warmers: visited account pages warmed in the units they were opened in
   (`visitedPagesWarm.ts`); the dump / profile scripts loop over `coreCurrencyCodes()`.
10. Copy: `toolbarAria`, the demo tour step, the `FlowsTable` amount filter (any currency), chart
    prop defaults and the `chartColors` union.
11. **Done 2026-11-12.** Cleanup: `dashboardBucketsUsdToday`, unused fx fields, stale TODOs, AGENTS.md «Deferred: value
    + currency refactor» (valuations already take any currency, migration 260).

**Guard, landing with A1:** `check:conventions` rules, each with an allowlist of native surfaces:
`formatClp(` / `formatUsd(` in `client/src/components|pages`; `unit === "<code>"` and
`["clp","usd"]` literals outside `rates.ts` / `valueConvert.ts`; `_clp` / `_usd` keys in
`server/contracts/src/dto`; `CHECK (… IN ('clp'…))` in a new migration; `"clp" | "usd"` type
unions outside the allowlist.

### Phase B — open storage and contracts

**Done 2026-11-12** (migrations 314 currency references, 315 market tables, 316 expense / piece /
income amount + currency; ingest contracts take any ISO code and the server checks it on receipt).
Rehearsed together on a copy of the 2026-11-11 database: row counts, the 464 triggers and their
order, foreign keys and integrity unchanged; expense, flows and market payloads byte-identical.
Found on the way: real databases carried an older flow-identity trigger on `movements` than a fresh
one (no `option_*` arms: migration 290 installed it before the options work). Migration 317
re-creates it from the current spec where it differs, keeping the table's trigger order; no option
movement existed on such a database, so no flow needed a new kind.

**Every currency column references `currencies(code)`.** One migration rebuilds the 24 tables
whose CHECK lists codes (`cc_statements`, `cc_bank_cupo_snapshots`, `cc_header_payment_legs`,
`cc_planted_payment_lines`, `cc_manual_payments`, `cc_owed_anchors`, `bank_account_numbers`,
`bank_account_balance_snapshots`, `merchant_receipts`, `merchant_subscription_notices`,
`payroll_work_earnings`, `equity_dividends`, `broker_withdrawal_requests`,
`incoming_wire_notices`, `market_symbols`, `equity_daily`, `live_market_quotes`,
`recurring_payments`, `movements` (both legs), `movement_dividend_details`, `loan_payments`
(both), `fund_unit_daily`, `pension_fund_unit_official`), with foreign keys off
(`FOREIGN_KEYS_OFF_MIGRATIONS`, as migration 169) and the baseline updated. `flows.currency`
gets the reference too. Exceptions: the UF stays a `currencies` row (tier `index`), so it passes
the reference; `'none'` (an index level in points) becomes a NULL quote currency on an instrument
registered as an index (`market_symbols`, `equity_daily`, `live_market_quotes`; readers read NULL
where they read `'none'`); `crypto_trade_details`' btc / eth stay their own list (coins are
instruments, not currencies).

**One-currency storage gets `amount` + `currency` (done 2026-11-12, migration 316):** `expense_entries.amount_clp` (manual expenses
in any currency; place bills stay pesos by CHECK; the flow triggers in `flowTables279.ts` read the
row's currency), `flow_parts.amount_clp` (a piece is held in its flow's currency), and the legacy
`income_entries.amount_clp` (its `amount_usd` twins in `flowsCheckingInflows.ts` go too).

**Ingest contracts:** the 12 `z.enum(["clp","usd"])` (card line, statement, unbilled and pasted
listings, payment receipt, bank movements and balances, broker movements and notifications,
merchant documents, the manual card-payment task) and `bank_account.incoming_wires`' usd become a
lowercase ISO code (`/^[a-z]{3}$/`); the server checks it against `currencies` on receipt.
`schema_version`s bump where a payload gets wider. Where the server's code still handles only
pesos and dollars, it refuses with an error naming the currency until Phase C reaches it. *Done 2026-11-12:* `currencyCodeSchema`, `server/src/ingestCurrencies.ts` (422 `unknown_currency` / `unsupported_currency`); no `schema_version` bumped (widening keeps every old payload valid).

### Phase C — held currencies beyond pesos and dollars

What Phase B opens, the code still models as «pesos, plus dollars». Each step replaces a two-slot
model by one keyed by currency; parity for CLP / USD as above, and a synthetic EUR case per step.

1. **Done 2026-11-12** (migration 318: `accounts.cash_currency`, currency-neutral flow kinds; AGENTS.md «Cash in any currency»). Leftovers: the legacy `usd` leaves keep their slug (routes, import keys), the client's cash form and panel offer CLP / USD only, trades and premiums settle in dollars only. **Foreign cash accounts.** USD cash (kind `usd`, `isUsdCashAccount`, `usdCashBalanceUsdAt`,
   `signedUsdDeltaForAccountMovement`, `listUsdCashAccountIds`: 26 files) becomes cash held in the
   account's currency (`accounts` declares it; the leaf kind stops naming the currency). The flow
   kinds named after a pair (`deposit_usd`, `withdrawal_usd`, `compra_usd_venta_clp`, …: 12
   files) become currency-neutral kinds whose legs carry their currencies; a migration renames
   stored rows. The capital-flow rules (`equityBrokerageCapitalFlows.ts`), the cash ledger walks,
   the deposits and the cash fx leg of the flows overview read the account's currency.
2. **Done 2026-11-12** (`foreignCashLotWalk.ts`, `foreignCashCostLots.ts`, `foreignCashTaxLotEvents.ts`, `f22/foreignFx.ts`, `bcentralObservado.ts`; AGENTS.md «Foreign currency is tax lots»; CLP / USD tax and card payloads byte-identical on a copy of the 2026-11-12 database). A conversion between two foreign currencies is a disposal of one and a purchase of the other. Leftovers: `usdDebtPaymentsForAccount` and the facturación rate resolvers still read only dollar payments (C3); the broker withdrawal requests are Fintual's dollar account only. **Foreign-currency lots.** `usdCashLotWalk.ts` / `usdCashCostLots.ts` walk lots of any foreign
   currency; the card payment cost tracer prices a payment in its currency. The F22's dollar-lot
   module (`f22/usdFx.ts`) applies the same oficios to any foreign currency (they speak of
   «moneda extranjera»), at that currency's official rate. Checked 2026-11-12 against the text of
   Oficio 2573/2022: its rule is stated for «moneda extranjera» (dollars are only its example), and
   points 2–3 convert «según el tipo de cambio observado de la moneda que se trate, publicado por el
   Banco Central» for a taxpayer without full accounting — so EUR lots use Banco Central's euro
   observado (`eur_daily`), and a currency the Banco Central does not publish throws.
3. **Done 2026-11-12** (migrations 319–322 and 324; AGENTS.md «Card dollars in pesos», «Card storage per currency»). *Part 4 (the rest) done 2026-11-12:* the open cycle and a provisional close bill every currency the card's lines are in (`openMonthForeignFacturado`; `debtCcExpenseLineAmountClp` values a third currency's line at its debt-frame rate, so the open-cycle sums, the cuota sums and the payment roll count it), `openFacturacionCredits`, «Próximos pagos» (`CcCardPayments.paid` / `open_credits` maps, each foreign currency at today's mid) and `ccOwedByCurrency` (a `foreign` entry per currency; the cupo check judges and reports any currency) are per currency; the canonical statement import takes a currency the card's issuer declares (`requireCardCurrency`, `cards/cardCurrencies.ts`; unknown → `unknown_currency`, undeclared → `unsupported_currency`) and its reconcile checks a third currency's statement by the international rules. The euronova card goes through the real import end to end (`ccEuroCardImport.test.ts`: anchors, facturaciones, expense lines, Pasivos valuations, «Próximos pagos», the cupo check, the open cycle). Migration 324 drops the four generated legacy line columns (a plain `DROP COLUMN`: no row, index or trigger moved, the triggers keep their order); every reader derives that view through `cards/lineAmountSql.ts` (`lineAmountClpSql` … in SQL, `lineLegacyAmounts` in memory). Parity on a copy of the 2026-11-12 database (44 payloads: the four cards' detail bundles and daily series, the two Pasivos groups' cc-ledger / daily / valuation / nav-context, the page bundle, card expense lines, gastos, flows overview, latest movements, CLP and USD; the mirror dry run; the cupo recheck report; `verify-cc-billed-cuotas`): byte-identical after each commit; the migration kept row counts, `integrity_check`, `foreign_key_check` and every trigger's name and order; a real incremental re-import of the parsed corpus (241 statements) found every fingerprint unchanged. Leftovers: the Santander `card.statement` JSON pipeline (`cardStatementApply.ts`, `santanderStatementImport.ts`, the cross-check, and the contract's `currency: clp | usd` in its apply details) still takes pesos and dollars only; a provisional close's feed figure is the dollar SALDO INICIAL only (a feed is Santander's); the listing and receipt handlers (`cardListingLines.ts`, `ccWebPasteParse.ts`, `santanderCcPaymentReceipts.ts`, `santanderBankCupo.ts`) refuse other currencies; the reconcile row keeps its `amount_usd` slot name for the foreign amount; the cupo check's stored verdict detail now keeps `foreign` (old rows with `usd` still render). *Part 1 done 2026-11-12 (migration 319):* statement lines store `amount` + `currency`
   + `cuota_amount` (the four legacy names are generated columns with unchanged values; a third
   currency reads NULL there), the owed walk, its anchors, `cardValueInUnit` and the revaluation term
   are a map by currency, and a euro card (fictional issuer `euronova`) walks, values and revalues
   its euros. Card payloads byte-identical in CLP and USD on a copy of the 2026-11-12 database (43
   payloads + the cupo task). Still open: the readers of the legacy line columns (~70 files: the
   billing detail, the facturaciones and their dollar rates, the statement-frame split
   `ccStatementOwedByCurrencyByMonth`, which still splits pesos and dollars only, expense lines), so a
   euro card's anchors, facturaciones and expense lines are not right yet.
   *Part 2 (storage) done 2026-11-12:* `cc_billing_month_metrics` (320), `credit_card_cupos` and
   `cc_feed_billing_close_amounts` (321), traspaso legs `from_*` / `to_*` (322), the upcoming
   payment's `owed` a map by currency; parity on a real-data copy for each. Still open: the readers
   named above, the facturación rows' per-currency entries and the currency argument of the dollar
   payment helpers, and retiring the generated legacy line columns.
   *Part 3 (readers) done 2026-11-12:* facturación rows carry `facturado_foreign` (one entry per
   currency the card bills in: amount, pesos, rate, rate source) in place of `facturado_usd*` /
   `usd_rate_*`; the historial bars a `facturado_foreign_clp` segment; `foreignDebtPaymentsForAccount`,
   `facturacionForeignRatesForAccount`, `foreignPaymentLineClpResolver`, `isCcForeignPaymentLine`,
   `foreignBilledFromStatementLines` and the revaluation's real-rate term take the currency
   (`ccFacturacionForeignRate.ts`, `ccForeignStatementBilled.ts`); the statement-frame split varies
   each currency's uniform rate (`withUniformDebtRates`); the expense lines read `amount` /
   `currency` / `cuota_amount`. A euro card's closed facturación bills its euros at the rate a euro
   payment from a euro cash account actually cost (`ccEuroCardFacturacion.test.ts`). Card payloads,
   the cupo report, the mirror dry run and `verify-cc-billed-cuotas` identical on a copy of the
   2026-11-12 database (renamed fields mapped back). Leftovers: the open cycle's and a provisional
   close's third-currency lines (they read 0 / nothing: `openMonthUsdFacturado`, the open-month sums
   and `debtCcExpenseLineAmountClp` still read the legacy columns), the upcoming payments' reckoning
   (pesos and dollars only), `ccOwedByCurrency` (the bank cupo check: pesos and dollars). The
   generated legacy line columns stay: about 58 files still read `amount_clp` / `amount_usd` /
   `valor_cuota_mensual_*` (the plan ledger, the cuota retirement, the import dedupe and reconcile,
   the web-paste and feed writers' checks, the open-month and billed-line sums, the grocery and
   real-estate matchers); they are retired when those move.
   `CcOwedNative {clp, usd}` (`ccOwedWalk.ts`, `ccOwedByCurrency.ts`) becomes a map by
   currency, its revaluation term per sub-balance. Statement lines: `cc_statement_lines`
   `amount_clp` / `amount_usd` and `valor_cuota_mensual_*` → `amount` + `currency` (a line is in
   its statement's currency already); `cc_billing_month_balances` → the long table
   `cc_billing_month_metrics(…, metric, currency, amount)`; `credit_card_account_config.cupo_*`,
   `cc_feed_billing_closes.saldo_inicial_*`, `cc_traspaso_deuda_links` (from / to line). The
   facturación rows' `facturado_usd*` and `usd_rate_*` become per-currency entries;
   `usdDebtPaymentsForAccount`, `isCcUsdPaymentLine`, `usdPaymentLineClpResolver` take the
   currency (13 files). The issuer's `statement_currencies` already names them.
4. *Bank side done 2026-11-12* (no migration; AGENTS.md «Historical mirror pairs», «The bank's own deposit-account balances», «A foreign checking account's rows», «The dollar account's feed confirms the ledger»): checking mirror pairs pair two `withdrawal` / `deposit` rows of one currency on cash ledgers held in it (an `fx_purchase` credit never pairs) and convert to a transfer in that currency; the balance snapshots, `bank_account_numbers` and the product summary take any currency of `currencies`, judged to its coin; the foreign checking accounts (any declared `cash_currency` ≠ pesos under Checking accounts) give gastos, income and refund lines in their own currency priced through `rates.ts`; a `bank_account.movements` listing in any currency but pesos is confirmed (`confirmForeignAccountMovements`). CLP / USD mirror candidates, bank checks, expense lines, gastos, income, flows overview, deposits and reconciliation byte-identical on a copy of the 2026-11-12 database (the mirror leg DTO renamed `amount_clp` → `amount` + `currency`). Leftovers: the merge columns keep their `_clp` names; the dollar deposit reconciliation stays dollar-only; the import batch kind is still `usd_account_feed`; the session's listings are Santander's pesos and dollars only.
   *Cards done 2026-11-12:* the divisas tier pairs a peso debit
   with the card's ABONO DE DIVISAS in any foreign currency, inside 0,5×–2× that currency's mid rate
   on the abono's day, and converts to the cross-currency `pago_tarjeta` shape (a `pago_tarjeta`,
   not `fx_exchange`: the deposit readers and the paid-rate readers key on it); the evidence key
   counts a foreign amount in its smallest coin. The divisas tier of `ccPaymentMirrors.ts` pairs any foreign
   debt bought with pesos; checking mirror pairs pair two rows of the same currency; the bank
   balance checks and `bank_account_numbers` take any declared currency.
5. **Market.** (Storage and the adapter done 2026-11-12, migration 315: `market_symbols`,
   `equity_daily` and `live_market_quotes` reference `currencies`, an index is a NULL currency.) The Yahoo adapter accepts any currency `currencies` holds (pence still refused);
   `holdingPriceAt` converts any quote through `rates.ts`; dividends and splits in any currency.
   *Dividends and splits done 2026-11-12:* the benchmark total return reads any quote currency
   `currencies` holds (an index throws naming it); a dividend breakdown takes any currency code and
   Racional's (which states none) takes its movement's; splits never named a currency.
6. **Live rates.** The poll and the price stream carry every core pair, not only `CLP=X`
   (EUR/USD live, so a euro holding moves during the day). *Done 2026-11-12* (migration 323; see
   «Live rates» above and AGENTS.md «Every core pair has a live rate»).
7. **Done 2026-11-12** (the guard's baseline is empty and removed; rules 8–12 fail on every
   unannotated hit). **Type unions.** The remaining `"clp" | "usd"` literals (about 50 server files, 13 contract,
   8 ingest, 4 client) become `CurrencyCode`, file by file as the steps above reach them; the
   guard's allowlist shrinks to what stays native by nature.
   Counts before → after (unannotated): currency-formatter 287 → 0, unit-literal-compare 301 → 0,
   dto-currency-key 289 → 0, currency-type-union 117 → 0, currency-list-literal 7 → 0. Fixed:
   display-unit and home-vs-foreign comparisons ask `isHomeCurrency` (about 60 server sites, 30
   client; `HOME_CURRENCY` moved to the contracts so both share it); the perf tables and the flow
   legs format through `formatMoney`; the fund-series currency check reads `currencies`
   (`isLoadedCurrency`); the milestone `level_currency` and the bank cupo status's currency are
   any code. Native, each line annotated with its reason: the F22 (pesos by law; a foreign
   document's dollars beside them) and the 1040 (dollars by law); the card billing frame
   (facturado, cuotas, cupo, the modal totals) and the mortgage (UF paid in pesos); cartolas,
   receipts, place bills (pesos); the Santander feed, statement JSON, receipts, product summary
   and the manual card-payment task (a peso and a dollar side); the parsed-PDF corpus (clp/ and
   usd/ folders); Chilean cuota products (pesos); Fintual / Racional cash and mails (pesos and
   dollars); payslips (a liquidación pesos, a US stub dollars); declared payments (pesos or UF);
   the UF as an index; «pesos have no minor unit» checks; the demo story; the movement create API
   (pesos, dollars, euros); the panel's cash form (plan C1 leftover). In the client a native
   figure formats through a named wrapper in `formatNative.ts`. All 115 captured payloads (CLP,
   USD, EUR) and the tax capture byte-identical on a copy of the 2026-11-12 database (only
   `/api/sync/status`'s clock differed, as between two baseline captures). Leftovers needing real
   work, not annotation: the `_clp` DTO keys of the card billing frame, upcoming payments, real
   estate and payroll stay pesos by design; `BigGroupUsage.total_clp` and the gastos / income
   month rows (Phase A item 3) still want one value in the unit; `CreditCardSummaryCards` and
   `DeptoAccountSummaryCards` draw pesos in every unit (Phase A item 6); the Santander pipelines and
   the planted-payment and traspaso legs keep their peso/dollar unions until C3's leftovers move.

Order: A (the guard first), then B, then C1 → C7; C3 is the largest and can split by table.
