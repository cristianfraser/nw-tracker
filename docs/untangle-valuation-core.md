# Valuation core — design for F3 → F5 → F6 (untangle wave 2)

Author: the untangle coordinator (design). Implemented by stream agents in three steps, each
merged into `untangle` before the next starts. Behaviour is byte-identical except the bugs and
the measured differences each step names. Read `docs/untangle-plan.md` F3, F5, F6 and bug 1
first; this file says HOW.

## Step 1 — F3: one account profile (`server/src/accountProfile.ts`)

### The type

```ts
export type AccountProfile = Readonly<{
  id: number;
  name: string;
  importKey: string | null;
  leafSlug: string;              // asset_groups.slug of the account's leaf
  kind: string;                  // behaviour kind (`accountBucketKindSlug(leafSlug)`)
  holding: Holding;              // holdings.ts, unchanged shape
  side: "asset" | "debt";        // holdingIsDebt(kind) — the ONE liability predicate
  quantity: QuantitySource;      // how a day's quantity of `holding` is found (below)
  priceless: boolean;            // true when `quantity` yields pesos / dollars directly (no instrument price)
  flowCarry: boolean;            // book-value carry applies (stored-mark accounts, never card/mortgage)
  perf: "valuation_series" | "ledger_cash" | "book_valuation";   // monthlyPerfRowsForAccount dispatch
  monthPrecision: boolean;       // MONTH_PRECISION_ACCOUNT_KIND_SLUGS
  chartDeposits: boolean;        // false for liabilities (CATEGORY_NO_CHART_DEPOSIT_LINE)
  roles: AccountRoles;           // below
}>;

export type QuantitySource =
  | { kind: "cuota_ledger"; seriesKey: string; fallback: "book_mark" }        // afp/afc with a series
  | { kind: "fintual_goal"; seriesKey: string; goalId: string | null; publicSerie: number | null; fallback: "book_mark" }
  | { kind: "checking_ledger" }                                                // cuenta_corriente / cuenta_vista / clp under Checking
  | { kind: "usd_ledger" }
  | { kind: "clp_ledger" }
  | { kind: "stock"; ticker: string; fallback: "book_mark" }
  | { kind: "coin"; priceTicker: string }                                      // never falls back: throws
  | { kind: "depto_property"; loanAccountId: number | null }                   // pesos from the depto ledger (phase 4 of the holdings plan later)
  | { kind: "depto_loan"; propertyAccountId: number }                          // idem; fallback: latestMortgageDisplayedBalance
  | { kind: "card" }                                                           // the owed walk (cardValueInUnit)
  | { kind: "book_mark" };                                                     // stored valuations (+ flow carry)
```

The profile is the ONLY place that decides which branch values an account. Today five ladders
decide by re-testing predicates in different orders (`accountMarkClpAtYmd` 110-250,
`accountTodayValue` 86-185, `accountPosition` 217-350, `valuationTimeseries` 402-429 /
832-854 / 1046-1100, `liabilitiesValuation` 68-95, `liabilityTree` 225-245). Step 1 rewrites
each ladder as a `switch (profile.quantity.kind)` whose branch bodies are the EXISTING code
moved, not rewritten. Where a ladder today orders its branches differently from the others
(the AFC ledger-first vs AFP stored-first case in `rawTodayValue`; the stock `equityChartZeroClpAtYmd`
rule), first prove on the real-DB copy which branch each real account takes today (one script:
for every account and a set of dates — ten month-ends, yesterday, today — record the branch
name and the value), then make the profile select exactly that branch. A difference is a
bug to list, not to silently pick.

### Resolution rules (`profileFromFacts(facts)`, pure, unit-tested on synthetic facts)

Precedence, first match wins — this is the current effective order, made explicit:
1. `kind === "credit_card"` → card, side debt, perf valuation_series, flowCarry false.
2. `kind === "mortgage"` → depto_loan when the depto ledger has a property (roles.loanOf), side
   debt; fallback the mortgage displayed balance.
3. `kind === "property"` → depto_property; `valuationsAreAppraisals` stays true for it.
4. coin price ticker present (`accountUsesCryptoMtm`) → coin.
5. equity ticker + `accountUsesEquityMtm` → stock.
6. `kind ∈ {afp, afc}` with a series key → cuota_ledger; an `afc` without a series → book_mark;
   an `afp` without a series → cuota_ledger on `AFP_UNO_CUOTA_SERIES_KEY` ONLY when
   `deploymentProfile().demo || process.env.VITEST` (today's production fallback at
   `cuotaLedgerAccounts.ts:30-34` is demo-only in practice: on the real DB every AFP account has
   a series — assert that on the copy, then make production throw).
7. Fintual cert import key (`isFintualCertV2AccountNotes`) → fintual_goal (series required, else throw).
8. checking kinds (`MOVEMENT_BALANCE_CASH_CATEGORY_SLUGS`, plus `clp` filed under Checking
   accounts — `listMovementBalanceCashAccountIds`'s rule) → checking_ledger.
9. `kind === "usd"` → usd_ledger; `kind === "clp"` → clp_ledger.
10. everything else → book_mark.

`perf`: ledger_cash for checking/usd/clp ledgers; book_valuation for `cuenta_ahorro_vivienda`;
valuation_series otherwise (`monthlyPerfRowsForAccount` keeps its three builders, dispatch by
profile). `flowCarry` = quantity is book_mark (and the stored-mark fallback paths) and side is asset.

### Roles (`AccountRoles`, data in the DB)

Migration **271** (`271_account_roles.sql` — 270 is F2's) creates
`account_roles(account_id, role, param, UNIQUE(account_id, role))`, seeded by a post-migration
hook from today's identities (import keys and tree placement, read from the DB — no personal
value in code):
- `checking_member` — every account `listMovementBalanceCashAccountIds` returns today.
- `broker_cash` param `<broker>|<currency>` — from `brokerAdapter.ts` keys (`import:panel|kind=usd|key=fintual_usd` → fintual|usd, `…key=fintual_clp` → fintual|clp, `…key=usd` → racional|usd, `…key=clp` → racional|clp).
- `buda_wallet` — `BUDA_ACCOUNT_IMPORT_KEY`.
- `fintual_goal` param goal id — `FINTUAL_CERT_V2_GOAL_IDS` inverted.
- `loan_of` param property account id, on the mortgage; `property` on the property — the depto pair
  (`import:excel|key=property` / `import:excel|key=mortgage`).
- `lender_pattern` param (one row per pattern) on the loan — the hardcoded lender list of
  `expenseDepositLinks.ts:121-128` and the `%TOKU%` SQL (`mortgageUfReminder.ts:186`,
  `mortgagePaymentCardMatch.ts:66`); `cuota_day` param `11` on the loan (`MORTGAGE_CUOTA_DAY`).
- `portfolio_caja` on `brokerage_cash__caja_*` accounts (`portfolioCajaClpAccountId`).

Readers: `accountsWithRole(role)`, `accountWithRole(role, param?)` (exactly one, else throws naming
the role), `profile.roles` (a parsed view). Replace the 13 files' private SQL and the three
`FINTUAL_USD_IMPORT_KEY` copies (brokerAdapter keeps the key constants only as the SEED source);
`movementBalanceCashAccounts.ts`'s two definitions and legacy fallbacks → one role query;
`deptoLedgerFromMovements.ts` takes the property account id from the role (`deptoAccountMarkClpAtYmd(kind)`
→ `(accountId)`; the `LIMIT 1` singleton stays an assertion "exactly one property with a loan"
for now — `dailySeries.ts:252`, `dailyReferenceLines.ts:107` and `valuationTimeseries.ts:932-951`
read the pair through the roles). Fintual: one table `FINTUAL_GOALS` (key → {goalId, name,
categorySlug, seriesKey, publicSerie, rnProxy}) replacing the six parallel maps in `fintualCertV2.ts`
and `fintualPublicSeriePrice.ts:31-39`; `RISKY_NORRIS_MTM_SERIES_KEYS` etc. derive from it (one
definition, six copies deleted: `riskyNorrisProxyMtm.ts:27-37`, `watchlistComposite.ts:21,51`,
`fintualRiskyNorrisComposition.ts:245`, `marketSeries.ts:13`, `fintualPublicSeriePrice.ts:35-38`,
`fintualCertV2.ts:35-36`). `afpUnoOfficialSync.ts:45-53` follows the live AFP account's series key.

### Also in step 1 (mechanical)
- `isLiabilityKindSlug`/`isLiabilityAccountId`/`holdingIsDebt` → one (`holdingIsDebt`), the copies
  at `accountBucket.ts:51`, `valuationTimeseries.ts:179`, inline `accountMarkClpAtYmd.ts:234`,
  `accountTodayValue.ts:166,179`, `dashboardAccounts.ts:371,414` read `profile.side`.
- "No flow carry on liabilities" lives in `storedMarkFlowCarry.ts` (takes the profile).
- Coin identity: `market_symbols.market_kind` (one lookup) replaces the four encodings.
- `bucketSlugForAccount` / `bucketSlugForAccountId` → one (`profile.leafSlug`); the ~12
  accounts⋈asset_groups lookups read the profile; callers stop threading slug/import_key/name
  into `accountTodayValue` (signature becomes `(accountId, opts?: {now, positionMeta})`).
- `accountPosition.ts`: `afp_override_*` renamed `mark_*` only if it does not change payload field
  names (check the DTO); the per-kind acceptance in `positionMarkFromMeta` keyed on the profile.
- The `{afp, afc}`, `dap`, investment-bucket sets copied in `flowsDeposits.ts:66,103`,
  `movementMirrorPairs.ts:100,103`, `flowsDepositsReconciliation.ts:144,150`,
  `checkingCartolaLoaders.ts:207`, `flowsPl.ts:28`, `checkingDescriptionPredicates.ts:22,38` →
  profile predicates (`profile.kind`, `profile.perf`, roles).
- `payslipChecks.ts:20` identifies AFP credits by profile.kind; the USD contract exemption by
  `liquido_currency` stays (it is payslip data, not an account fact).
- Client (`client/src/navAccountLabels.ts:4-29`, `pages/accountDetail/shared.ts:12-30`,
  `kindFromBucketSlug` ×2): the server sends `units_kind` / label / ticker on the account DTO
  (F8 owns DTO files — add the fields to the server builder and leave a one-line note for
  `contracts-dtos` to mirror; the client derivations go in F12).

Memoized per account with the F2 registry — `cacheRegistry.ts` / `cacheFamilies.ts` replaced `aggregationCache.ts` (read `docs/cache-registry.md` first: declare a family for the profile, never a hand invalidation) — (dependencies: `accounts`, `asset_groups`,
`portfolio_groups`, `portfolio_group_items`, `account_roles`, `market_symbols`, `movements` for
the "has units events" facts).

### As built (step 1, 2026-11-07)

Deviations from the design above, forced by the code:

- **Roles live in two places.** `account_roles` (migration 271) stores the identity roles —
  `broker_cash`, `buda_wallet`, `fintual_goal`, `property`, `loan_of`, `lender_pattern` — with
  `UNIQUE(account_id, role, param)` (a loan has several lender patterns). Triggers on `accounts`
  (`accountRoles271.ts`) grant and revoke them from the frozen identity table whenever an account is
  created or re-keyed, so the demo, test fixtures and panel accounts get their role without writing
  it; the hook seeds existing accounts and adds the table's write-log triggers
  (`WRITE_LOGGED_TABLES` in `markInputTriggers.ts`). The two roles of **tree placement**
  (`checking_member`, `portfolio_caja`) are NOT stored — a stored copy goes stale when an account
  is created or moved — and stay where the tree is: `listMovementBalanceCashAccountIds` (now one
  rule: a cartola checking kind wherever filed, or a `clp` account under Checking accounts; the
  legacy fallbacks are gone) and `portfolioCajaClpAccountId`. `cuota_day` is not seeded: the one
  constant `MORTGAGE_CUOTA_DAY` (`mortgageCuotaDay.ts`) already serves every reader but
  `ingestRunPolicy.ts` (infra's file).
- **`checking_ledger` is the cartola kinds only.** A `clp` account filed under Checking accounts
  (MACH) keeps `clp_ledger`, as every ladder valued it; its membership is the role, not the quantity.
- **The profile and the roles reader are leaves of the import graph** (database reads and leaf
  modules only), so they joined no cycle: the profile computes its facts by SQL (leaf kind from
  `portfolio_groups.kind_slug`, share units, coin units) and `accountUsesEquityMtm` /
  `accountUsesCryptoMtm` now read the profile. New leaves: `shareUnitsFlowKinds.ts`,
  `fintualGoals.ts` (the one Fintual goal table; the old maps and the Risky Norris series sets
  derive from it), `accountIdentityKeys.ts` (the keys the demo and fixtures create accounts with).
- **Memo**: `dbStateMemo` (any write of this connection or the registry's epoch drops it), the same
  lifetime `holdings.ts` had; no cache family.
- **Coin and stock together throw**; a stock without a ticker, an AFP without a series outside the
  demo and tests, and a Fintual goal without a series throw at profile resolution.
- **Kept for steps 2–3**: the three liability blocks of `accountPerformance.ts` (F6's card / mortgage
  legs), `afp_override_*` (DTO-facing; F5 removes the producers), `afpUnoOfficialSync.ts`'s
  hard-wired UNO/A (the "live AFP account" is defined by that series today — following it needs
  another definition of liveness), the per-account `units_kind` / label / ticker on the account DTO
  (F8/F12).

### Proof for step 1
Real-DB copy, before/after: for every account × {ten month-ends, yesterday, today} the value in
clp and usd from `accountValueAt`, `accountTodayValue`, the position snapshot; the home bundle in
both units; every group page bundle; the daily series of net_worth and of each NW bucket (90 days);
the liabilities overview. Expected identical. Plus the bug-14 cuota day check and the demo
generator still building.

## Step 2 — F5: quantity × price × convert is the only value path

Starts from the merged step 1.

1. `rates.ts` owns `TsUnit` (= `Exclude<CurrencyCode, "eur">`; `valuationTimeseries.ts` re-exports
   it for one release, then F12/F8 drop the re-export) and gains the FLOW side:
   `convertFlow(amount, from, to, ymd)` = today's `flowEventInUnit` rule (CLP→USD at the buy rate on or
   before the day, CLP→UF at the day's UF, a carried native leg as is, unrounded, missing rate throws).
   `flowEventInUnit` becomes a thin caller. `convertTs` is deleted: each of its 8 call sites is
   classified — a FLOW (`accountPerformance.ts:86`, `dailySeries.ts:552,585,641`,
   `groupMonthlyPerfConsolidation.ts:201`, `periodReturnsShortHorizon.ts:147`) moves to
   `convertFlow` **at the event's own day** (today they convert a window sum at the window end — bug 1's
   sibling; this CHANGES UF figures and must be measured and reported, not hidden), a VALUE
   (`valuationTimeseries.ts:1343`) moves to `convertValue`. `clpToUnitAt.ts` goes (its two value
   helpers fold into `accountValue.ts` / `valueConvert.ts`). `convertTs`'s "pesos unchanged when
   the UF row is missing" fallback goes: throw.
2. `netDepositFlowWindows(accountId, unit: TsUnit)` takes every unit and converts each EVENT with
   `convertFlow` — bug 1: `groupMonthlyPerfConsolidation.ts:242-248,268-270,303-305` compute the
   cash closes in the unit through `accountValueAt` (never `unit === "usd" ? … : clp`). Delete the
   five "convert the window sum at the window end" copies.
3. Delete the peso-first producers: `afp_override_*` marks (the position reads `holdingPriceAt` ×
   quantity), `valuationRawClpForAccount`, `monthEndCloseForPerformance` (`accountPerformance.ts:513-618`
   → `accountValueAt` at the month-end), the three `accountValueInUnitFromClp` wrappers,
   `usdCashBalanceClpAt`, the chart's build-pesos-then-discard (`valuationTimeseries.ts:1100-1104`):
   every chart point is `accountValueAt(id, d, unit)`. Instrument price: `holdingPriceAt` only
   (`accountPosition.ts:145-215,304-305` and `computeEquityMtmClp`/`computeCryptoMtmClp` become callers
   or go). `accountPosition.ts:239` passes `now`.
4. `fxRates.ts:59-66` dead fallback and the after-date live fallback go; `monthEndOnly` goes;
   `valuationLatest.ts:75-89` after-today fallback goes (throw or null per the caller's contract —
   report which). `usdCashAccounts.ts:22-36` sell-rate rule → `convertValue`; `benchmarkComparison.ts:126-159`
   and `flowsOverviewCash.ts:99-127` → `convertValue` / `convertFlow`.
5. CLP-leg SQL copies (`flowsDepositsReconciliation.ts:197,276`, `flowsCheckingIncomeOverrides.ts:217`,
   `ccPaymentMirrors.ts:176`, `equityBrokerageCapitalFlows.ts:41`, `exportWorkbook.ts:121-127`) →
   `MOVEMENT_CLP_LEG_SQL`.
6. Card owed terms (`server/src/ccOwedTerms.ts`): one module exposing the shared terms — latest
   anchor per currency, post-anchor dated lines, plan remainder, header legs — that the five owed
   computations (`ccOwedWalk.ts:131,147`, `ccOwedByCurrency.ts:60`, `ccBillingViews.ts:619`,
   `ccInstallmentDebtDaily.ts:310`, the live formula) read; the mutable global in
   `ccExpenseAmountClp.ts:9-35` (set at `ccBillingViews.ts:624`) and its three fake rates go;
   `facturadoFromStatement` once. `creditCardGroupLedger.ts:69-107` merges field by field with an
   explicit list that fails on an unknown field. **Strictly byte-identical** (card ledgers, Pasivos
   pages, the owed walk on every day) — if any term cannot be shared without a change, stop and leave
   the note for wave 3 `cards-rules`.

Proof: step-1's dump plus the flows overview (clp, usd, uf), the deposits page, the Rentabilidad
payloads of every group and account in clp/usd/uf, the card ledgers. Report every UF difference
from item 1 with its cause (window-end → per-event conversion) and the bug-1 corrections.

### As built (step 2, 2026-11-07)

- **Done:** `rates.ts` owns `TsUnit` and `convertFlow` (clp→usd at the buy rate, clp→uf at the
  day's UF; another pair throws until a flow needs it); `flowEventInUnit` is a thin caller;
  `convertTs` is gone. Every flow converts per event in UF too: `netDepositFlowWindows` /
  `…Between` / `…CurrentMonthThroughToday` take `TsUnit`; the daily series' flow legs, aportes
  cumulatives and per-account P/L, the 1D/1W cells, the live month row and the ledger months read
  them (a card's daily flow in UF is its peso flow converted at that day's UF). Bug 1: the ledger
  cash closes (checking, CLP cash, USD cash, cuenta de ahorro) are `accountValueAt` in the unit.
  The chart's plain account lines are `accountValueAt(id, d, unit)` forward-filled in the unit
  (`valuationRawClpForAccount`, the raw-CLP chart memo and `accountChartValueInUnit` for those
  lines go; a stock line still starts at its first shares — `equityHeldByYmd`);
  `monthEndCloseForPerformance` is the chart cell, else `accountValueAt`. The fx fall-forward and
  the dead month-end branch go from `fxMonthEndForBalanceUsd` (= `fxRowOnOrBefore`), and
  `monthEndOnly`; `latestValuationRowOnOrBeforeChileToday` returns `undefined` with no row on or
  before today (its callers already treat that as no stored value). The CLP-leg CASE copies read
  `MOVEMENT_CLP_LEG_SQL` (unqualified: none of those queries joins a table with an amount column).
  Benchmark levels convert through `convertCurrency` at the mid; a card payment in the flows
  overview is a flow (`convertFlow`). The card group ledger merges facturaciones from an explicit
  field list (an unknown field throws); `facturadoFromStatement` runs once per slot.
- **Moved, not deleted:** `clpToUnitAt` lives in `valueConvert.ts`; `clpToUnitAt.ts` is a
  re-export for the nav-tree files until they import from there (then delete it).
- **Left:** the `afp_override_*` producers in `accountPosition.ts` and its two instrument-price
  ladders (their fallbacks differ from `holdingPriceAt`'s: the position's equity close is the bar
  on or before the day asked, the cuota ledger's falls back to the raw fund series — moving them
  changes today's marks; F12/F8 rename the DTO fields with them); `usdCashClpRateOnOrBefore` (its
  sell row on or before also prices legless USD deposit events and cash interest, which
  `convertValue`'s bid — the day's observed row, else mid − half spread — would reprice);
  `ccOwedTerms.ts` and the uniform-rate global of `ccExpenseAmountClp.ts` (no term of the five
  owed computations can be shared without threading the statement-frame rate through
  `ccBillingViews`, which is cards-rules' facturación module — wave 3).
- **Measured on the real-DB copy** (`dump-valuation-branches.ts --payloads` and
  `dump-valuation-perf.ts`, before vs after): (a) UF only — every UF flow, aportes line and P/L
  that converted a window sum at the window end, and the checking / cash / cuenta de ahorro UF
  closes that were pesos (bug 1: an account's UF lifetime P/L read in the millions); (c) the USD
  card payments of the flows overview at the buy rate instead of the mid (≤ US$22 a month,
  Σ|unexplained| slightly lower), and the home chart's USD milestone anchors on a date before the
  fx series starts (null instead of a rate dated after it). Every clp/usd value, chart and P/L
  else byte-identical.

## Step 3 — F6: one P/L kernel with days as atoms (`server/src/perfKernel.ts`)

1. The kernel: `dayPl({ valueStart, valueEnd, flow, side })` (asset: Δ − flow; debt: prior − owed − flow),
   `flowAdjustedPct`, `endChargedFlow`, `groupStartFrameFlow` (moved from `periodReturns.ts`),
   `bucketFlowsIntoWindows(events, boundaries)` (the one loop replacing `dailySeries.ts:187-268,294`,
   `flowsDeposits.ts:267`, `valuationTimeseries.ts:287`), `foldDays(days) → period` (Σ P/L, compounded
   pct through `periodPctDailyChain`), `compound(returns)` (the three copies: `benchmarkLevels.ts:253-272`,
   `periodPctDailyChain.ts:36-55`, `inversionesPerfSeries.ts:220-237`).
2. Callers: `dailySeries.ts` (579-588, 650-675), `groupMonthlyPerfConsolidation.ts:381-480`,
   `accountPerformance` reanchor + live row, `periodReturnsShortHorizon.ts:134-164` compute their
   legs and call the kernel. Months and windows: keep each builder's own legs for now (closing
   values at month-ends) but with the kernel's formulas; THEN measure on the real-DB copy how far
   Σ(day P/L over the month) is from the monthly row per account (`dailyPerfLevels.ts:46-68`
   re-anchors because they differ). Report the table; do NOT switch months to folds over days in
   this step unless the difference is zero for every account — that switch is a documented
   behaviour change for the next wave.
3. Card flow identity once (`dailySeries.ts:270-288` + `accountPerformance.ts:554-576` → the kernel's
   card leg, fed by `ccFinancingCostByDateInUnit`); mortgage flows once (`dailySeries.ts:243-256`,
   `accountPerformance.ts:131-142`); section-3 charges summed once (`creditCardPerformancePl.ts:17` →
   `ccFinancingCostDaily.ts:37`; the verify script becomes a test).
4. `pickMonthlyPerfRowsByMonth` = `collapseMonthlyPerfDuplicateCalendarMonths` → one.
5. `accountPerformance.ts:621-659`'s stale share-units kinds → `BROKERAGE_SHARE_UNITS_FLOW_KINDS`;
   share counts once (`brokerageFlowMovement.ts:55` / `brokerageEquityMtm.ts:77`); split ratio from
   `equitySplits.ts` (`equityTaxLotEvents.ts:63-72`); crypto and AFP inflow queries include transfer
   legs (`:661-697`) — a behaviour fix: measure which accounts change and by how much.
6. Fragile tests: `dashboardCcCardVsDetalle` «day P/L in dollars» and `ccGroupTotalMatchesCardsInvariant`
   — make them deterministic (inject the clock and the fx frame) now that the kernel owns the legs.

Proof: step-2's dump; expected identical except the measured items in 2 and 5, each listed.
