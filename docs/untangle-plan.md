# Untangle plan: decision log (2026-11-06, merged 2026-11-07)

This is the one plan. It merges the app-wide untangle pass with
`docs/expense-identity-plan.md` (committed in `b00d88ca`), which this plan supersedes: the
expense plan's phases now live under F9 (stable expense identity), F10 (purchases module),
F11 (conversion keeps the line), F12 (row controls) and F20 (expense links).

Steps 1–3 of the untangle pass at HEAD `0347e461`. Nothing in the code has changed yet
apart from the expense plan's first pass (inline cuotas input and row-owned delete,
`b00d88ca`).
Steps 4 (fix) and 5 (check and repeat) come later. The user chose both extras for
step 4: **Comments** (remove comments that only restate the code) and **Tests** (remove
tests that wouldn't catch a real bug, fix the ones that fail without one). Do the extras
last, after the structural fixes, because the tests are the regression net.

Paths are relative to `server/src/` unless they start with `client/`, `ingest/`,
`server/contracts/` or `server/scripts/`. Line numbers are as of `0347e461`.

## The shape today

- **Server:** 524 files in one flat folder (`server/src/`), about 120k lines, with one
  **186-file import cycle**. `accountBucket.ts`, `fxRates.ts`, `movementTransfer.ts`,
  `ccBillingBalances.ts`, `movementBalanceCashAccounts.ts` and `aggregationCache.ts` each
  reach **309 files** transitively.
  - The main glue is `aggregationCache.ts:1,17-22`: the cache imports the modules it caches
    for (`checkingCartolaBalances`, `markSeriesStore`, `creditCardTree`,
    `portfolioGroupIndex`, and a type from `valuationTimeseries`). So every module that
    imports `historyTierMemo` pulls in the whole server.
  - The second glue is `accountBucket.ts:1-2`, which imports `portfolioGroupTree`.
- **Client:** a 9-file cycle (`navChartBuckets`, `navCardBreakdown`, `dashboardCardBreakdown`,
  `portfolioNavDashboardCards`, `groupPageShellFromNav`, `queries/hooks`,
  `useGroupInfoConsolidatedTables`, `portfolioDashboardBuckets`, `portfolioNavFromApi`).
  It is closed by a type declared in a hook file and by `hooks.ts:21` importing a placeholder
  builder.
- **Git co-change since 2026-08-01:**
  - `client/src/types/*` changed together with `server/src` in 118 of 119 commits.
  - `client/src/queries/keys.ts`, `hooks.ts` and `api.ts` changed together in 54 of 56 commits.
  - `index.ts` changed with `aggregationCache.ts` in 8 of 24 commits.
  - `GroupInfoPage` changed with `LiabilitiesGroupPage` in 38 of 50 commits.
  - `dashboardNavCardMetrics` changed with `dashboardAccounts` in 10 commits.
  - `ccBillingViews` changed with `ccBillingBalances` in 9 commits.

## Vocabulary (decided 2026-11-07)

A noun audit found the same words meaning several things (flow, deposit, contribution,
payment, purchase, split, entry, line) and the same things carrying several names. The model
below fixes the vocabulary that F9, F10 and F20 build on.

- **flow** — the base unit for money entering your net worth, moving between your accounts, or
  leaving it. It is one row with `from` and `to`, where each end is an account or an **outside
  party** (employer, merchant, family, the State, a bank, or «other / unknown»; one table that
  absorbs the vendor catalog, transfer counterparties, payslip employers and receipt payees).
  It carries the amount and currency on each side, units on each side (a stock buy, an AFP fund
  switch), and the bank's posting day on each side. There is no separate leg table. A flow may
  have **parts** (see F20).
- **kind** — what happened: salary, purchase, refund, card payment, transfer, pension
  cotización, state bonus, dividend, interest, fee, mortgage cuota, tax refund, return of
  capital, airdrop, opening balance, … Each kind belongs to one **class**: capital, return, cost, spending,
  income, internal or opening balance. A plain transfer takes its class from `from`/`to`.
- **cost vs spending** — cost is only what an account charges for holding money (broker fees,
  the AFP commission, card financing charges and plan interest). Everything you pay for is
  spending, tax and health included. Pre-tax or post-tax is not a field: it follows from
  `from` (health withheld on the payslip goes from the pre-tax account; the months paid out of
  pocket go from checking, same kind and category). Today's `pre_tax` flag on payslip lines and
  the Expenses page's «Include pre-tax expenses» box become a filter on the pre-tax account.
- **event** — a fact about an instrument that changes the units or identity of everyone who
  holds it, with no value moving: split, reverse split, bonus shares, ticker change, share-class
  conversion, the exchange ratio of a share-for-share merger, the units side of a spin-off
  (which also carries the cost-basis share for tax lots). One row per instrument, however many
  accounts hold it (`equity_splits` is already that table, generalised to an `instrument_events`
  table); each holder's unit change and the tax lots are derived from it, with no per-account
  row. Anything that moves value is a flow instead: a cash buyout or delisting payout is a sale,
  a return of capital is a flow whose kind lowers cost basis, an airdrop comes from outside as
  return, a fund merging or switched by law is a transfer between the two holdings (like the
  AFP fund switch), and the cash part of a mixed merger is a flow beside its event.
- **in / out / internal** — derived from `from`/`to` relative to any account or group, never
  stored. **Deposits** of a scope are the capital flows coming in, **withdrawals** the capital
  flows going out, and **P/L = Δvalue − capital flows**. Return (interest) is P/L; cost is
  neither P/L nor capital and is shown as its own figure per account.
- **evidence** — the documents recording a flow. The flow's amount, date and merchant follow
  the most trusted one: **statement**, then **bank listing** (the feed or a paste, which are
  the same listing, one fetched and one copied; a fuller merchant beats a cut one), then
  **manual**. The user's category, note and big group never move.
- **movement** — retired as a concept; today's `movements` rows become flows.
- **contribution / aporte** — not a term any more. A pension cotización and the state bonus
  are flows with their own kinds; seen from the retirement group they are deposits.
- **payment** — only money that pays a debt (card, mortgage, upcoming). A cuota a statement
  bills is a **cuota**, a processor or shop document is a **receipt**.
- **split** — only a stock split. A user's division of a flow is its **parts**.
- **place** — today's `expense_accounts`.

How the domains map:
- **Card purchase:** a flow from the card to outside on the purchase day, at the full
  principal (owed rises, the cash bucket drops). A card payment is a flow from checking to the
  card. Cuotas are only billing (when the bank asks to be paid) and the «Por cuota» spending
  view; the interest inside a plan is a cost flow on the purchase day. A nota de crédito is a
  refund from outside to the card that points at the purchase it annuls; the pair drops out of
  spending.
- **Payroll:** the employer pays the gross into a **pre-tax account** (a new «Pre-tax» bucket
  under Efectivo, next to checking and reserves). On the pay day it pays the net to checking,
  the cotización and AFC to the pension accounts (internal transfers), and tax and health to
  outside (spending). Everything is dated on the pay day, so its balance is 0 at the
  end of each payslip day.
- **Dividends:** a flow from the stock account to its broker's cash (as today), so the stock's
  return includes its dividend and the group sees it as internal. **Interest** comes from
  outside into cash and is return.
- **Opening balances** (checking anchors, the first valuations of old accounts): kind opening
  balance, kept out of deposits and P/L.
- **Units-only moves that move value** (AFC cartola true-ups, crypto send fees, the units-only
  `cash_fee` / `savings_earnings` rows) are cost or return flows with units and no money.
  A stock split is an event, not a flow: today's per-holder `stock_split` movements go.

## Bugs found along the way (verify, then fixed by the structural fixes below)

1. **UF series keep peso closes for cash.** `groupMonthlyPerfConsolidation.ts:242-248,268-270,303-305`
   compute the close as `unit === "usd" ? … : clp`, so the CLP cash, checking and cuenta de
   ahorro closes stay in pesos inside a UF series. Their flows are converted (:201). → F5.
2. **Refund marks are deleted when the cartola replaces a daily row.**
   `checking_expense_refunds.movement_id` is `ON DELETE CASCADE` (migration 217).
   `checkingCartolaPartialReconcile.ts:175,191` carries only the income state. The row's
   big group (`checking-mv:<id>`), its pieces and any manual deposit links are lost the same
   way. → F9.
3. **Deleting a card line from the UI skips the valuation re-sync and the stamp purge.**
   `ccStatementLineDelete.ts:11-42` only recomputes balances. AGENTS.md requires both steps
   on line deletions. → F11.
4. **The mark-input triggers miss four tables that marks read:** `cc_owed_anchors`,
   `cc_header_payment_legs`, `cc_feed_billing_closes` and `credit_card_account_config`
   (`markInputChangeTriggers211.ts:56-95`). → F2.
5. **The mark-input listener does not drop the monthly families.**
   `aggregationCache.ts:394-414` leaves out `account.monthly_perf|`,
   `group.consolidated_monthly|` and `group.valuation_closing_by_date|`, which the other
   funnels drop. → F2.
6. **`totals.liabilities_usd` is always 0** (`dashboardPagePayload.ts:41,122`). The client
   rebuilds it with another formula in `client/src/queries/fetchers.ts:95-141`. → F4, F12.
7. **A CMR web paste throws.** `ccWebPasteParse.ts:252` has no `cmr` entry. → F10.
8. **Twin outflows collapse into one claim.** `flowsCheckingGastos.ts:536`
   `netWorthCapitalLedgerOutflowPairKey` keys by account|day|pesos, the rule AGENTS.md says
   was dropped on 2026-09-28. Used by the reconciliation, `budaWallet.ts:172` and
   `flowsCheckingInflows.ts:269`. → F9.
9. **Demo payslips are checked against the wrong pension cap.** `demoData/render.ts:293`
   (cap table to 2022, then 81.6) disagrees with `demoData/simulate.ts:315` (to 2026). → F15.
10. **The demo's IGC table is incomplete.** `demoData/simulate.ts:596` stops at 30.4% (no
    35%/40% brackets), so the APV regime choice is wrong above 120 UTA. → F15.
11. **The shell fallback runner has fallen behind.** `ingest/daily-run.sh` lacks about 10
    steps the TS runner gained: AFC, AFP UNO, payslips/Buk/Previred, the mortgage sheet and
    card check, transfer mails, payment receipts, utility bills and the Fintual wallet.
    `switch-schedule.sh to-launchd` would silently drop them. → F13.
12. **Six mail fetchers use a raw IMAP `SINCE`**, exposed to the DST blind-day bug that
    `email/fetch.ts:179` fixed for brokers only: `santanderDocs.ts:185`, `liderBoletas.ts:60`,
    `liderStatements.ts:73`, `fintualDocs.ts:92`, `appleMail.ts:25`, `afcCartolas.ts:69`.
    → F13.
13. **Some edits don't refresh «Últimos gastos».** Manual expense save/delete and line
    pieces skip `latestExpensesAll` (`client/src/queries/mutations.ts:683,695,708`); the
    category, note and big-group edits do invalidate it. → F12.
14. **The mortgage cuota day is 10 in some places and 11 in others.**
    `ingestRunPolicy.ts:188` (11), `mortgageUfReminder.ts:32` (11), `mortgageUfReminder.ts:259`
    (`-10`), `upcomingPayments.ts:49` (10), `demoData/simulate.ts:845` (10). → F3.
15. **Card and flows routes turn every throw into a 400.** `routes/creditCard.ts` has about
    10 such handlers and `routes/flows.ts` has 27, so integrity throws never reach the JSON
    500 middleware. → F1.
16. **Every non-GET `/api` request empties the response caches and triggers a full warm**,
    including the ingest heartbeat (once a minute), deploy-agent polls, run reports and
    mark-read (`index.ts:101-120`). → F2.
17. **Converting a one-shot card line to cuotas deletes the line.**
    `convertStatementLineToInstallmentPurchase` deletes the statement line and creates a
    manual plan; removing a wrongly converted plan (`deleteManualCcInstallmentPurchase`)
    restores nothing, so the expense vanishes from the ledger and from gastos. A wrong count
    is editable (`PATCH /cc-purchases/:id`), a wrong conversion is not reversible. → F11.

## Fixes, each above the problems it solves

### F1 — Domain folders and one dependency direction

Lay `server/src` out by domain, with a declared direction: `core` (db, dates, formats,
rates, config) → `model` (account profiles, the nav tree) → domains (`cards`, `flows`,
`valuation`, `pensions`, `brokers`, `tax`, `payroll`, `realEstate`, `market`, `ingest`)
→ `views` (payload builders) → `http`. Every fix below moves its code into place. Add a
dependency check, the depcruise-style script used here, to `check:conventions`.

- The flat 524-file folder hides which files make up a feature.
- The 186-file cycle and the 309-file reach of core modules.
- The cache imports domain modules (`aggregationCache.ts:1,17-22`); `accountBucket.ts:1`
  imports the tree.
- `liveMarketQuotesSchedulerPolicy.ts:11` is a "pure" policy file that imports the sync module.
- The migration hooks in `db.ts:8-20` import live domain code (vendor matching), so
  migration 252 depends on the current code version. Freeze hook logic inside the hook.
- `usageDb.ts:6-7` imports `demoMode.ts`, which pulls in the demo generator; use the leaf
  `demoModeFlag.ts`.
- `ccYearMonth.ts:12` `addCalendarMonths` is a generic helper used by 24 non-card files.
- `ccExpenseCategories.ts` (1352 lines) is the general expense-category module, imported
  by 37 files, and it imports the installment ledger.
- `f22Draft.ts` (650 lines) exports `igcTax`, which `payslipChecks.ts:21` and
  `demoData/simulate.ts:7` import.
- `foreignShareTaxGains.ts:55` `monthBeforeYmd` is imported by five tax modules.
- `globalSyncAll.ts:89,104,115` and `globalSyncStale.ts:57` import runtime code from
  `server/scripts/`.
- Card and flows routes catch everything and answer 400 (bug 15). Only validated input
  should map to 400.
- The cycle `ccBillingBalances` ↔ `ccBillingViews` ↔ `ccOpenWebPastePdfReconcile`.
- `ccBillingBalances.ts` mixes the evidence stream, fx-date rules, open credits, the header
  facturado, the snapshot writer and a config writer (`:928`).

### F2 — Declared cache dependencies; the trigger log is the only write signal

Each cache family registers once: its key builder, the tables it reads, its account scope,
its live inputs, and whether an API write drops it. Invalidation walks that registry. The
mark-input log, applied after every write transaction, replaces hand calls.
`getAggregationCached` owns promise eviction, the in-transaction check and the
serialization mark. Trigger specs are frozen per migration, and each spec carries its own
reach-back and dependency rules.

- About 20 prefix strings are spelled again in about 15 files, for example
  `deptoLedgerFromMovements.ts:84`, `flowsOverview.ts:857`, `dailyReferenceLines.ts:60`
  and the `cc.billing_detail|` satellites (`ccBillingBalances.ts:296`,
  `ccCuotaRetirement.ts:66`, `ccInstallmentInterest.ts:49`, `ccOwedWalk.ts:181`).
- The all-time-high memo borrows the `daily.overview|` name to share its lifetime
  (`netWorthAllTimeHigh.ts:119`).
- There are three hand-listed funnels (`aggregationCache.ts:394-414,423-446,595-616`), and
  they have drifted (bug 5). `invalidateCcBillingDetail` is in fact the universal write funnel.
- A fourth funnel lives in the HTTP entry point (`index.ts:101-120`) and drops on machine
  traffic (bug 16).
- Writers invalidate by hand: `invalidateAggregationForAccountDate` (34 calls in 17 files),
  `clearCheckingBalanceCache` (27 calls in 12 files), and the market writers' own
  `invalidateMarketDataAggregations` calls (`globalSyncAll.ts:454,588,1387,1404`,
  `watchlist.ts:330`, `equitySplitsSync.ts:27`, `routes/market.ts:155`).
- Card tables are written without invalidation and rely on the caller:
  `ccBillingCloses.ts:134`, `ccFacturadoFinancingLinksDb`, `ccPlantedPayments`,
  `santanderBankCupo`, `ccStatementJsonSource`.
- Missing trigger tables (bug 4). The global sync state JSON is a valuation input that no
  trigger covers, hence `fintualValuationStateFingerprint` (`globalSyncAll.ts:1394-1405`).
- `flowsMortgageCarrying.ts:110-116` uses the cache as a fingerprint store.
- Each schema change replays today's spec list through old hooks with version filters
  (`markInputChangeTriggers211.ts:300-365`, `db.ts:240-260`). `SOURCE_RULES`
  (`markInputChanges.ts:69-82`) is a second table-keyed list that silently falls back to `{}`.
- `markInputChanges.ts:112` special-cases `{property, mortgage}` at the infra layer.
- The change log is pruned only when the warmer starts (`markInputChanges.ts:206`), so it
  grows without bound when `CACHE_WARM_ENABLED=0`.
- Promise-cache-and-evict is written three times (`dashboardPageBundle.ts:44`,
  `dashboardAccounts.ts:578`, `accountDetailBundle.ts:66`); one rejection discards every page.
- Unrelated responses share the bundle prefix just to inherit its lifetime
  (`aggregationCache.ts:280-340`, `sidebarNavChartBuckets.ts:64`, `dashboardAccounts.ts:260`).
- Each caller enforces "never cache inside a transaction" (`dashboardAccounts.ts:259`,
  `accountDetailBundle.ts:64`, `aggregationCache.ts:153,195,316`).
- Ad hoc caches outside the system: the checking 30 s TTL memo
  (`checkingCartolaBalances.ts:19-31`), group colours (`chartColorRgb.ts:83,183-188`, never
  cleared on balance change), `liabilitiesValuation.ts:22-51`, and
  `assetGroupTree.ts:125-180,244`.
- Hardcoded `["clp","usd","uf"]` (`aggregationCache.ts:523,531,681`) and nav slugs
  (`:500,667-672`).
- Serialization marking is opt-in per caller (`groupDailySeriesResponse.ts:43,210`,
  `creditCardGroupLedger.ts:344`, `creditCardInstallments.ts:313`).
- Six single-slot listeners are wired as import side effects (`dbStateMemo.ts:20`,
  `markInputChanges.ts:39,56`, `aggregationCache.ts:113`, `jobQueueSignal.ts:8`,
  `demoMarketActivity.ts:38`); the rate-independence resolver too
  (`accountMarkDailyCache.ts:59-67`).
- Three detectors of external writes: the warmer's `data_version` poll, the per-lookup
  check, and the mark-input log.
- Dimming changes are noticed only from the live-quotes tick (`syncDimmingWatch.ts:15`),
  and invalidate+publish is paired by hand (`liveMarketQuotesSync.ts:276-285`).
- Dead: deletes of families nothing builds (`account.month_close|`,
  `dashboard.portfolio_totals|`), `setAggregationCached`, and stale comments
  (`aggregationCache.ts:366-376`, `accountMarkDailyCache.ts:25`).

### F3 — One account profile, resolved once

Each account resolves once, memoized and invalidated by F2, to a profile: kind, holding
(currency or instrument), side (asset/debt), price source, quantity function, flow source,
book carry, whether today is valued differently, perf builder, and its **roles**
(checking member, broker cash per currency, the loan of property P with lender pattern
and cuota day, Buda wallet, Fintual goal with its series and public serie). Every value
stack, kind dispatch and role lookup reads the profile.

- There are five value ladders with different orders:
  - `accountMarkClpAtYmd.ts:110-250`
  - `accountTodayValue.ts:86-185`, with AFC ledger-first and AFP stored-first
  - `accountPosition.ts:217-350`
  - `valuationTimeseries.ts:402-429,832-854,1046-1100`
  - `liabilitiesValuation.ts:68-95` and `liabilityTree.ts:225-245`
- `isMarkValued` is written twice with different lists (`valuationTimeseries.ts:846-851`
  vs `:1080-1088`), and there is yet another list in `patchAccountLiveLastPoint` (`:801-808`).
- The kind → valuation rules are encoded three times (`holdings.ts:57-83`,
  `cuotaLedgerAccounts.ts:31-35`, `accountMarkClpAtYmd.ts:117-148`).
- Property and mortgage are said to hold UF (`holdings.ts:50-55`) but are valued in CLP
  (`accountValue.ts:57-65`, `accountMarkClpAtYmd.ts:189`).
- The liability check is copied: `holdings.ts:108`, `accountBucket.ts:51`,
  `valuationTimeseries.ts:179`, inline at `accountMarkClpAtYmd.ts:234`,
  `accountTodayValue.ts:166,179` and `dashboardAccounts.ts:371,414`.
- "No flow carry on liabilities" is enforced at three call sites instead of in
  `storedMarkFlowCarry.ts:15`.
- Four encodings of which coin (`accountPosition.ts:243,419`, `holdings.ts:60`,
  `cryptoValuation.ts:24-35,177`), and three crypto-account tests
  (`foreignShareTaxGains.ts:100`, `budaWallet.ts:44-47`, `cryptoValuation.ts:43`). Use
  `market_symbols.market_kind`.
- Two cash predicates for one fact (`accountTodayValue.ts:113,118` vs
  `accountMarkClpAtYmd.ts:153,157`). The USD predicate lives in `movementTransfer.ts:298-306`.
- The accounts⋈asset_groups lookup is repeated about 12 times
  (`accountMarkClpAtYmd.ts:67-79`, `accountPerformance.ts:304,709`,
  `valuationTimeseries.ts:316-353,779,2046`, `valuationLatest.ts:30`, …).
  `bucketSlugForAccount` and `bucketSlugForAccountId` are twins.
- Callers thread slug/import_key/name into `accountTodayValue.ts:199-230`.
- `monthlyPerfRowsForAccount` (`groupMonthlyPerfConsolidation.ts:323-346`) is another kind
  dispatch; `:340` hardcodes `cuenta_ahorro_vivienda`. There are three live-month policies
  (`:172-176,308`).
- The liability branch block is written three times in `accountPerformance.ts`
  (`:179-272`, `:340-482`, `:882-905`).
- `accountPosition.ts:64-66`: the `afp_override_*` fields carry every kind;
  `positionMarkFromMeta` (`:413-436`) has per-kind acceptance rules.
- The depto ledger is a singleton:
  - `deptoLedgerFromMovements.ts:48,58-66` (hardcoded import key, `LIMIT 1`).
  - `deptoAccountMarkClpAtYmd(kind)` takes no account id.
  - `valuationTimeseries.ts:932-951,1060` assumes one property; `dailySeries.ts:252-254`
    takes `mortgageIds[0]`; `dailyReferenceLines.ts:107-109` requires exactly one mortgage.
  - `accountDetailBundle.ts:208-212`, `mortgagePaymentCreate.ts:32-33,57`.
  - The legacy keys are copied at `loanPayments258.ts:25`, `seedLiabilitiesTree.ts:64` and
    `demoData/generate.ts:118-119`.
- Lenders are hardcoded (`expenseDepositLinks.ts:121-128`); the mortgage merchant SQL
  matches `%TOKU%` alone (`mortgageUfReminder.ts:186`, `mortgagePaymentCardMatch.ts:66`).
  The cuota day disagrees (bug 14).
- Roles are found by legacy import keys and private SQL in 13 files
  (`racionalMovementsImport.ts:47`, `fintualCertV2Reconcile` ×4, `mortgagePaymentCreate.ts:62,70`,
  `budaWallet.ts:22,41`, `racionalEmailImport.ts:47,68` with the legacy
  `import:excel|key=cuenta_corriente`, …). `FINTUAL_USD_IMPORT_KEY` is defined three times
  (`brokerDividendStatementApply.ts:32`, `fintualEmailImport.ts:37`,
  `fintualWalletInterestApply.ts:17`).
- Fintual goal tables: six parallel maps in two files (`fintualCertV2.ts:11-45`,
  `fintualPublicSeriePrice.ts:31-39`). The Risky Norris series set is copied six times
  (`riskyNorrisProxyMtm.ts:27-37`, `watchlistComposite.ts:21,51`,
  `fintualRiskyNorrisComposition.ts:245`, `marketSeries.ts:13`,
  `fintualPublicSeriePrice.ts:35-38`, `fintualCertV2.ts:35-36`).
- There are two definitions of "checking accounts" (`movementBalanceCashAccounts.ts:77` vs
  `:131`, with legacy fallbacks at `:96,138-160`).
- The `{afp, afc}`, `dap` and investment-bucket sets are copied (`flowsDeposits.ts:66,103`,
  `movementMirrorPairs.ts:100,103`, `flowsDepositsReconciliation.ts:144,150`,
  `checkingCartolaLoaders.ts:207`, `flowsPl.ts:28`, `checkingDescriptionPredicates.ts:22,38`).
- `payslipChecks.ts:20` imports the tree just to identify AFP credits; the USD contract is
  exempted by `liquido_currency` (`payslipChecks.ts:67-69`, `payrollTaxYear.ts:70`).
- Demo-only fallbacks in production valuation: `cuotaLedgerAccounts.ts:30-34` (AFP without
  a series → UNO-A) and `accountPosition.ts:333`.
- `afpUnoOfficialSync.ts:45-53` hardwires `uno`/`A`; it should follow the live account's
  `fund_series_key`, before the 2027 fund switch.
- The client re-derives labels, tickers and units kinds: `client/src/navAccountLabels.ts:4-29`
  (branches on notes), `client/src/pages/accountDetail/shared.ts:12-30` (`movementUnitsKind`
  always answers "shares"), and `kindFromBucketSlug` ×2.

### F4 — One loaded nav tree with roles as data

Load `portfolio_groups` once, with the Pasivos subtree attached at load time and the roles
as columns: nw bucket, investment root, `nets_linked_group_id`, property overlay, chart host.
Expose `nwBuckets()`, `bucketOfAccount()`, `investmentRoots()`, `node.accountIds({forTotals,
includeInactive})`, `nodeValue(node, date, unit)` (Σ account values + declared netting,
with one null and round rule, plus a series form) and `pageChartPlan(slug)`, which reads
no valuation. Bucket totals become `Record<slug, Amount>`. Keep asset groups only as the
behaviour kind and stop parsing `__`.

- The four NW buckets are a hardcoded literal in nine places (`assetGroupTree.ts:116`,
  `dashboardNavCardMetrics.ts:141`, `groupChartBuckets.ts:32`, `dashboardAccounts.ts:54`,
  `dashboardPagePayload.ts:23`, `portfolioGroupTree.ts:210`, `portfolioGroupValueAtDate.ts:18`,
  `valuationTimeseries.ts:2014`, `client/src/portfolioDashboardBuckets.ts:5`), plus wide
  per-bucket, per-unit payload fields. Net worth is the literal sum of the four buckets in
  three places.
- Five answers to "account → bucket" (`assetGroupTree.ts:127-180`,
  `portfolioGroupTree.ts:216-228,263-297`, `dashboardNavCardMetrics.ts:154-160`,
  `accountDetailBundle.ts:107-113`). "Deepest group" is computed by slug length instead of
  `primary_portfolio_group_id`.
- Two trees for one hierarchy: membership is regenerated from asset_groups every boot
  (`seedNavTree.ts:168-185,237-289`) while runtime still reads asset_groups by `LIKE`
  (`liabilityTabAccounts.ts:37`, `creditCardTree.ts:13`, `valuationTimeseries.ts:2094-2124`).
  The retirement subtree is hand-listed (`seedNavTree.ts:201-224`); the seed swallows errors
  (`:128-140,836-889`); retired slugs are deleted on every boot (`:66-67`).
  `SEED_ASSET_GROUPS` (`db.ts:131-175`) is a hand dump.
- Membership is read five ways (`navTree.ts:166-186`, `dashboardNavCardMetrics.ts:458-480`,
  `groupChartBuckets.ts:203-223`, `navContextScope.ts:31-35`, navValueMap).
  `listAccountsForGroupTab` is a third source with legacy filters, and
  `dashboardComposition.ts:79-133` asserts the two sources agree.
  `portfolioGroupTree.ts:84-112` vs `:118-140` walk twice with different specials.
- Three "card masters" queries (`creditCardTree.ts:7-21`, `liabilityTabAccounts.ts:8-24`,
  `liabilityTree.ts:204-215`, the last without the superseded filter). The mortgage tab is
  picked by asset slug.
- Pasivos is spliced in by slug in three functions (`navTree.ts:397-478`), with lookup
  orders that disagree (`sidebarNavChartBuckets.ts:24-29`, `navContextScope.ts:40-46`).
  Root order is a convention (`dashboardNavCardMetrics.ts:684-692,828-857`). Two prune copies.
- Cash ↔ card netting is declared as data (`seedNavTree.ts:787-793`) but decided by slug in
  about ten places (`portfolioGroupValueAtDate.ts:105,127,260,300`,
  `valuationTimeseries.ts:1511,1707,1752`, `dashboardNavCardMetrics.ts:440-445`,
  `groupMonthlyPerfConsolidation.ts:566`, `dailyReferenceLines.ts:65-85`,
  `assetGroupTree.ts:102-108`, `liabilityTree.ts:210`, `cashEqsBucketNet.ts:63-66`,
  `dashboardPagePayload.ts:52-56`, `dashboardAccounts.ts:600-606`). A missing USD rate is
  handled three ways.
- The "Σ marks + net cards + round" loop is written six times (`portfolioGroupValueAtDate.ts:62-76,213-269,279-315`,
  `dashboardChartMarkTotals.ts:59-129`, `dashboardComposition.ts:180-206`,
  `dashboardOverviewDaily.ts:67-92`).
- One node has two values: card vs value map (`dashboardNavCardMetrics.ts:659-680` vs
  `navValueMap.ts:350-390`); consolidated-else-marks fallbacks (`portfolioGroupValueAtDate.ts:100-131`);
  non-finite counted as 0 (`:150-158`); today's USD point from a different path
  (`dashboardOverviewDaily.ts:111-129`).
- Shares are computed in CLP "because they are unit-invariant"
  (`dashboardComposition.ts:221-224`, `dashboardOverviewDaily.ts:132-133`), which
  contradicts the holdings side rule.
- "Inversiones = retirement + brokerage" is restated about seven times
  (`portfolioGroupTree.ts:231`, `netWorthConsolidation.ts:23`, `inversionesPerfSeries.ts:41-252`,
  `projections.ts:219-222`, `dashboardOverviewDaily.ts:128`, `routes/shared.ts:15`,
  `groupConsolidatedTables.ts:45-66`).
- The grouped-chart emission decision is written four times (`groupChartBuckets.ts:310-320`,
  `valuationTimeseries.ts:2262-2280`, `groupMonthlyPlSeries.ts:188-202`,
  `groupDailySeriesResponse.ts:55-73`) plus client copies (`client/src/navChartBuckets.ts:13-46`,
  `client/src/portfolioNavFromApi.ts:126-214`). There are three "flatten a hub" rules.
  The chart plan imports marks and the clock (`groupChartBuckets.ts:1-3,89-120`,
  `groupTabOrdering.ts:22-52`), and so does nav building (`navTree.ts:200-205,260-262`).
- The property overlay has three triggers (`groupDailySeriesResponse.ts:159-162,233`,
  `valuationTimeseries.ts:2353`). Coverage is built twice. The chart hosts are hardcoded
  (`portfolioGroupReference.ts:13-20`) though `chart_host_slug` is in the DB.
- Dead synthetic-id colour tables are copied on both sides (`chartColorRgb.ts:201-262`,
  `client/src/chartColors.ts:390-469`).
- Identity and pass-throughs: `portfolioGroupSlugForDashboardBucket`,
  `seriesAccountIdForGroupTab`, `consolidatedRowsForScope`. The legacy `group=`/`subgroup=`
  surface is unused by the client (`portfolioGroupTree.ts:299-344`, routes/dashboard,
  accounts, benchmarks, `GroupInfoBase.tsx:40`).
- `wealthPercentile.ts:9-12,129-130` relies on the property account storing net equity.
- `projections.ts:20-21` hardcodes the birth month and retirement age.

### F5 — Quantity × price × convert is the only value path; `rates.ts` the only conversion

Delete the producers that build pesos first, and make today just "today's price". Give
`rates.ts` a flow side (buy rate and UF per event) and move `TsUnit` there. Compute card
owed natively per currency and derive every frame from shared terms.

- Instrument price is computed in three places with different fallbacks
  (`accountPosition.ts:145-215,304-305`, `holdingPrices.ts:61-104`,
  `computeEquityMtmClp`/`computeCryptoMtmClp`), each with its own memo.
  `accountPosition.ts:187-192,273-278` duplicate `equityCloseEod`;
  `accountPosition.ts:239` drops `now`.
- Peso-first producers sit beside the native path: the `afp_override_*` marks,
  `valuationRawClpForAccount`, `monthEndCloseForPerformance` (`accountPerformance.ts:513-618`),
  `accountValueInUnitFromClp` wrapped three times, `usdCashBalanceClpAt`, and the chart
  building pesos then discarding them (`valuationTimeseries.ts:1100-1104`).
- Two flow-conversion rules: `convertTs` at the mid (`clpToUnitAt.ts:14-25`, used by
  `accountPerformance.ts:84-93`, `dailySeries.ts:552,585,641`,
  `groupMonthlyPerfConsolidation.ts:201`, `periodReturnsShortHorizon.ts:146`) vs
  `flowEventInUnit` at the buy rate.
- `netDepositFlowWindows` (`flowsDeposits.ts:254-288`) takes only clp|usd, so UF callers
  convert the window sum at the window end (five copies). Bug 1.
- `convertTs` returns pesos unchanged when the UF row is missing (`clpToUnitAt.ts:22`).
- `usdCashAccounts.ts:22-36` has its own sell-rate rule; `benchmarkComparison.ts:126-159`
  hand-rolls fx; `flowsOverviewCash.ts:99-127` converts with its own `fxRowOnOrBefore`.
- `fxRates.ts:59-66` has a fallback that can never run; the only live fallback reads a rate
  dated after the date asked. `monthEndOnly` has no callers.
- `valuationLatest.ts:75-89` falls back to a row dated after today.
- The CLP-leg SQL is copied inline (`flowsDepositsReconciliation.ts:197,276`,
  `flowsCheckingIncomeOverrides.ts:217`, `ccPaymentMirrors.ts:176`,
  `equityBrokerageCapitalFlows.ts:41`, `exportWorkbook.ts:121-127`).
- Card owed is computed five ways that share no terms (`ccOwedWalk.ts:131,147`,
  `ccOwedByCurrency.ts:60`, `ccBillingViews.ts:619`, `ccInstallmentDebtDaily.ts:310`, the
  live formula). The per-currency split runs through a mutable global (`ccExpenseAmountClp.ts:9-35`,
  set at `ccBillingViews.ts:624`) and three fake rates. `facturadoFromStatement` is copied
  three times (`ccBillingViews.ts:276-330,1050-1072`).
- `creditCardGroupLedger.ts:69-107` merges with `{...prev}` plus listed fields, so a new
  field takes the first member's value.
- `clpToUnitAt.ts:2` imports `TsUnit` from the 2600-line `valuationTimeseries.ts`, which
  re-exports `convertTs` back.

### F6 — One P/L kernel with days as atoms

`(value legs, flow events, kind sign rule) → day P/L`. Months, years and windows are
folds over days. The liability and card rules live in it once.

- "P/L = Δvalue − flow, flowAdjustedPct, endChargedFlow, groupStartFrameFlow" is written
  four times (`dailySeries.ts:579-588,650-675`, `groupMonthlyPerfConsolidation.ts:381-480`,
  `accountPerformance` reanchor + live row, `periodReturnsShortHorizon.ts:134-164`).
  `dailyPerfLevels.ts:46-68` re-anchors daily onto monthly because they don't add up.
- Four loops bucket deposit events into windows (`dailySeries.ts:187-268,294`,
  `flowsDeposits.ts:267`, `valuationTimeseries.ts:287`).
- The card flow identity is written twice (`dailySeries.ts:270-288`, `accountPerformance.ts:554-576`),
  and so are the mortgage flows (`dailySeries.ts:243-256`, `accountPerformance.ts:131-142`).
  Section-3 charges are summed twice (`creditCardPerformancePl.ts:17`,
  `ccFinancingCostDaily.ts:37`), held equal only by a verify script.
- `pickMonthlyPerfRowsByMonth` duplicates `collapseMonthlyPerfDuplicateCalendarMonths`
  (`accountPeriodMetrics.ts:13-35` vs `accountPerformance.ts:275-296`).
- Compounding is written three times (`benchmarkLevels.ts:253-272`, `periodPctDailyChain.ts:36-55`,
  `inversionesPerfSeries.ts:220-237`).
- `accountPerformance.ts:621-659` keeps a stale copy of the share-units flow kinds (missing
  `stock_split`). Share counts are computed twice (`brokerageFlowMovement.ts:55`,
  `brokerageEquityMtm.ts:77`), and so is the split ratio (`equityTaxLotEvents.ts:63-72` vs
  `equitySplits.ts`). The crypto and AFP inflow queries ignore transfer legs (`:661-697`).

### F7 — One shared formats module (in `server/contracts`)

Numbers (Chilean and US), dd/mm/yy, Spanish month names, RUT, account number, accent
folding, Chile-day arithmetic, merchant normalization, ISO and cents validators, MIME/HTML
text. Server, ingest and contracts import it; Python keeps only what the PDF parsers need,
pinned by case files in `server/contracts/data`.

- Chilean numbers: three sanctioned copies (`chileanNumber.ts`,
  `ingest/src/formats/chileanNumber.ts`, `ingest/python/statement_values.py:63,90`), plus
  ad hoc readers:
  - `brokerEmail.ts:152,163`
  - nine payment decoders
  - about 13 inline `.replace(/\./g,"")` copies across ingest
  - server copies: `syncRunLog.ts:133`, `afcCicSeries.ts:66-75`, `ufSiiSync.ts:23`,
    `bcentralApi.ts:57,67`
  - `ccStatementsImport.ts:19` guesses the style from separators (forbidden);
    `ccStatementImportReconcile.ts:84` swallows bad input to 0
- Dates: the ddMmYy copies, `checkingMovements.ts:43`, `cuentaVistaWebPasteParse.ts:11` (the
  cuenta-vista paste is still decoded on the server). `statementLineDateIso` has six local
  copies in card modules; `isoFromField` is written three times. About 14 private addDays and
  about 12 day-difference helpers (`checkingDescriptionPredicates.ts:196,203` return 999 on a
  bad date), although `chileCalendarAddDays` exists. The client `calendarMonth.ts` already
  diverges from the server's.
- Spanish month tables ×10; three HTML strippers; decodeEntities ×2; NFD folding in 17 files.
- RUT and account-number normalizers disagree (`bankTransferNotices.ts:46`,
  `utilityBillsApply.ts:74`, `vendorCatalogMatch.ts:42`, `bankAccountMovementsApply.ts:12`,
  `incomingWires.ts:67`, `bankAccountBalances.ts:22`).
- Merchant normalization: six trim/upper copies in card modules, « (T)» stripped three times,
  the Mercado Pago prefix twice, five or more merchant folds, a hardcoded 15 in place of
  `WEB_PASTE_MERCHANT_TRUNCATION_WIDTH` (`ccFeedCuotaPurchases.ts:71`).
- Contract validators: cents ×5, gross − withholding = net ×2, inline ISO regexes.
- `.env` is parsed three ways (`ingest/src/rootDotenv.ts:6`, `ingest/src/serverApi.ts:22`, the
  server's).

### F8 — Contracts own every shared schema, the client DTOs included

The API DTOs come from `server/contracts` (shared or generated) and carry a
`schema_version`. One client cache helper keys and validates on that version. Shared config
and file schemas (`cc-cards.json`, the line rules, the parser CSV columns, the Python →
TS JSON outputs) get a JSON Schema that Python validates against.

- `client/src/types/*` (3.5k lines) is a hand copy of the server DTOs (118 of 119 commits co-change).
- Four localStorage cache conventions with hand-bumped versions
  (`client/src/queries/dashboardNavSnapshotCache.ts:53-81`, now v16 with 13 legacy sweeps;
  `sidebarNavCache.ts:4`; `groupPageShellCache.ts:5,36`; `panelCache.ts` plus versions at
  call sites). There are also retired-key sweeps on boot.
- `ingest/python/cc_cards.py:23` mirrors `ccCardRegistry.ts:46`. The TS type lists
  Python-only keys and the server reads a `cfraser/` file at module load
  (`ccCardRegistry.ts:13-57`).
- The statement line rules JSON has a loader and predicates in each language
  (`ccStatementLineRules.ts:36`, `ingest/python/cc_statement_line_rules.py:45-125`).
- `CARD_PARSED_STATEMENT_COLUMNS` (`server/contracts/src/kinds/cardParsedStatements.ts:13`)
  must equal the Python `CSV_COLUMNS` and `demoData/render.ts` records.
- `ParsedPayrollRow`, `ParsedCheckingCartola` (×2: `ingest/src/santander/checkingCartolaXlsx.ts:88`,
  `checkingCartolaParse.ts:41`), grocery `parsed.json` and the mortgage sheet are re-declared
  across languages with no schema. The cartola saldo identity is written three times.
  `ingest/src/formats/commaCsv.ts` is a copy.
- The `X-Live-Inputs` grammar is copied in `client/src/liveInputs.ts`. The beacon path is
  hardcoded in `client/src/usagePageTiming.ts:20`. The i18n key lists are kept in sync by
  grep (`client/src/sidebarNavFromApi.ts:13-44`). `LIVE_DASHBOARD_REFETCH_MS` must match a
  server default.
- The processor slug is a free string in the contract
  (`server/contracts/src/kinds/paymentProcessorReceipts.ts:89`) while the server branches on
  slugs in nine tables (`paymentProcessorReceipts.ts:281-417,695`, `expenseDisplayNames.ts:83,90`).
  App Store has two slugs (`apple_app_store` vs `app_store`).

### F9 — One flow table with a stable id, documents as evidence

**The model** (see «Vocabulary»): every flow has a stable id. Documents (a pasted line, a feed
row, a statement line, a cartola row, a bank mail, a manual entry) are evidence attached to
it. A plan is a schedule overlay on a card purchase flow. Parts and links hang off the flow,
not off a source (F20). Scope, in one pass: today's `movements`, card statement and listing
lines, manual expenses (`expense_entries`), income (payslips, income overrides), and the
legacy `income_entries`. Today's `movements` already has the right shape (from, to, amount and
counter amount, units on each side), so it becomes the flow table, gaining the outside-party
ends, the kind's class and the evidence link; card lines become flows from the card to
outside.

A key derived from the document alone is not enough: it changes when a pending line is
restated (new date, amount or merchant), so the carry code would shrink but never go away,
and every new line-keyed table would still need adding to each mover. But adopting evidence
into an expense reliably needs a typed key module and provenance in columns, or the matching
would still parse strings in ~40 places. So those two are the first steps toward the entity:

1. **Typed key module** (pure refactor). One module builds and parses all ~12 key
   families. The legacy-key runtime fallbacks (`ccExpenseCategories.ts:297-370,413,996-1060`)
   are resolved in a migration and then fail loudly instead of guessing.
2. **Structured provenance columns.** A statement `source_kind` replaces the five `source_pdf`
   predicates (~40 prefix tests). The cartola movement identity, the deposit-match result,
   the mail and feed provenance and the AFC/Fintual row roles move out of notes into columns.
3. **Flow and evidence tables.** The flow table (id assigned at first sight) holds card,
   checking, manual and income flows; sources attach as evidence rows. Each existing
   assignment key becomes a flow whose first evidence is that legacy key, so every current
   assignment maps 1:1 with nothing lost. The outside-party table is created here from the
   vendor catalog, transfer counterparties, employers and receipt payees. Migrate the assignment tables (categories, «Único»
   rows, notes, big groups, line splits, real-estate links and rejections, deposit links,
   checking refunds, financing links) one at a time, as migration 235 did for big groups.
   Start with the checking ones hit by bugs 2 and 8: refunds, big groups, pieces, deposit links.
4. **Adoption on arrival.** A closing facturación, a cartola or a bank mail attaches its
   evidence to the existing flow instead of deleting and recreating it (precedent: the
   manual-to-pdf plan conversion when it is the contract's only row). Whether an expense is
   manual, feed or statement is derived from its evidence, never stored text.
5. **Delete the three re-key movers** (`ccExpenseCategoryPersist`, `ccExpenseLineRekey`,
   `checkingGastosCategoryPersist`), `carryCcExpenseAssignments`,
   `transferCheckingGastosCategoryFromMovementToNote` and `carryMovementKeyedIncomeState`,
   once no table references a line key.

**Matching: the same recognisers, a different outcome.** The candidate rules stay: the
bucket-to-statement reconcile (`webPasteLineMatchesStatementLine`: merchant, amount, date
within a day), the rekey ladder (`parser_row_id`, then identity, then twins in id order),
and checking's windows (signed amount, bank posting day, the daily row's note key, a
mail-written movement by exact signed pesos from the mail's day to six days after). They run
on F17's pairing helper. What changes:

- **The match is stored** as «this evidence belongs to flow X» and re-found through that
  record on every re-import. The identity ladder runs once per arriving piece of evidence, and
  again only when the parser changes a row's identity.
- **Ambiguity fails loudly.** After adoption a wrong guess merges two flows for good, so an
  ambiguous match is reported and left unpaired until resolved. Identical twins, where order
  cannot matter, are the one exception.
- **Each field has a declared authority.** Amount, date and merchant: statement over bank
  listing (feed or paste) over manual. The user's category, note, big group and parts never move.
- **Unmatched evidence has a defined state.** A bucket line inside the closed cycle that
  matches nothing retires its flow, unless a fuzzier rule pairs it with the statement's
  differently worded line. One outside the cycle re-targets to the next facturación. A later
  cycle's line needs nothing. The explicit carry cases («CONVENIO P.A.T.» → «SEG AUTO
  SANTANDER») become match rules with a fallback.
- **Every non-trivial pairing is reported** (fuzzy, restated, ambiguous) in the import result.

A closed facturación keeps replacing a bucket line and a manual plan with the statement's own
(the existing reconcile) until step 4 lands.

What the expense plan found in the same area:
- An expense's identity is whatever its source document calls it; 39 server files touch
  `purchase_key`, and every change of source (bucket line settled by its statement, manual
  plan replaced by its statement twin, daily checking row replaced by its cartola row,
  mail-written movement replaced by the bank's listing, re-import with a new `parser_row_id`)
  deletes and recreates the row and needs carry code afterwards.

- About 12 key families (`installment-h:`, `installment-pr:`, `installment:`, `line-pr:`,
  `line:`, `line-fallback:`, `checking-mv:`, `checking-cartola:`, mirror, `manual:`, `payslip:`,
  `#split:`) are built and parsed with `startsWith` in about 15 files. `installment-h:`,
  `line-fallback:` (with different normalizations), `manual:` and `#split:` are each built
  twice. `expenseDepositLinks.ts:606` parses `line-pr:` by its length in SQL.
  `ccExpenseCategories.ts:297-370,413,996-1060` tries legacy keys at runtime and silently
  falls back. `expenseCategoryRules.ts:29,54` duplicates its key format.
- `statement_line_id` means six different ids by producer (`ccExpensePurchaseKey.ts:24-66`).
- Three re-key mechanisms run in the same import (`ccExpenseCategoryPersist` snapshot/restore,
  `ccExpenseLineRekey`, `checkingGastosCategoryPersist`). Each new line-keyed table must be
  added to each mover (`ccExpenseLineRekey.ts:193`). The two real-estate-link movers have
  opposite conflict policies. Bugs 2 and 8.
- `expenseDepositLinks.ts:601` writes categories by volatile line id on every build.
- About 40 sites test `source_pdf` prefixes (`import:web-paste`, `|open|`,
  `import:santander-json|`), and five predicates share one body (`isPdfStatementSource`,
  `isRealStatement`, `isWebPasteSource`, `isWebPasteStatementSource`, and the different
  `isCcStatementPdfSource`). Exported prefix constants go unused.
- `auto:deposit-match|…` is written into the user's note and parsed back into links
  (`ccExpenseDepositMatchNotes.ts:17`, `expenseDepositLinks.ts:530,645`;
  `client/src/components/.../CreditCardDepositMatchedExpensesTable.tsx:20` branches on it).
- The cartola identity lives in the note (`checkingCartolaParse.ts:94,114,131`,
  `checkingDescriptionPredicates.ts:250,271`, `backfillCheckingAutoMatchCategories.ts:57-75`),
  as does the daily-feed grammar (`checkingCartolaPartialReconcile.ts:28`). The anchor `LIKE`
  is repeated in five files, the mail-rebuilt prefixes three times, and
  `checkingCartolaLoaders.ts:139` re-encodes a predicate in SQL.
  `accountImports.ts:320` replaces a month by note `LIKE`.
- Rows are identified by note: `budaWallet.ts:93`, `afcCertImport.ts:157,177,389,409,436`,
  `fintualCertImport.ts:146`, `groceryBranchLearning.ts:32,145` (raw_line prefix),
  `flowsManualExpenses.ts:67` (merchant taken from the note).
- `groceryReceiptKey` is written twice (`storeReceiptApply.ts:137-145`, `groceryReceiptKey178.ts`).

### F10 — One facturación module, one line classifier, issuer rules as data

A read-only `cards/facturacion` module owns cycle membership: closes, cycle bounds,
open/closed/provisional months, purchase → month, statement → month, lines → month and
first-cuota timing. One line classifier stamps each expense line with its kind (payment,
section 3, cuota reference, saldo inicial, refund, internal, spending) and its counts per
mode; every consumer reads the stamp. `CC_ISSUERS` holds every issuer rule (paste sign,
close-day offset, first-cuota timing per kind, section-3 layouts, reconcile tolerances, paste
card_group), keyed only by `config.issuer`. One lifecycle field replaces the four notions of
a dead card. Bank-description rules become one data table, with own-account identity read
from `bank_account_numbers`.

**One purchases module (the read side, expense plan phase 1).** `effectiveCardPurchases(accountId)`
(name decided by the audit below) returns each purchase as a plain one-shot line, a line with a
plan overlay, or a plan with no line (statement-owned plans, plans converted before F11's
change). Each reader asks for its own view: debt events, expenses, billed. The rule «a line
that has a plan counts once» lives only here. The interface is generic (an expense with its
evidence); the card version adds the plan overlay and checking adds none. Build cards first,
but the shape must fit checking, or F9 step 3 becomes a rewrite. Build it in F1's target
folder, not in `ccExpenseCategories.ts`. Migrate readers one at a time with payloads
byte-checked on a real-DB copy. A guard test fails when a reader sums `cc_statement_lines` or
`cc_installment_purchases` directly. It is done when no reader filters the two tables itself.

**Audit first (shared with F9, read-only).** List every reader of lines and plans and what it
needs: debt events (owed walk), billed estimate, cupo, gastos (Total and Por cuota), the
facturación proxy, schedules, checking gastos, income, deposit matching. The output is a
table in this file. It decides the module's API and shows which readers genuinely need a raw
table.

**`kind` is stored on the flow; the classifier keeps only what depends on mode or context.**
The flow's kind (and through it its class: capital, return, cost, spending, income, internal,
opening balance) is fixed at import or by the user: on cards it is derived once at import
from the sign and wording; on checking a credit's kind is the user's mark, which replaces
`checking_expense_refunds` and `checking_income_movement_overrides`. `movements.flow_kind`,
`markCardRefunds`, `isGastosRefundLine`, `markFinancingCostLines` and the separate kind
taxonomies (`MovementFlowType`, `DepositFlowKind`, `BrokerageFlowKind`, `MortgageFlowKind`,
`CryptoMovementKind`, `IncomeKind`, `CheckingIncomeKind`, `CcExpenseLineRole`) collapse into
the one kind list. A refund may point at the purchase it annuls (F20). The line classifier
keeps everything that depends on mode or context (counts per installment mode, the modal
section) and reads the stored kind; it never re-derives it. F19's deletions in this area
(`loadCheckingExpenseRefundMovementIds`, the wrappers) wait for the column.

- Facturación rules are spread over five modules (`ccManualBillingMonth.ts:1-274`,
  `ccBillingCloses.ts:307`, `ccBillingMonth.ts:62`, `ccOpenWebPastePdfReconcile.ts:356`,
  `ccInstallmentLedgerDb.ts:179`) with at least three statement-month rules
  (`ccBillingMonth.ts:39,48`, `ccInstallmentStatementMonth.ts:5,18`, `ccStatementsDb.ts:107`
  bypassed by raw SQL readers).
- The calendar month is misused as the billing month (`ccFacturadoFinancingAuto.ts:89`,
  `ccFacturadoFinancingProjectionLines.ts:75`, `ccInstallmentPaymentGastosLines.ts:160-163`,
  `ccBillingBalances.ts:820`, `ccManualBillingMonth.ts:204-210`, `ccBillingInactive.ts:41`).
- `purchaseFirstDueYm` has fallbacks to `"1970-01"`, plus an index-less cuota shortcut
  (`ccInstallmentLedgerDb.ts:189-243`). The BCI first-cuota rule exists only in comments.
  Three writers of `first_due_month` must each pair it by hand.
- The config cycle serves as both bucket identity and close estimate, is user-editable, and
  is read by eight modules with their own SQL, which disagree on a missing row
  (`ccBillingMonth.ts:22-36` defaults, `ccIssuerForAccount.ts:17` throws). The close offset
  is inferred with `?? 1` (`ccBillingCloses.ts:339`). The loop bounds are hardcoded
  (`ccManualBillingMonth.ts:110,166`).
- Payment predicates ×5 (`ccPaymentLines.ts:8,41`, `ccUsdStatementBilled.ts:9`,
  `ccPlantedPayments.ts:104`, `flowsExpenses.ts:1127`), plus SQL copies of the JSON rules
  (`ccPaymentMirrorEvidence.ts:113`, `ccTraspasoDeudaLinks.ts:48`) and writers that
  hardcode "PAGO"/"ABONO DE DIVISAS". The cuota-reference and saldo-inicial predicates sit
  outside the rules (`ccWebPasteParse.ts:85,95`, `ccInstallmentLineDedupe.ts:27-60`).
- "Counts toward gastos" has about six partial copies (`flowsExpensesGastos.ts:145`,
  `ccExpensePeriodMonth.ts:92`, `realEstateExpenseMatching.ts:44`, `ccExpenseCategories.ts:61,72`,
  `movementMirrorPairs.ts:115`, `flowsOverview.ts:187`, `additionalCardReimbursements.ts:68`).
  The mortgage-link probe plus carrying split is written five times
  (`flowsExpensesGastos.ts:216`, `flowsOverview.ts:195,224`, `flowsMortgageCarrying.ts:62`,
  `ccFacturadoFinancingProjectionLines.ts:235`). There are client copies
  (`client/src/ccExpenseLineBuckets.ts:4-27,110-168`,
  `client/src/components/.../CreditCardExpenseMonthModalSections.tsx:45-138`).
- Checking descriptions: four regex unions for "own transfer"
  (`checkingDescriptionPredicates.ts:137,153,300,315`). `INTERNAL_TRANSFER_RE` (`:64`)
  hardcodes the owner's name. `CC_PAYMENT_DESC_RE` sits beside `isCcPaymentMerchant`. A
  duplicate Fintual regex appears at `:84,87`. The DAP bounds are fitted to single documents
  (`:181-188`). `fondo_reserva` has its own matching mode (`flowsCheckingGastos.ts:335,832`).
  `DepositMatchCandidate.category_slug` holds account kinds.
- The issuer is encoded six ways (config, card_group strings, parser_layout prefix,
  import_key, registry last4s, `santanderAccountMap.ts:69`). `card_group ?? "A"` appears in
  about ten places. The paste-group compatibility rule exists in one module only
  (`ccManualInstallmentStatementReconcile.ts:417-469`). `isSantanderWebPasteGroup` keys the
  sign on card_group. Bug 7.
- A dead card means four different things (`ccBillingInactive.ts:25`, `ccNavRetired.ts:4`,
  `ccConsolidatedCards.ts:36-50`, `accountChartInactive`), used inconsistently.
- Reconcile tolerances depend on the issuer (`ccStatementImportReconcile.ts:247,293,357`).
  `ccStatementSection3.ts:89-97` detects the issuer from the layout.
- `ccCrossImportDedupe.ts:52,81`: a single-merchant special (`plazaLyonMerchantsMatch`),
  and BCI suffix stripping applied to every issuer.
- Mortgage card merchants (see F3).
- 44 server files read `cc_statement_lines` and 21 read `cc_installment_purchases`, each
  filtering on its own. The one shared list (`pendingCuotaPurchaseLines`,
  `schedulePurchases`; 28 references) covers only part of it.

### F11 — Write funnels per aggregate, and a pure read pipeline

Each aggregate gets one write funnel (card lines inserted, deleted or replaced; movements;
expense assignments). The funnel reads evidence dates, carries assignments, guards payment
evidence, upserts valuations and recomputes once, then lets F2 invalidate. Dedupe, mirror,
planted, recurring and manual modules only *plan* changes. The expense-line pipeline
becomes a declared, typed sequence of pure steps. Deposit-link, category and mirror syncing
move into the write funnels, so a GET never writes.

**Conversion to cuotas keeps the line (expense plan phase 2, bug 17).** It runs through the
card-line funnel. The plan links to its line (`source_line_id` on the plan, or
`converted_plan_id` on the line); conversion creates the plan and no longer deletes the line
(precedent: a bucket line tagged with `cuota_purchase_kind` stays on file and counts as
installment debt until its plan arrives). F10's purchases module resolves line + plan to one
expense: debt counted once, gastos «Total» shows the line once at full price, the «N cuotas»
detail comes from the plan. Undo = delete the plan; the link goes with it and the line is live
again with its category, note and big group untouched. Count edit = the existing PATCH. Expense
lines carry `installment_purchase_id` and `installment_source`, so a row knows whether its plan
is editable (`manual`) or frozen (statement-owned). Plans converted before this have no line to
link and stay as they are. Done when convert, change count and remove are lossless on a copy of
the real DB.

- The delete sequence is repeated by hand (`ccCrossImportDedupe.ts:413-438`,
  `ccFeedMirror.ts:175-178`, `ccInstallmentManual.ts:195-243` in two orders, `accountImports.ts:107-117`,
  three scripts). Bug 3.
- One feed import recomputes three or four times (`ccInstallmentLedgerMerge.ts:456-461,616-631`,
  `accountImports.ts:112-116`, `cardUnbilledMovementsApply.ts:246-247`).
- Post-write hooks are split by entry point (`ccInstallmentLedgerMerge.ts:560-640`,
  `accountImports.ts:97-108`, `cardUnbilledMovementsApply.ts:230-271`); a PDF import skips the
  bucket hooks.
- `carryCcExpenseAssignments` is called by hand in four places. The payment-evidence guard
  protects only two of the delete paths.
- `ccInstallmentPaymentBackfill.ts:35-133` runs on every merge, synthesizing payments with
  an interpolated pay-by, a median amount and a `"2000-01-01"` default.
- Decorator order is load-bearing but stated only in comments (`flowsExpenses.ts:1032-1046`).
  The no-cards branch is a different pipeline (`:1159-1177`).
  `syncExpenseDepositLinksFromGastosLines` writes during a GET (`:1034`,
  `expenseDepositLinks.ts:601,793-810`). Mirror drafts load before the re-sync (`:1175`).
- `realEstateExpenseMatching.ts:65` builds the whole Expenses payload to filter lines,
  reached from `upcomingPayments` and `utilityBillsApply`.
  `ingestHandlers.ts:222` does the same on every receipt send.
- Cartola: one document, three apply paths (`bankAccountStatementsApply.ts:61`,
  `accountImports.ts:258,303`); the uploads skip `finishCartolaImportRun` and the
  count-based replace rule.
- There are two category-assign implementations (`flowsCheckingGastos.ts:172`,
  `ccExpenseCategories.ts:1294`).

### F12 — The client renders; server shapes, resources and page hooks are declared once

The server sends what the client derives: per line, its period month, modal section and
counts flags; per view, its stack order; per nav node, its breakdown lines (property gross,
mortgage pairing), card/hub role, route and opened value-map children; per series, its role
and colour; per account, its label, ticker and units kind. On the client, each query is one
**resource definition** (key + fetch + entity length + what invalidates it), and mutations
declare the resources they touch. There is one `usePortfolioPageData`/surface hook built on
`queryShowsLoading`, one column table that renders both desktop and mobile, and one
`usePersistedPref` with one period type.

**Expense rows own their controls (expense plan phase 3).** The server sends per-line
capability flags (`can_delete`, `can_make_installment`, `can_edit_installment`,
`can_edit_pieces`) instead of the row reading `ln.web_paste` and the source. The cuotas
control sits on the row for plain lines and manual plans (convert, edit the count, remove);
statement-owned plans and facturado lines show only the note. The «Compra en cuotas · N
cuotas» superscript leaves the full-price row and «N cuotas» goes in the ⓘ card (reuse
`installmentPurchaseTotalLabel`, shortened to «{{count}} cuotas»); per-cuota rows keep
`3/6 · $270.000`. «Desglosar» (pieces) moves into the row so every surface has it, the
dashboard included (today only the expenses month modal passes `onEditPieces`); pieces stay
off installment lines. Already done in `b00d88ca`: the inline count input next to the
«¿cuántas?» prompt (modal removed), and Delete and convert owned by the row
(`DeleteLineButton`, `CuotasInline`).

- The client copies of rules listed under F4 and F10. Also:
  - `client/src/ccExpensePeriodMonth.ts` ("keep in sync", half dead)
  - `ccExpenseCategories.ts:103-139` (stack order)
  - `fetchers.ts:89-141` (sums rows and rebuilds totals, bug 6)
  - `dashboardCardBreakdown.ts:139-158,256-330` (property gross on the client, mortgage
    matched by name)
  - `ValueTreemap.tsx:34-47`
  - `pages/accountDetail/shared.ts:42-45` (`mayHavePeriodReturns`, already differs from the server)
  - `ProductConfigPanel.tsx:18`, `GroceriesPage.tsx:23`
  - `i18n/index.ts:54-74` and the bucket and category lists in five files
  - `chartColors.ts:280-477` (colours by name substring, special ids)
  - `portfolioDashboardBuckets.ts:5-50` (route table)
  - `App.tsx:127-160` routes duplicate `route_path`; two route deny-lists disagree
  - slug branches in `liabilitiesPageKind.ts`, `LiabilitiesGroupPage.tsx:136-140,485,499`,
    `portfolioNavDashboardCards.ts:54-186`, `PortfolioNavChildDetailCards.tsx:56`,
    `PortfolioNavEntityCardsStrip.tsx:180`, `groupPageChartViews.ts:36-47`
  - `client/src/ccYearlyRollup.ts:52,83`, `ccDailyHistorial.ts:28`
  - the reference-line predicate is written twice (`chartColors.ts:328-332`,
    `ValuationLineCharts.tsx:678-682`)
- The keys/hooks/api triple (56 commits). The `entityKeyLength` magic numbers
  (`displayUnitQueries.ts:45`). The flows filter fields are spelled out six times on the
  client (`hooks.ts:802-870`, `api.ts:370-445`) plus once on the server. There are 27 inline
  keys, some stale (`EntityColorPicker.tsx:35-40`). Invalidation lists disagree (bug 13,
  `mutations.ts:93-101,585`). Mutations live in two files. The `"nw-messages-read"` window
  event is redundant. Errors are swallowed in two places (`fetchers.ts:177`,
  `useGroupInfoConsolidatedTables.ts:72-76`). Redundant polling (`displayUnitQueries.ts:48`,
  `hooks.ts:340`). The client-build reload rides on the price poll. `api.ts:42-110` has two
  error paths.
- `GroupInfoPage.tsx:116-200`, `LiabilitiesGroupPage.tsx:120-190` and
  `DashboardPage.tsx:134-182` share a drifting 70-line block. The loading predicate is
  inlined in about ten files. "Diario waits for its own payload" is written five times.
  Surface ids fall back to `"pending"`.
- There are 18 hand-paired desktop/mobile tables (TaxReturnPage, GroceriesPage,
  MirrorPairsPanelPage, CreditCardSections + CreditCardPurchaseMobileCard with hardcoded
  colSpans), next to the newer responsive row lists.
- Four localStorage pref hooks; a raw `"open"` value written into the JSON surface namespace
  (`PortfolioNavAccountsSummaryTable.tsx:114`); four period unions and three clamps.
- `GroupInfoBase.tsx:30-100`: eight dashboard-only props, two props with no caller, one
  always-true prop.
- The 9-file cycle.

### F13 — Ingest: one receiver framework, one mail fetcher, structured run steps

The ingest route stores each envelope's ref + hash once, applies one duplicate/conflict
rule, and runs dry-run at the request level inside a rolled-back transaction. It returns a
typed outcome with a retry flag, so handlers no longer pick statuses. Mail fetching has one
fetcher (All Mail, DST-safe `SINCE`, ledger, attachments) and one staged-file sender; sources
only declare predicates. Steps return structured results instead of stdout regexes and
decision files. Retire the shell fallback. Inside the server, card sources share one
canonical debt-positive line model, converted from the parser CSV once in ingest. One
resolver maps a document to its account.

- The store-once rule is written five ways with two error channels
  (`bankTransferNotices.ts:452`, `incomingWires.ts:182`, `paymentProcessorReceipts.ts:122`,
  `utilityBillsApply.ts:188`, `merchantPurchaseDocumentApply.ts:74`). `bankAccountBalances.ts:29`
  doesn't compare the payload.
- Statuses are decided per handler from different signals (`ingestHandlers.ts:110-255`). The
  feeder reads `details` (`ingest/src/santander/importPaymentReceiptsMain.ts:56`).
- `apply` is a field inside 13 payloads, with five dry-run strategies
  (`afcCertImport.ts:525,631`, `mortgageSheetPaymentsApply.ts:55,213`,
  `fintualCertImport.ts:296`, `cardStatementApply.ts:156`, `incomingWires.ts:439-443`, …).
- DB ids and one-time options inside a document contract
  (`server/contracts/src/kinds/unemploymentFundDocuments.ts:77,84`). `recheck` serves one task;
  `cc_manual_payment` sits outside `INGEST_TASK_NAMES`.
- `broker.movements` dispatches on `broker === "fintual"` (`ingestHandlers.ts:179`,
  `brokerMovements.ts:104`).
- The loopback/bearer check exists on both sides (`ingestAuth.ts:27,34`,
  `ingest/src/service/feederServer.ts:43,51`). Ports are hardcoded on both sides. The timeout
  table has one entry.
- Seven IMAP fetchers re-implement what `archiveMails` already generalizes; `SINCE` is raw
  (bug 12); mailbox choice varies; `DEFAULT_WINDOW_DAYS = 45` ×6. The generic archiver lives
  in a Santander-named file, and generic MIME helpers in `santanderDocs.ts:100,147`. The
  send → archive loop is rewritten per Main, with `imported/` vs `processed/` drift.
- Runners: `ingest/src/runner/nightly.ts:5` claims parity with `daily-run.sh` (bug 11).
  `runnerScripts.ts:9` uses pgrep as a mutex. Step gates are regexes over child stdout
  (`ingest/src/runner/hourly.ts:32-50`, `steps.ts:73`, matching `console.log` lines in five
  producers). A decision is passed through a file (`runRequest.ts:54`). The Santander gap is
  written three times with two values (`ingestRunPolicy.ts:95`, `ingest/src/runner/runRequest.ts:19`,
  `ingest/src/runGuard.ts:14`). There are 44 pass-through root npm scripts. A new nightly
  input spans about ten files.
- Canonical card kinds are converted back to bank and parser shapes: the sign round trip
  (`cardListingLines.ts:18`, `ccPaymentLines.ts:81,85`), every source turned into
  `CcStatementCsvRecord` (`santanderStatementImport.ts:119`, `ccWebPasteParse.ts:145`,
  `demoData/render.ts`), and `card.parsed_statements` as a second kind for one concept.
  Contract enums are remapped (`cardListingLines.ts:6`).
- Five account resolvers for documents (`bankAccountMovementsApply.ts:31,37`,
  `santanderAccountMap.ts`, the AFC payload `account_id`, `liveAfpUnoAccountId`).
- `ingest/src/grocery/stagedReceipts.ts` must know the server's ownership rule.

### F14 — One scheduler kernel, one source table, one config module

One scheduler kernel provides wall-clock slots or intervals, suspend detection, a network
grace period, a bounded retry budget, an in-flight guard, and enabled/awake gates. Sync
sources become one data table from which the union type, arrays, status rows, schedule
and runner are derived, with one generic business-day publisher schedule
(`{publishHour, lagBusinessDays}`). There is one outbound fetch helper with policy (UA,
timeout, decode, gate) and one typed config module that parses each env var once with one
truthiness rule and a defined default order. A deployment profile is injected at boot
instead of demo checks in leaf modules. Job kinds own their dispatcher, resources and
ingest-kind mapping.

- There are two wake/retry implementations (`globalSyncSchedulerPolicy.ts:17-79`,
  `liveMarketQuotesSchedulerPolicy.ts:13-58`) and two scheduler shells
  (`globalSyncScheduler.ts:239-311`, `liveMarketQuotesScheduler.ts:64-131`). Four wake
  strategies run on one machine. Two 30 s intervals drive one queue
  (`ingestRunScheduler.ts:46`, `jobQueueExecutor.ts:33`). The backfill and the dimming check
  ride on the quotes tick.
- Each sync source is named in at least five places (`globalSyncStale.ts:88,105,186,414-447,620-770`,
  `syncSourceSchedule.ts:326`, `globalSyncAll.ts:1337`, a CHECK constraint).
  `globalSyncAll.ts` is 1,414 lines and imports 35 modules. `shouldRunSyncSource` is a
  wrapper.
- The SP schedule is written twice (`afpUnoOfficialSync.ts:62-110` ≡ `afcCicSeries.ts:218-268`);
  publisher lag three times (`globalSyncStale.ts:246-262,545-570,584-596`); the 18:00 constant
  three times (`afcCicSeries.ts:38`, `afpUnoOfficialSync.ts:37`, `fintualPublishDate.ts:10`),
  with a per-source `if` map (`globalSyncStale.ts:599-603`) and per-source state fields.
- Fetch boilerplate is repeated in eight sync modules, with raw `fetch` calls, duplicate
  Yahoo UAs and URLs, and SP fetch twins (`afcCicSeries.ts:134-150`, `spAfpFundUnits.ts:136-150`).
- `globalSyncAll.ts:972-996`: UF from SII when BCentral is incomplete, with no provenance,
  and swallowed errors. A dead guard (`sbifSyncDb.ts:185-199`). An ignored option
  (`sbifMonthlyPublication.ts:58`). `sbifApiGate.ts:25-84` swallows errors, sleeps
  in-process, and keeps its state in a file.
- About 65 env vars are parsed by five or more helpers (`globalSyncScheduler.ts:94-104`,
  `liveMarketQuotesConfig.ts:7-25`, `sbifApiGate.ts:44`, `serverLog.ts:12-20`,
  `backgroundJobsEnv.ts:22`, `usageLog.ts:53`). "Off" is spelled four ways. The umbrella list
  drifts (`backgroundJobsEnv.ts:14-20`). The demo and background defaults race on call order
  (`index.ts:55-60`). Some flags are read once, others re-read `.env` live.
- Demo checks are spread through leaf modules (`demoMarketActivity.ts:17` in every scheduler,
  `globalSyncStale.ts:193,767`, `afpUnoOfficialSync.ts:47`, `afcCicSeries.ts:208-210` vs
  `DEMO_SYNC_DISABLED_SOURCES`).
- The job-kind ↔ ingest-kind mapping is written four times (`ingestRunScheduler.ts:159-167`,
  `jobQueueExecutor.ts:52-58`, `jobQueueView.ts:69,121,135`, `jobQueue.ts:23-24`).
  Resource strings are duplicated. `max_attempts` is never read. The executor depends on the
  ingest flag (`jobQueueExecutor.ts:104`) and uses `if (isIngestJob)` despite a dispatch
  field (`:95-96`). Run extras touch four places and import domain applies
  (`ingestRunScheduler.ts:22-24,120-136`). `sweepLostIngestRuns` still runs for pre-queue
  rows. There are stale comments (`ingestRunScheduler.ts:264`).
- Seven middlewares each classify requests their own way (`apiRequestsInFlight.ts:46-51`,
  `usageLog.ts:244-252`, `liveInputsHeader.ts:19-23`, `jsonResponse.ts:141`,
  `httpSecurity.ts:51-52`, `demoAnalytics.ts:190-196`, `index.ts:103-105`). Untyped
  `res.locals` side channels (`jsonResponse.ts:126`, `liveInputsHeader.ts:28,42`) make the
  middleware order load-bearing. The serializer sets the live-inputs header (`jsonResponse.ts:3,108`).
- The warmers re-list client queries and route strings (`visitedPagesWarm.ts:56-205`,
  `rentabilidadDailyWarm.ts:23`); `usageDb.ts:18` applies a migration outside the runner.
- `client/src/useLiveQuotesStampInvalidation.ts:34-35` (see F12).

### F15 — Legal parameters as one dated source; the demo calls the real writers

Put the IGC and IUSC tables, the caps, the AFP/AFC/health/mandatory rates, the IMM, the
independent contributions and the reajuste rounding in one leaf module or table. One
reajuste service (`ipcReajustePct`, `decemberReajuste → {toMonth, provisional}`) lives with
`siiOfficialIpc.ts`, and the F22 identities live in one place. The demo generator
computes with that source, writes its Previred parameters from it, and calls the real
writers and rules (`commitMortgagePayment`, `derivedPayByIso`, `billingMonthContainingPurchase`,
the key builders, the Buda wallet by key, the series-key helpers).

- The demo copies rules:
  - pension caps ×2 (bug 9)
  - payslip arithmetic (`simulate.ts:1283-1316` vs `payslipChecks.ts:105-133`)
  - AFP rates (`simulate.ts:322`, `render.ts:305-309`)
  - IGC (bug 10, `simulate.ts:596`)
  - IUSC with a year clamp (`simulate.ts:311`)
  - honorarios rates (`:582-588`)
  - AFC rates three ways
  - `cardPayBy` (`:304`) and `closeForPurchase` with the Santander rule for every card (`:519-522`)
  - `writeMortgage` hand-writing ledger rows (`generate.ts:256-329`) with hardcoded insurance (`:322-323`)
  - `MORTGAGE_MERCHANT` (`:184`) tied to the lender list
  - the Buda wallet without its key (`generate.ts:94`)
  - legacy keys (`:118-119`), literal series keys (`simulate.ts:599-600`), the UF→IPC
    identity (`generate.ts:167-183`)
  - a third payslip writer (`:225-254`) and AFC notes (`:356-384`)
  - hardcoded values (`generate.ts:120-128,189,386,418`), year fallbacks (`simulate.ts:315,1277`)
- The IPC reajuste is written six times with different rounding (`cryptoTaxGains.ts:62-82`,
  `usdFxTaxGains.ts:151-160`, `art107TaxGains.ts:65-111`, `foreignShareTaxGains.ts:69-117`,
  `f22AppEstimates.ts:24-26,74-75`, `payrollTaxYear.ts:79-82`). `round1` ×4. The
  provisional-year test is written four times.
- The F22 identities exist twice (`siiF22Compacto.ts:72-89`, `f22Draft.ts:111,548`).
- "Taxable pay" and "health up to 7%" are decided three times (`payslipChecks.ts:105-133`,
  `payrollTaxYear.ts:47-62`, `payrollBreakdown.ts`). The health rate is defined twice
  (`payrollTaxYear.ts:20`, `payslipChecks.ts:43`), and so is the mandatory pension rate
  (`payslipLineKinds.ts:92`, `payslipChecks.ts:44`).
- `fx_daily_bcentral` is read under two meanings (`usdCashTaxLotEvents.ts:62-72` vs
  `fxObservadoFrame.ts:18-56`, plus `foreignShareTaxGains.ts:89`).
- `f22Draft.ts:49,52` and `f22DraftPayload.ts:10` import parsers and engines for a helper
  or a date. `siiF22Compacto`/`siiInformedDj` are document decoders that belong in ingest.
- `cryptoTaxGains.ts:71` taxes only Buda-funded coins.
- There are two bill-kind vocabularies (`realEstateExpenseMerchants.ts:3-11` vs
  `utility.bill` services) with a translator. `realEstateExpenseMerchants.ts:43` uses
  undocumented reverse containment. `upcomingPayments.ts:434-439` re-expands `months_covered`.
  `upcomingPayments.ts:40,465-680` owns recurring CRUD inside a read aggregator, and
  recurring payments are split across five modules.

### F16 — A broker adapter

`{cashAccountId(currency), equityAccountId(ticker), planDeposit, dividendPairingWindow,
splitHandler}`, with deposit-from-mail and dividend pairing written once against it.

- Deposit-from-mail is written twice (`racionalEmailImport.ts:145-207`, `fintualEmailImport.ts:260-288`).
  Dividend pairing exists per broker (`racionalMovementsImport.ts:517,547`,
  `brokerDividendStatementApply.ts:102`). `fintualRow`/`racionalRow` are near copies
  (`brokerNotificationsApply.ts:37-103`). There are broker branches
  (`brokerNotificationsApply.ts:115-182`). The ±5-day window is a constant ×4.
  `brokerSplitNotifications.ts:77-83` couples to Racional and hardcodes the 7 days.
  `incomingWires.ts:31,44,70` depends on the Fintual planner. `fintualEmailImport.ts:67-73`
  holds a regex table of holdings.

### F17 — A matching kit

One Chile-day module (from F7), one one-to-one pairing helper (nearest day, twins in order,
ambiguity reported), and one table of match windows per relation, so each relation has a
single matcher.

- Day windows per source pair: ±1, ≤4, 0..5, 0..7, −3..+5, ±2 days (`ccOpenWebPastePdfReconcile.ts:295`,
  `ccTruncatedMerchantDedupe.ts:60`, `ccFeedMirror.ts:43`, `ccPaymentMirrors.ts:45`,
  `ccPlantedPayments.ts:39`, `ccRecurringPendingLines.ts:20`, `ccFacturadoFinancingAuto.ts:173`,
  `ccManualInstallmentStatementReconcile.ts:288`), each with its own money equality.
- Internal-transfer gaps of 7/5/8/14 days (`flowsDepositsReconciliation.ts:205`, which runs
  its own pairing; `movementMirrorPairs.ts:97`; `flowsCheckingGastos.ts:523,832`;
  `expenseDepositLinks.ts:619`).
- Mortgage cuota ↔ card line is paired twice (±14 days stored vs 0–3 days at read time;
  `expenseDepositLinks.ts:43,287`, `mortgagePaymentCardMatch.ts:27`).
- `ccRecurringPendingLines.ts:33-45` copies `recurringPaymentMatch.ts:118-164` and diverges.
  The recurring matcher is fed different candidate sets (`upcomingPayments.ts:476-477`,
  `recurringLineNames.ts:33`).
- Receipt window and tolerance are written twice (`paymentProcessorReceipts.ts:355,433`,
  `merchantExpenseNotes.ts:50-52`). `ccCrossImportDedupe.ts:120-126` "mirrors"
  `ccInstallmentPurchaseTotalLines.ts:123`; `ccInstallmentPaymentGastosLines.ts:100` copies
  the stem logic.
- Dedupe keys are built independently (`ccDedupeKey.ts:16` plus Python,
  `santanderStatementImport.ts:47,87,166`, `#dupN` written in four places and parsed in one).
- `utilityBillsApply.ts:79` relies on the +0..+2 window in `realEstateExpenseMatching.ts:24-25`.

### F18 — Separate runtime from repairs

Move the Fintual runtime modules from `server/scripts/` into `server/src`. Move applied
one-offs, the `src` modules only they use, and their npm entries out of the typechecked
tree (into an archive folder, or delete them; git keeps the history). The remaining
document-decoding scripts (CMR, SII, Buda, CMF, MACH) become ingest decoders that send kinds.

- `globalSyncAll.ts:89,104,115` and `globalSyncStale.ts:57` import `server/scripts/fintual*`.
- At least 18 self-declared applied one-offs and about 15 scripts with no references. The
  `/private/tmp/…/scripts-ingest-audit.txt` table from this pass lists last commits and
  references; regenerate it before acting.
- Stale npm entries, including `backfill:additional-card-no-cuenta`, which tags `no_cuenta`
  although migration 217 replaced it with `additional_card` (`backfillAdditionalCardNoCuenta.ts`
  has no importer).
- `src` modules used only by scripts: `pensionCertificateChain`, `ccBilledCuotasIdentity`,
  `creditCardPerformancePl`, `ccParsedCommaCsv`, `equityBolsaSantiagoEod`, `siiF22Compacto`,
  `ufSiiDailyPath`. `measure-pasivos-tick.ts` imports `src/index.ts`.
- Scripts write the DB outside the ingest API (`import-cmr-statements`, `import-sii-tax-year`,
  `import-buda-trade-details`, `import-cmf-rn-composition`, `build-mach-account-from-mails`,
  `rebuild-checking-gap-from-mails`, `apply-mach-app-history`). Two scripts hardcode
  account ids.
- Every domain refactor drags one-offs along (`188e6cb0` edited 11 of them).

### F19 — Delete what nothing uses

Do this after F1–F18, re-checking callers with grep (scripts and tests included).

- **Valuation:**
  - `MergePairOpts` (`valuationTimeseries.ts:307-401,856-863,989-1200`)
  - the SPY/VEA branch (`brokerageEquityMtm.ts:230-253`)
  - `accountHistoricalMarkClpAtYmdUncached`
  - unused parameters (`cuotaLedgerAccounts.ts:31`, `valuationTimeseries.ts:130`,
    `accountValue.ts:48`)
  - the alias `isFintualCertV2ValuationNotes`
  - pass-throughs `applyLiveCloseToCurrentMonthPerfRows` and `patchLiveAfpMarksOnPoints`
    (misnamed), and its twin
  - test-only helpers: `computeLatestDisplayedEquityClp`, `computeEquityMtmClpDisplaySync`,
    `computeCryptoMtmClpCachedLive`, `computeCryptoMtmClpDisplaySync`, `rates.ts:180`
  - `accountPosition.ts:309-314` (an assert that only reads)
  - the dead card dispatch and the doubled stored read in `accountTodayValue.ts:159-183`
- **Infra:**
  - `setAggregationCached`
  - the dead deletes
  - `resetUsageDbForTest`
  - test-only `inFlightApiRequests` and `stopGlobalSyncScheduler`
  - five unused `heavyWork` labels (and the registry enforces nothing)
- **Nav:**
  - the dead `listAccountsForGroupTab` branches (`valuationTimeseries.ts:2094-2124`)
  - `accountBelongsToDashboardBucket` (test-only)
  - a duplicate `getDashboardLayoutCards` call and its unseeded fallback
  - the legacy subgroup surface
- **Cards:**
  - `ccStatementsPayloadForAccount`, `ccInstallmentPlanTailClp`, `CC_ISSUER_SLUGS`
  - exports used only in their own file: `postCloseLiveBalanceAdjustmentsClp`,
    `announcedCloseIsoForBillingMonth`, `openMonthFacturadoTotalClp`,
    `cuotaPurchaseLinesClpByBucketMonth`, `facturadoTotalClpForStatementSlot`
  - test-only `ccUsdRevaluationCostClpByDate`, `insertLineSplits`, `lineMatchesGastosPeriodMonth`
  - pass-throughs `SANTANDER_CC_IMPORT_REDIRECT_LAST4`, `periodToIsoForBillingMonth`,
    `paymentBillingMonth`
  - the `annual_interest_pct`/`schedule_offset_months` columns the server always sets to 0
    (`CreditCardSections.tsx:180-204`, `CreditCardPurchaseMobileCard.tsx:77-94`)
- **Flows:**
  - `installmentLedgerTotalForIdentity`, `flowsDepositsNetInPeriodByAccount`,
    `loadCheckingExpenseRefundMovementIds`, `listMovementDividendDetails`
  - wrappers `countsTowardCcExpenseTotals`, `primaryCreditCardExpensesGroupSlug`
  - the script-only `matchCardReimbursements` in a request-path module
  - the server-side English `CATEGORY_LABEL` (`flowsDeposits.ts:58`) and Spanish units labels
    (`movementUnitsPolicy.ts:47`), which move to i18n
- **Domain:**
  - `pensionLedgerShape.ts` `factor` (always 1)
  - `afcCertImport` `replace_excel_rows`/`drop_movement_ids`
  - `jobQueue` `max_attempts`
- **Client:**
  - `chartMovingAverage.ts`
  - `brokerageGroupLabel` and `dashboardBucketLabel` (AGENTS.md still recommends the first)
  - `valueMapReadyForUnit`, `RAIL_TILES`, `DASHBOARD_TILE_ORDER`, `BILLS_CC_EXPENSE_SLUG`
  - `groupTabAggregation.ts`
  - `collectNavBucketCoverageKeys` and `ccExpenseCategorySlugAtLevel` (test-only)
  - `cardMainBalanceFromMetrics`, `titleBalanceDeltaNumberFlowParts`
  - the identity function in `flowsDisplay.ts:8`, the duplicate `mutations.ts:29-38`, the
    twin `ccExpenseLineBuckets.ts:77,83`
  - the legacy cache sweeps
  - the three-place eager chart registration (`chartsBundle.ts`, `lazyCharts.tsx`)
- **Ingest:**
  - `racional/steps.ts:244` `rowKey` (pass-through)
  - the dead test file `ccWebPastePdfRowsMatch.test.ts`
  - the shell runner leftovers (`record-daily-run.ts`, `record-email-run.ts`,
    `daily-run-ran-recently.ts`, `run-lib.sh`, two timed plists) once F13 retires the fallback

### F20 — Parts and links on a flow, and the behaviour changes of the flow model

**Unlike F1–F19, this changes behaviour**, so it gets its own rehearsal and is listed apart
from the bug fixes. It comes after F4–F6 (or the netting rule becomes a third copy), F9 step 3
(the flow id) and F17 (the pairing helper).

**Parts.** A flow may have parts, each with its own kind, amount and category, adding up to
the flow (fail fast otherwise). They replace three mechanisms:
- a user's pieces of a line (`cc_expense_line_splits`, «Desglosar»);
- the mortgage dividendo's split: amortización is an internal transfer into the property,
  interest and insurance are spending (today `mortgage_parts` and `flowsMortgageCarrying`);
- the deposit matcher's splittable reserva pool.

**Links.** One table `(flow_id, kind, counterpart, amount)` for what a flow points at: the
deposit a card line or checking debit funded, the mortgage cuota it paid, the facturado a
plan financed (`cc_facturado_financing_links`), the purchase a refund annuls. It replaces
`expense_deposit_links` and the two pairings of mortgage cuota ↔ card line (±14 days stored,
0–3 days at read time). The deposit matcher's pool includes card lines as well as checking
debits; the one-claim-per-deposit rule stays, with the claim key on the deposit's flow.
A link's amount defaults to the whole flow, and a flow's links never add up to more than it.

**Data surgery: the cuenta de ahorro.** The spreadsheet only had monthly totals into the
cuenta de ahorro, and `cuenta_ahorro_deposit_splits` split each month into family and own
pesos. Each split month becomes two real flows, and the table goes:
- the family part: a flow from outside (family) into the cuenta de ahorro, on the month-end
  date (the only date recorded);
- your part: a flow from checking into the cuenta de ahorro. If a real cartola debit is
  linked to it today, that debit becomes this flow, re-pointed to the cuenta de ahorro, and
  the synthetic mirror (`checking_gap_deposit_mirrors`) is dropped. Only a month with no
  cartola keeps its mirror, as a real flow.
- A month funded entirely by one side gets only that side's flow.

Report-first script on a copy of the real DB; check that every month's total, the ahorro
balance on every date and the checking balance on every date are unchanged.

**Instrument events.** `equity_splits` becomes `instrument_events` (kind, instrument, date,
ratio, and for a spin-off the new instrument and the cost-basis share). Share counts, holder
positions and tax lots derive unit changes from it; the per-holder `stock_split` movements
are deleted, with every holder's share count checked unchanged on every date.

**Behaviour changes:**
- **Cost leaves P/L and spending.** Broker fees, the AFP commission, card financing charges
  and plan interest are cost: not P/L, not deposits, not spending. Each account gets a cost
  figure (the sum of its cost flows); a card's P/L becomes 0 on ordinary days. On the Expenses
  page cost is its own total beside spending («Coste financiero»), not inside it. On the flows
  overview cost is counted under expenses, so `cash_unexplained` stays 0.
- **Payroll goes through the pre-tax account** (the «Pre-tax» bucket under Efectivo). The
  pension cotización and AFC become internal transfers, so net worth sees the gross pay as
  income and the retirement group sees the cotización as a deposit. Tax and health are
  spending. The payslip expense lines (`payslipExpenseLines.ts`) and their add-back to income
  in the overview become ordinary flows out of the pre-tax account.
- **Card-funded capital flows are dated on the card line's day.** The cash bucket is checking
  and savings minus the linked cards' owed (`cashNetOfLinkedCreditCards`), so a card purchase
  leaves the bucket on the purchase day; paying the card is internal. A card-funded transfer
  is a capital flow only when its destination is outside the bucket the card nets in: into
  MACH nothing counts as capital (the hand-categorised top-up lines go away); into brokerage
  it is a deposit on that day.
- **Opening balances** stop counting as deposits wherever they did.

Not yet verified: today card flows are kept out of `/flows/deposits` and the deposits
reconciliation, and the dating rule above is derived from the bucket frame, not from every
reader. Rehearse on a real-DB copy: the cash bucket's daily P/L stays 0 on a purchase day,
`cash_unexplained` stays 0, and every other change in payloads is one of the changes listed
above.

## Special cases that the redesign keeps

These encode real external facts and stay, documented where they are:
- Per-chain grocery card rules (`storeReceiptApply.ts:204-247`).
- The Santander 14:00 posting cutoff and forward-dated rows.
- The SP and Fintual publication hours (as one constant set, F14).
- The SII base-change bridge in the IPC reajuste (F15).
- The Chrome download capture.

## Suggested order for step 4

**Safe now, independent of the sequence** (no identity or write-path change): the label
change («N cuotas» in the ⓘ card, no superscript on the full-price row), «Desglosar» in the
row, the bug 3 fix (Delete is now reachable from the dashboard row) and the bug 13
invalidations.

Then, with F1's dependency check first so later moves can't reintroduce cycles. Each step
leaves tests green on its own, and every step is proven on a copy of the real DB with
before/after payloads (bundles, flows overview, expenses, card ledgers, group and daily
series). Tests use synthetic fixtures only (`cd server && npm run test`).

1. F7 formats, F8 contracts/DTOs (the foundations nearly everything else imports).
2. F2 cache registry (removes the infra → domain edges and bugs 4, 5, 16). New reads register
   their dependencies from here on.
3. F3 account profile, then F5 conversion, then F6 P/L kernel.
4. F4 nav tree.
5. Expenses and cards, in this order:
   1. The F9/F10 audit (one table, shared).
   2. F9 steps 1–2: the typed key module and the provenance columns.
   3. F10: the purchases module (read side), the line classifier with the stored `kind`, the
      facturación module, issuer rules as data.
   4. F11: the card-line write funnel and the pure read pipeline, then conversion keeps the
      line (bug 17).
   5. F17: the pairing helper and the window table.
   6. F9 steps 3–5: the flow, evidence and outside-party tables, adoption on arrival,
      deleting the movers.
      Besides the payload comparison, compare every assignment (category, «Único», note, big
      group, split, link) one by one against what the current carry code produces; each
      difference is listed as a bug or an intended improvement.
6. F12 client (once the server sends the shapes), including the expense row capability flags.
7. F13 ingest, F14 schedulers/config, F15 legal params and demo, F16 brokers.
8. F20: parts and links, the cuenta de ahorro surgery, then the behaviour changes (cost out of
   P/L and spending, instrument events, the pre-tax account, card-funded capital flows, opening balances), each
   with its own rehearsal.
9. F18 scripts, F19 deletions.
10. Extras: Comments, then Tests.
11. Step 5: re-run the area reviewers, the dependency graph and the full test suites.

## Execution plan (2026-11-07)

### Where the work runs

- **Integration branch `untangle`**, cut from `main` at the commit that adds this file. Each
  stream works in its own git worktree on `ut-<stream>`, branched from `untangle`, and
  is merged back into `untangle` once its checks pass. `main` only moves at wave boundaries:
  a wave is merged to `main` when `untangle` is green and a real-DB rehearsal (where the wave
  needs one) shows only the changes the wave intended. Pushing `main` deploys to the home
  server, which snapshots the database first.
- **This laptop has no live database** (`server/data/nw-tracker.db` here is a 1,4 MB copy
  from 2026-10-31; the real one and its daily snapshots are on the home server). Unit tests
  run on the synthetic Vitest person. Every «byte-check on a copy of the real DB» step needs a
  snapshot copied from the server first (`scp` the newest `server/data/snapshots/*.db`, open it
  with `BACKGROUND_JOBS_ENABLED=0 NW_TRACKER_TEST_DB=…`).
- **Checks every stream runs before merge:** `npm run typecheck` (root; includes
  `check:conventions`), `cd server && npm run test`, `npm run test -w nw-tracker-client`,
  `npm run test -w nw-tracker-ingest`, `npm run test:python -w nw-tracker-ingest` when Python
  moved, and `node scripts/check-deps.mjs` once F1 lands. A worktree needs `npm ci` once
  (the root postinstall applies the Recharts patch) and generates its own test DB on the
  first server test run.
- **Conflicts are avoided by file ownership, not by luck:** each stream's brief names the
  folders and files it owns; a stream that needs a change in another stream's files asks for it
  (a one-line note in its report) instead of making it. Streams in the same wave own disjoint
  files.

### Waves

**Wave 1 — independent areas, in parallel (5 streams).** Disjoint files; none depends on another.

| Stream | Fixes | Owns | Model |
|---|---|---|---|
| `core-formats` | F7 (module + server callers), F1 (dependency-check script added to `check:conventions`, baseline = today's graph, forbids new core→domain edges and new cycles) | `server/contracts/src/formats/**`, `server/contracts/data/*cases.json`, `scripts/check-deps.mjs`, the server callers it migrates (`chileanNumber`, date/month/RUT/accent helpers, merchant normalizers, `ccYearMonth` → core) | opus |
| `infra-schedulers` | F14 (scheduler kernel, sync-source table, fetch helper, config module, deployment profile, job kinds, one request classifier) | `globalSync*`, `liveMarketQuotes*`, `yahooPriceStream`, `jobQueue*`, `ingestRun*`, `dbBackupScheduler`, `dashboardCacheWarmer`, `visitedPagesWarm`, `rentabilidadDailyWarm`, `syncDimmingWatch`, `backgroundJobsEnv`, `demoMode*`, `demoMarketActivity`, `httpSecurity`, `usageLog`, `apiRequestsInFlight`, `liveInputsHeader`, `jsonResponse`, `index.ts` middleware order, `afpUnoOfficialSync` / `afcCicSeries` / `fintualPublishDate` schedule parts, the market sync fetchers | opus |
| `ingest-boundary` | F13 except the canonical card-line model (that is `cards-identity`, wave 3): receiver framework in `routes/ingest.ts` + `ingestHandlers`, one mail fetcher, structured step results, retire the shell fallback, ingest callers onto the formats module once `core-formats` has merged (else keep the ingest copy and leave a note) | `ingest/**`, `server/contracts/src/{kinds,tasks,client,runs}.ts`, `server/src/ingest*.ts`, `server/src/routes/ingest.ts`, the `*Apply.ts` receivers' store-once/dry-run plumbing (not their domain logic) | opus |
| `domain-legal-demo` | F15 (legal parameters module, reajuste service, F22 identities once, demo calls the real writers), F16 (broker adapter) | `f22*`, `art107*`, `*TaxGains`, `taxLots`, `payroll*`, `payslip*`, `siiOfficialIpc`, `demoData/**`, `broker*`, `fintual{Email,Cert,Wallet,Withdrawal}*`, `racional*Import`, `incomingWires` | opus |
| `scripts-cleanup` | F18, plus the part of F19 that is dead today (no caller anywhere, verified by grep over `server/`, `client/`, `ingest/`, tests and `package.json`) | `server/scripts/**`, `server/package.json` scripts, `client/src/chartMovingAverage.ts`, `server/src/{backfillAdditionalCardNoCuenta,rentasEsporadicas}.ts`, the script-only `src` modules named in F18 (move, don't delete) | sonnet |

**Wave 2 — the core, mostly serial.** Starts when wave 1 has merged into `untangle`.

| Stream | Fixes | Notes | Model |
|---|---|---|---|
| `cache-registry` | F2 | Touches every writer's invalidation call; runs alone first. Bugs 4, 5, 16. | opus |
| `valuation-core` | F3 → F5 → F6, in that order | One stream: the account profile, then quantity × price × convert with `rates.ts` as the one conversion, then the P/L kernel. Bug 1. Needs a real-DB snapshot for the byte-check. | fable (design) with opus for the mechanical migrations |
| `nav-tree` | F4 | Overlaps `valuation-core` on `valuationTimeseries.ts`, `dashboard*`: run after F3 merges, in parallel with F5/F6, owning the tree, nav, dashboard and group payload files. Bug 6. | opus |
| `contracts-dtos` | F8 | Shared DTOs with `schema_version`, one client cache helper, JSON Schema for the Python outputs. Parallel with the above (owns `server/contracts/src/dto/**`, `client/src/types/**`, `client/src/queries/*Cache.ts`, `ingest/python` schema checks). | opus |

**Wave 3 — flows and cards, serial with one parallel audit.** Starts after wave 2.

1. `audit` (read-only, sonnet): every reader of lines and plans, what each needs. **Done
   2026-11-07: `docs/untangle-audit-line-readers.md`** — 109 readers (63 card-line, 13 plan,
   9 loader consumers, 24 checking/income/deposit). The module must offer nine views: debt
   events; billed/open-cycle lines with a `source_kind` stamp; expense lines (Total and Por
   cuota, checking without the plan overlay); plan schedule; payment evidence; financing and
   proxy filters; a `findLines` merchant/amount search for the matchers; checking bank
   movements plus capital events; and the write funnels. About 40 of the 63 line readers need
   only a flow view plus an id. Raw-table readers: the importer and the
   dedupe/reconcile/re-key family, the plan writers and the payment↔line join on
   `parser_row_id`, the payment-evidence and traspaso-link readers, and the checking importers.
   Only three plan readers want a plan with no line. Some rows were classified from SQL
   snippets rather than function bodies (marked in the Src column) — verify before building.
2. `flow-identity-1` (opus): F9 steps 1–2 — typed key module, provenance columns.
3. `cards-rules` (opus): F10 — purchases module, line classifier with the stored kind,
   facturación module, issuer rules as data.
4. `write-funnels` (opus): F11 — card-line funnel, pure read pipeline, conversion keeps the
   line (bug 17), the three cartola apply paths → one. Bug 3.
5. `matching-kit` (sonnet): F17 — pairing helper and window table, each matcher moved onto it.
6. `flow-identity-2` (fable): F9 steps 3–5 — flow, evidence and outside-party tables, adoption
   on arrival, delete the movers. Bugs 2, 8. Full assignment-by-assignment comparison on a
   real-DB snapshot.
7. `cards-canonical` (opus): the canonical card-line model from F13.

**Wave 4 — client and behaviour changes, in parallel.**

| Stream | Fixes | Model |
|---|---|---|
| `client` | F12 — server sends the shapes the client derives, resource definitions, one page-data hook, one column table, `usePersistedPref`; the 9-file cycle. Bug 13. | opus |
| `flow-model` | F20 — parts, links, the cuenta de ahorro surgery, instrument events, then the behaviour changes one at a time (cost out of P/L and spending, the pre-tax account, card-funded capital flows, opening balances), each rehearsed on a real-DB snapshot | fable |

**Wave 5 — closing, serial.** `deletions` (F19, sonnet) → `comments` (sonnet, the Comments
extra) → `tests` (opus, the Tests extra: remove tests that repeat the implementation or cannot
fail, rewrite internals-bound ones to behaviour) → `review` (the eight area reviewers again,
sonnet, read-only; the dependency graph; the full suites) → merge `untangle` into `main`.

### Agent briefs, in common

Every brief carries: the fix sections of this file it implements (by name, with the file
read first), the files it owns, the checks to run, the rule that a change outside its files
is a note not an edit, the GUIDELINES rules (fail fast, no fallbacks, free text is
provenance, server computes / client picks, tests on synthetic fixtures only), the commit
convention (small commits on the stream branch, no co-author trailer), and the report shape:
what changed, what was left as a note for another stream, the check results verbatim.

### Risks

- A worktree has no `cfraser/` and no `PARSERS.md`; nothing in the test suites needs them.
- The repo is public: no personal values in code, fixtures or commit messages, and a scan of
  `origin/main..HEAD` before every push.
- Wave 2 and the rehearsals need a real-DB snapshot on this machine; fetch one from the
  server before wave 2 starts.

## Open decisions

- The name and API of the purchases module (the audit decides).
- The claim rule for a deposit funded by a card line when a checking debit of the same pesos
  also exists (F20).
- `docs/expense-identity-plan.md` is superseded by this file; delete it or leave a one-line
  pointer here.
