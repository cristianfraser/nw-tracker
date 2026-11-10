# Demo person: cash lives in savings, and two card fixes

Plan (2026-11-09). Three things the demo's Cash and Brokerage cards showed after the US chapter
(`docs/demo-us-chapter-plan.md`): the cash bucket keeps every peso and dollar in checking, the
real-estate card nests both properties under a fake «centro» head line, and the strip cards read
«spy» where every other surface reads «SPY». Two are client/server fixes of a few lines; the
first is a generator change with a small story decision in it. Options trading is not in the
demo and not in the app (the US-chapter plan listed it under phase 8 as a new instrument kind
and left it out); it stays out of this plan.

## 1. Cash: checking at one or two months, the rest in savings vehicles

### What the generator does today

- **Checking is the whole cushion.** `CASH_BAND` (`person.ts`: low 3 / target 4,5 / high 6
  months of the trailing six months' expenses) is measured on `totalCashClp` = vista + cuenta
  corriente + the dollar account (`simulate.ts`), and the payday sweep sends what is above the
  top straight to the broker (`depositBrokerClp` / `depositBrokerUsd`, the «Sweep» block). Known
  needs of the next six months (`upcomingCashNeeds`: a car, the December APV, a prepago, a play,
  a move-in deposit, a month between jobs) are reserved **in checking**. In the US the band is
  1 / 2 / 3 months on «Checking (US)» (`US_LIFE.cashBand`) and the surplus goes to IBKR by ACH.
- **No savings vehicle exists.** «Savings» holds only the brokers' idle cash (Broker USD, the
  US$2.000 IBKR cushion). The SGOV reserve (US$15.000) is a stock inside IBKR (Brokerage). The
  term deposits (`DAP`, 2021-03 → 2023-12) were the one savings product and are closed.
- **The Chilean checking stays fat after the move.** The monthly wire keeps the cuenta corriente
  at two months of the trailing *Chilean* expenses plus `chileUpcomingNeeds`, and that trailing
  average is the pre-move lifestyle, not the fixed costs that remain in Chile (the two cuotas
  net of the rents, gastos comunes, contribuciones, the Chilean subscriptions, the card's
  payment). That is the ~CLP 10 M on the card today.

### Story decision (proposed)

- **Chile, from the second job (2019-05): a money-market fondo mutuo** («Fondo Mutuo Money
  Market», cuotas under Cash savings) holding the cushion and the pie savings. Realistic for a
  Chilean saver, and the app already values cuota accounts from a `fund_unit_daily` series
  (`writeFundSeries` builds the demo's APV and 401(k) series; this one accrues the story's
  30-day term-deposit curve `DAP_RATE_PCT_30D_FROM` annualized less a 0,3 % fee, daily, so the
  line rises smoothly and reads a small positive P/L every month). The DAP episode stays beside
  it (2021–2023 the DAP takes part of the savings and comes back). Written directly like the
  test person's «Fondo Moderado» (no document importer for a fund; the cuenta corriente's
  cartola prints the transfers «TRANSF A <AGF>» / «RESCATE FM»).
- **US, from the first US payday: a high-yield savings account** («DEMO BANK TEXAS SAVINGS»,
  a `usd` ledger under Cash savings, like IBKR USD) holding the US cushion and the US reserves
  (the car, the Roth contribution, the December flight). Monthly interest as `savings_earnings`
  rows at `usdYieldPct(year)` − 0,3 (the IBKR sweep already books interest this way), credited
  on the last day of the month. Transfers checking ↔ savings appear on the US bank statement as
  «ONLINE TRANSFER TO SAVINGS …» / «… FROM SAVINGS», internal transfers to the app (never gastos
  lines; the IBKR ACH rows already take that path).
- **Checking keeps one to two months.** Both bands become low 1 / target 1,5 / high 2 months of
  trailing expenses; what used to be the checking band (3–6 months) becomes the **savings
  band**, measured on savings alone, plus the reserves. Payday order: (1) top checking up to its
  target from savings when below its low, (2) move checking's excess above its high to savings,
  (3) sweep savings above the savings band's high + reserves to the broker (today's rule, on a
  different account). A reserved need moves savings → checking the month before it is paid
  (the car, the pie, the December APV), so checking never dips and the reserve is visible in
  savings until then. Net: the Cash bucket total is unchanged; only its split moves.
- **After the move the Chilean side is sized on Chile's fixed costs**, not the old lifestyle: the
  wire covers `chileFixedCosts(month)` (cuotas − rents, gastos comunes, contribuciones, the
  Chilean subscriptions, the card payment) × 1,5 plus `chileUpcomingNeeds`, and the Chilean fund
  keeps about three months of those costs (the rest was swept to the broker before the move —
  the pre-move liquidation that funds the move already sells SPY; the fund is sold down to its
  new target the same month).
- **Expected card:** Checking (US) ≈ 1,5 months of Austin spending (~US$5–6k), Cuenta corriente
  ≈ 1,5 months of the Chilean fixed costs (~US$2–3k), Savings ≈ US$20k+ (HYSA with the reserves,
  the Chilean fund, the brokers' idle cash). Net worth and the sanity target are untouched.

### What changes (files)

- `person.ts`: `savings: { clp: { fundName, from } | null; usd: { bankLabel } | null }` on
  `Person` (the test person: both null, so the suite's fixtures and figures do not move);
  `CASH_BAND` → `CHECKING_BAND` {1, 1,5, 2} and `SAVINGS_BAND` {3, 4,5, 6} (`trailingMonths`
  6); `US_LIFE.cashBand` → the same checking numbers.
- `simulate.ts`: two `CashAcct`s (`savingsClp` as fund cuotas — the book keeps pesos and units
  like `fund`; `usSavings` as dollars), the payday order above, `upcomingCashNeeds` /
  `usUpcomingNeeds` reserved in savings and released the month before, `chileFixedCosts` for the
  wire, the interest rows, the DAP's principal drawn from the fund. `totalCashClp` keeps
  counting everything (the invariants and the trace read it).
- `generate.ts`: the two accounts under `cash_eqs__cash_savings` (`cash_eqs__cash_savings__fm_money_market__fund`
  with `series: MONEY_MARKET_SERIES_KEY`, `cash_eqs__cash_savings__us_savings__usd`); the series
  rows (`writeFundSeries` takes an explicit rate curve: a `rate` option beside `equityShare`);
  the US statement's transfer rows (`render.ts`, both directions); the checking cartola's
  transfer rows for the fund.
- `invariants.ts`: `monthsOutsideBand` reads the savings band; the US checking checks gain the
  savings account's ledger = story balance; `cash_unexplained` unchanged (transfers are cash).
- Tax: the HYSA interest is taxable interest — line **2b** on the 1040. `f1040LinesFromW2s`
  takes an `interestUsd` input (0 today) read from the account's `savings_earnings` of the
  year, in the draft (`f1040Draft.ts`) and in the simulator's own estimate, so the April loop
  still converges on pass 1 for the dollar side. The Chilean fund's rescates are fund
  redemptions for the F22 only for `fintual_cert_*` series (`f22AppEstimates.ts` selects by
  series key), so the money-market fund declares nothing — correct for a money-market fund with
  no rescate gain to speak of; noted in the plan doc, not modeled.
- `AGENTS.md`: the cash bullet of «The synthetic databases are a person told through documents».

### Checks

Both generations (`generate-demo-data.ts --test` and the demo person on the synthetic market),
`cd server && npm run test`, the demo on the local pair (`server-demo-us` / `client-demo-us`):
the Cash card's split, the US bank statement rows, «Flujos de patrimonio» showing the savings
transfers as internal, the flows overview's «sin explicar» still within the invariant.

## 2. The real-estate card nests both properties under «centro» (client)

The data is right: in the demo DB Centro and Vitacura are direct accounts of the `real_estate`
group (one asset group, one portfolio group). The extra level is `buildRealEstateCardBreakdown`
(`client/src/dashboardCardBreakdown.ts`, from the wave-3 commit 06fc97ec): it always pushes a
depth-0 head line labelled `props[0].name.toLowerCase()` carrying the group total, then — with
several properties — each property at depth 1 and its value / mortgage at depth 2. With one
property the head line *was* the property; with two it is a parent named after the first.

Fix: with several properties, no head line — each property at depth 0 (its name as the server
gives it), its value and mortgage at depth 1, like the Cash card lists Checking and Savings; the
single-property rendering stays. `dashboardCardBreakdown.test.ts` gets the two-property case.

## 3. «spy» on the cards, «SPY» everywhere else (server)

A strip card and its breakdown show the row's `nav_label`, which the server builds in
`accountRowProfileFields.ts` (`brokerageNavLabel` / `retirementNavLabel`): a hardcoded table by
kind slug — `spy` → «spy», `vea` → «vea», `bitcoin` → «bitcoin», `eth` → «ether»,
`fintual_risky_norris` → «risky norris», the excel-era APV import keys → «apv-a-fintual» … —
the personal instance's old lowercase card convention. The demo's SPY account sits on the leaf
`brokerage_acciones__spy`, so its kind is `spy` and the card reads «spy»; the group page's
accounts table reads the account's name. Every other account already reads its name.

Fix: `nav_label` = the account's name, the two tables deleted (`accountNavLabel` keeps its
shape; the client picks it as before). On the personal instance the cards then read the
accounts' names (SPY, VEA, Bitcoin, Ether, the APV accounts as named), the same words as their
pages and the sidebar. Tests: `accountRowProfileFields` cases in `dashboardAccounts` /
`accountDetailBundle.dashboardRow.test.ts` that assert the lowercase labels, if any, move to the
name.

## Execution

The immediate fixes first, in two waves, one «go» each; the leftovers of the US-chapter plan
come after, in their own plan.

- **Wave 1 — the two card fixes (small, one agent, no generator change):** items 2 and 3, each
  with its test; typecheck, the client and server suites; checked on the local demo pair
  (`server-demo-us` / `client-demo-us`): the Real estate card lists Centro and Vitacura at the
  first level, the Brokerage card reads SPY.
- **Wave 2 — cash in savings (generator):** item 1 — `person.ts` + `simulate.ts` +
  `generate.ts` + `render.ts` + invariants + the 1040 interest line + AGENTS; both generations
  and the server suite; the local pair checked on the Cash card, the US statement's transfer
  rows and «Flujos de patrimonio».
- Each wave is merged to `main` on the user's word (the home server deploys from it); the demo
  release (`npm run release:demo`) once both are on `main`, on the user's word.

## Circle back afterwards (from `docs/demo-us-chapter-plan.md`, not scheduled here)

Phase 8 (optional, app features first): a non-resident F22 mode, UCITS ETFs at IBKR (a London
calendar and pricing), options as an instrument kind, a return to Chile. And the «Open after the
plan» leftovers: the flows overview's missing fx leg on checking dollars; the F22's medium-
confidence readings (the foreign dividends' credit in 1018 vs 746, the foreign salary base, dollar
spending abroad as lot disposals); `syncExpenseLinksNow()` at ~46 s inside a transaction; a
`rent` bucket for the income chart; the modules still reading the peso checking list only; the
DAP import key; the Roth's SPY dividends and `accountIdForEquityTicker("SPY")` throwing with two
SPY holders; DJ 1898's columns named after the loans; the About / tour copy unseen in a browser;
the order-dependent `merchantExpenseNotes.test.ts` flake; the merged `us-*` worktrees. Each is
picked, or dropped, in a plan of its own once the waves above are on the demo.

## Status (2026-11-09): both waves built, merged into the integration branch

- **Wave 1** (`us-cards`, 4e473aee + 175b30f7, plus d287ca65 on the integration branch): the
  real-estate card lists several properties at the first level, and the one-property head line
  reads the name as given; `nav_label` is gone end to end (nav-snapshot cache v19) — a card
  line's label is the account's name.
- **Wave 2** (`us-cash`, 3d5e79f7 + 7c9e7e38 + 792056fe): `Person.savings` (a money-market fund
  from the second contrato job, 2020-08, and «DEMO BANK TEXAS SAVINGS» from the move),
  `CHECKING_BAND` {1, 1,5, 2} / `SAVINGS_BAND` {3, 4,5, 6} (the test person, with no savings,
  keeps the savings band on checking: its database is byte-identical), the reserves in savings
  and moved to checking the month before, the wire sized on `chileFixedCosts` (gross of the
  rents, which land in checking before the wire), the US savings interest as 1040 line 2b
  (`usBankAccounts.ts`: a dollar account declared under a US issuer in `bank_account_numbers`)
  and F22 1104. Demo today: Checking (US) US$4,9k, cuenta corriente CLP 5,7 M (1,5 × the fixed
  costs plus the December APV reserve), savings US$19,8k + the fund CLP 8,4 M; net worth
  US$445.980 against the 445k target; the April loop converges in 3 passes.
- Checks on the merged tree: typecheck, client 85 files / 475 tests, server 495 files / 3283
  tests, both generations; the local demo pair checked on the dashboard (the Cash, Real estate
  and Brokerage cards).
- Noted by the wave-2 build, not acted on: IBKR USD receives little abroad (US$2,1k) because the
  car, the Roth, the Chilean April F22 and the Chilean deficit now take the US surplus — the
  story's arithmetic; revisit the US salary or the F22 size if IBKR should grow.
