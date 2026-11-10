# Demo person, next: a declared tax residency, UCITS ETFs at IBKR, options

Plan (2026-11-10). Three app features the demo person is the first user of. Each one is a
general feature — a real person may declare a residency, hold a London-listed ETF or trade a
covered call — and the demo tells the story that exercises it. Facts about the code were
checked 2026-11-10 on the merged tree (`main` 37a30948) by three read-only passes; the law is
stated as readings to VERIFY in each wave's research step, each wave quoting its sources in the
module header, as wave C of `docs/demo-next-steps-plan.md` did.

This plan supersedes two lines of `docs/demo-us-chapter-plan.md`: «Chilean tax resident
throughout» (line 36) and the deferral of a non-resident F22 mode (line 214). It replaces the
«dollar spending abroad as lot disposals» decision: once the person is not a Chilean resident,
Chile sees no dollar lots at all, so the posture only matters for the resident years, where the
module's default (Oficio 2573) stays.

## 1. A declared tax residency

### What the user said, and what the law says

The user's question: a person living in the United States with US holdings — why keep declaring
them in the Chilean return? Only Chilean income should count from then on.

That is the right outcome, and the law gets there, but not through discretion. Readings (verify):

- **Chile taxes by domicile or residence** (LIR art. 3): a person domiciled or resident in Chile
  is taxed on worldwide income; anyone else only on Chilean-source income (art. 10 names the
  source: real property where it sits, shares by the issuer's country, …). The 2020 reform's
  residence test is more than 183 days in Chile in any twelve-month period (Código Tributario
  art. 8 N° 8). Domicile is the harder one: LIR art. 4 says absence alone does not end it while
  the «asiento principal de sus negocios» stays in Chile — the SII has held that two rented
  apartments and a mortgage can be such a seat, and that a person must positively lose
  domicile (new household, main employment and family abroad). The treaty with the US (in force
  2024) breaks a dual residence by permanent home, centre of vital interests, habitual abode,
  nationality (art. 4). LIR art. 103 asks a person who loses domicile and residence to declare
  the IGC up to the departure.
- **A non-domiciled person pays the Impuesto Adicional**, not the IGC (LIR arts. 58–60): 35 % on
  Chilean-source income the payer did not withhold, declared on the F22 (the codes and line are
  a research item: the AT2026 instructions for non-residents). The treaty leaves income from
  Chilean real property taxable in Chile (art. 6). DFL-2 art. 15 exempts the rents of two
  qualifying dwellings from income tax; whether the exemption reaches the Impuesto Adicional is
  a research item (the text exempts «impuesto a la renta», the SII's reading to confirm).
  The art. 107 10 % único regime (2022–2026) names taxpayers «con domicilio o residencia en
  Chile»; a non-resident's art. 107 gain stays an ingreso no renta (verify). Crypto sold at a
  Chilean exchange and a Chilean fund's redemption gain are Chilean-source for a non-resident
  (verify the SII's position on digital assets' source).
- **The US taxes a resident alien on worldwide income** (substantial presence or green card).
  Chilean rents go on Schedule E (expenses: mortgage interest, contribuciones, gastos comunes,
  the agency's commission, insurance; depreciation of the building share over 30 years ADS for
  foreign residential property, no DFL-2 exemption); Chilean interest on Schedule B; the Chilean
  tax paid on the rents is a foreign tax credit on Form 1116 (passive category); crypto on Form
  8949 / Schedule D. A Chilean fondo mutuo and the IPSA ETF are **PFICs** in US hands (Form
  8621; the default regime is punitive, the mark-to-market election the usual way out), and the
  accounts must be reported on FinCEN 114 (FBAR, aggregate over US$10k) and Form 8938.

### The model: declared, dated, never inferred

- **`tax_residency_periods`** (migration 302): `jurisdiction` (`cl` | `us`), `from_date`,
  `to_date` (null = open), `note`. One open period at a time; a new period closes the previous
  one the day before. Declared by the user (`GET|POST /api/tax-residency`, a panel section
  under Settings) or by the demo generator — the app never infers it from the stubs, the days
  abroad or the accounts, and the tax page says so (the module header and a `residency` block
  on both payloads: «Declared, not inferred. Chile may hold that domicile continued while the
  main seat of business stayed in Chile (LIR art. 4); this return assumes the declared date.»).
  That is the «small comment on the assumptions» the user asked for, as data a user can read.
- **Readers** (`taxResidency.ts`): `taxResidencyOn(ymd)`, `residencyForIncomeYear(year)` →
  `{cl: "full" | "none" | {through: ymd}, us: "full" | "none" | {from: ymd}}`. A year with no
  period declared is Chile-resident, as today (nothing changes for an instance that never
  declares one).
- **F22 for a non-resident year** (`buildF22Draft`): the base is `nonresident`; only
  Chilean-source items enter — the rents (non-DFL-2 at the Impuesto Adicional; DFL-2 shown
  exempt or taxed per the research), art. 107 (INR, shown with no code), crypto at Buda and the
  Chilean fund's redemptions (Adicional, per the research), Chilean interest; the US salary,
  foreign dividends, foreign interest, foreign share gains and the dollar lots do not enter,
  and the rows say «not declared: non-resident» rather than vanish. The residents' deductions
  and credits go with them: 750 / 751 (mortgage interest), 765 (APV), 1637 (the contribuciones
  credit is against the IGC; verify whether anything equivalent exists against the Adicional).
  The departure year is split: worldwide through the declared day (the Chilean salary, the
  resident computation as today), Chilean-source after it; LIR art. 103's departure return is
  noted, not built. The chain gains an Adicional identity (verify the codes: the AT2026 line
  for art. 58–60 income and its tax) beside the IGC one.
- **1040 for a resident year** (`buildF1040Draft`, `F1040Inputs`): Schedule E (one per place,
  from the rent income overrides, the bills and the mortgage ledger, depreciation from the
  purchase price's building share), Schedule B (the Chilean bank and fund interest, foreign
  accounts yes), Schedule D / 8949 (crypto, and the fund if sold), Form 1116 (the Chilean tax
  on the rents, from the F22 of the same income year — settled or drafted), and 8621 only as a
  flag (`pfic_holdings`: the fund and the IPSA ETF, with the user's decision below). Line 2b
  stays the US bank interest; Schedule B carries the rest. `availableUsTaxYears` keys off the
  declared residency, not the first stub.
- **No cycle:** in a resident year the F22 credits the 1040's tax (today); in a non-resident
  year the 1040 credits the F22's Chilean tax. The departure year is still one direction: Chile
  sees no US income after the day, the US sees the Chilean rents of its part with the credit.
  The generator's April loop keeps its structure (US then F22 per pass), the F22 of the split
  year reading the filed 1040 and the 1040 of later years reading the F22's Adicional.
- **Demo:** `person.ts` declares `taxResidency: [{cl, from birth}, {us, from: 2024-04-15}]`
  (the move; the stubs start 2024-04-19), written before the loop. Expected effect: AT2025 keeps
  the Chilean salary of Jan–Apr and drops the US salary; AT2026 drops to the rents (Vitacura at
  the Adicional, Centro DFL-2 per the reading), the fund, the ETF and the crypto; the 2025 1040
  gains Schedule E income on both rents and the 1116 credit. Net worth moves (the Chilean tax
  falls from ~16 M to the Adicional on one rent; the US tax rises); `netWorthTargetUsd` is
  restated once, from the data.
- **A decision for the user — the PFICs.** On 2024-04 the Chilean cushion sits in «Fondo Mutuo
  Money Market» (the cash-savings plan) and the IPSA ETF is bought 2025-06. Both are PFICs for a
  US resident. Two stories: (a) **the advised one** — he moves the Chilean cushion to a DAP
  ladder / cuenta de ahorro at the move (bank deposits are not PFICs) and does not buy the IPSA
  ETF as a US resident (the Chilean art. 107 story then needs a resident-era holding instead:
  bought 2023, sold before the move); (b) keep both and file 8621 with the mark-to-market
  election each year (the app computes the MTM inclusion). (a) is what an adviser says and is
  simpler to model; (b) exercises more of the app. Taken: (b) — see the decisions below.

### Checks

- The F22 for every year up to the declared day is unchanged to the peso; the first
  non-resident year reproduces by hand from the rents; the departure year's two parts add up.
- The 1040's Schedule E ties to the rent overrides and the bill rows; 1116 ≤ the Chilean tax.
- A filed 1040 and a filed F22 of the split year both reproduce (`assertF1040Identities`,
  `assertF22Identities` with the Adicional identity).
- Both generations, the April loop converging, the local demo pair's tax tabs read.

## 2. UCITS ETFs at IBKR: a fourth market kind

### Story

The estate-tax reason for UCITS belongs to the **Chilean-resident years**: a non-resident alien
holding more than US$60k of US-situs assets (SPY at a US broker) is exposed to US estate tax
with no treaty relief for Chile, and Irish UCITS avoid the situs and halve the dividend
withholding inside the fund. A US resident has the opposite problem: a UCITS fund is a PFIC.
So the story is: **IBKR opens 2023-05, not 2024-05**, while he is a Chilean resident, buying
CSPX.L (S&P 500, accumulating) and VWRA.L (all-world, accumulating) monthly with dollars wired
from Fintual as today; in **2024-03, before the move, he sells both** (an adviser's PFIC
warning), realizing foreign share gains on AT2025's F22 as a resident; after the move IBKR buys
the US-domiciled SPY and SGOV as it does today. The London market then has a real span of
~10 months to show, and both returns carry a beat from it. The alternative — buying UCITS as a
US resident — is the wrong behaviour and is not told.

### What the code needs (from the market-kind pass)

- **The silent fallback is the risk:** `equityMarketKind` ends in `?? "nyse"` and most readers
  branch `santiago ? … : nyse`, so `CSPX.L` would be priced on NYSE sessions and synced by
  `stocks_nyse` without an error. Rule: a ticker with an exchange suffix must be known (`.SN`,
  `.L`) or registered in `market_symbols`, else `equityMarketKind` throws; bare symbols stay
  NYSE.
- **`"london"`** in `EquityMarketKind` / `MarketSymbolKind`, `market_symbols.market_kind` CHECK
  rebuilt (migration 303), `classifyYahooSymbol` mapping `Europe/London` (refusing `GBp`
  pence quotes as it refuses any currency but USD / CLP), `londonSession.ts` (Europe/London
  wall clock, 08:00–16:30, `dateAtTimeZoneWallClock`), `LSE_CLOSED_YMD` + `isLondonTradingDay`
  / `priorLondonSessionYmd` in `marketHolidays.ts` (England and Wales bank holidays 2023–2027;
  the 24 / 31 Dec half days modelled as full sessions, stated), a `london` branch in
  `equitySessionClosedForDay`, `shouldUseLiveEquityQuote`, `equitySessionYmdForTicker`,
  `equityDisplaySessionYmd`, `resolveLondonEodQuote`, `equityHeldSessionQuote`,
  `tickerDayDisplay.ts` (`"london"` calendar), `yahooBarYmdFromUnix` and the weekend filter in
  `equityYahooEod.ts`, `streamTickInSession`, `pricedSessionOpenPredicate` (the live cadence
  gets a London open edge), `watchlistStats.ts`'s week anchor, `dailySeries.ts`'s `market_day`.
- **`stocks_london`** sync source: `syncSourceIds.ts`, a `SYNC_SOURCES` row (London day kind,
  due 16:40 London on an LSE day, carry-over to the prior LSE day, `keepsForcedWhileStale`),
  `equityEodLondonSyncDue` / `equityLondonEodCaughtUp` / `syncStocksLondonFromYahoo` modelled on
  Santiago (capped at the due session; dividends written too, for a distributing line later),
  `listWatchlistLondonTickersForEodSync`, `inferSyncSourcesForAccount`, the
  `account_sync_sources` CHECK rebuilt (same migration 303, template 179 / 182), the enumerations
  in `globalSyncAll.ts`, `globalSyncScheduler.ts`, `syncRunLog.ts`, `globalSyncState.ts`,
  `routes/sync.ts`, the i18n labels, `scheduleMeta`'s `stocks_nyse` special case generalised.
- **Dividends and tax:** nothing for accumulating lines; `foreignShareGainsForYear` already
  takes any USD equity account that is not art. 107, so the 2024-03 sale lands in 1104 as a
  resident's foreign share gain. A distributing UCITS line later records `withholding 0,
  jurisdiction IE` in `movement_dividend_details`.
- **Demo:** `DEMO_TICKERS` + `CSPX.L` / `VWRA.L` from 2023-05 (check Yahoo's history reaches
  it; the market asset's spec grows, so the home server publishes the new asset BEFORE the demo
  release, as `docs/demo-market-publish-plan.md` requires — a build refuses an asset built for
  less than its spec), `EQUITY_ANCHORS` for the synthetic market, the London trading-day skip in
  the synthetic writer, `IBKR.from` 2023-05 with a `ucits` phase (monthly buys, the 2024-03
  sell-all) before the SGOV / SPY phase, `generate.ts` stripping `.L` from the leaf name as it
  strips `.SN`, a `market_symbols` seed or the suffix rule.

### Checks

Live gates on a London weekday (08:00–16:30 London = 04:00–12:30 Chile in winter): the quote
is live inside, the held print after, the EOD bar from 16:40; a UK bank holiday is flat with a
0 day change; the sync panel shows the source; the demo's foreign share gain in AT2025;
`equityMarketKind("XYZ.PA")` throws.

## 3. Options as an instrument kind

### Story and scope

Small and realistic: at IBKR, as a US resident, from 2025: a covered call sold every quarter on
a round lot he holds there, and a protective put bought once a year; one to two contracts,
most expiring, one assigned. The agent picks the underlying from the data (IBKR's SPY stack
reaches 100 shares late, if at all, at ~US$600 a share; a cash-secured put on a cheaper ETF he
holds, or a covered call on it, is the honest alternative) and states the choice. Options start
AFTER the move on purpose: a Chilean resident's derivatives fall under Ley 20.544, which is not
modelled — a resident year with option events throws «derivatives under Ley 20.544 are not
modelled», the only Chilean-side code of this feature.

### Model (from the instrument pass)

- **A contract is its own account**, like a stock: `option_contracts` (migration 304:
  `account_id`, `underlying_ticker`, `right` C | P, `strike`, `expiry`, `multiplier` 100,
  `occ_symbol`), a `brokerage_opciones` bucket (kind_slug `options`) holding one leaf per
  contract series, named by the OCC symbol; `equity_ticker` stays NULL so the EOD sync, the
  watchlist and `accountsWithEquityTicker` never see it. A closed or expired contract is
  chart-inactive (0 contracts) and leaves the nav as an emptied account does.
- **Holding** `{kind: "option", underlying, right, strike, expiry, multiplier, quote: "usd"}`
  and `QuantitySource {kind: "option_contracts"}` in `accountProfile.ts`, placed before the
  `usesEquityMtm` branch; **signed** contracts (a short call is negative), and
  `qtyMarkNativeValue` applies the multiplier. Every place that assumes positive units gets an
  option case: `unitsDeltaForAccountMovement` (per-kind sign rules, as `stock_sell` has),
  `equityBrokeragePositionMeta` (`units_kind: "contracts"`, signed, never «vanishing» at ≤ 0),
  the `units > 0` check in the stock mark, `accountTodayValue`, `accountValue.ts`.
- **Price:** no history source exists for a contract, so `holdingPriceAt`'s option branch marks
  **intrinsic value** from the underlying's as-traded close (`max(0, S − K)` / `max(0, K − S)`)
  while unexpired and 0 after expiry, never a book mark; a live chain mid today is a later
  addition. Stated on the account page: «marked at intrinsic value; time value is not priced».
- **Flow kinds** (`BROKERAGE_FLOW_KINDS`, a new `OPTION_UNITS_FLOW_KINDS`, the client's
  mirror, `validateBrokerageTransferEndpoints`, `signedUsdDeltaForAccountMovement`,
  `BROKERAGE_NON_CASH_FLOW_KINDS`, `flowsDepositsReconciliation`): `option_sell_open` (contract
  account → USD cash, premium, −n), `option_buy_open` (cash → contract, premium, +n),
  `option_buy_close` / `option_sell_close`, `option_expire` (single-leg, units only, like
  `stock_split`), `option_assign` = two rows linked by `option_assignments` (the contract
  closing units-only, plus the `stock_sell` at the strike from the stock account — or a
  `stock_buy` for an assigned put).
- **Capital and P/L:** a premium is **capital out of the contract account** (the
  `dividend_payout` mirror in `equityBrokerageCapitalFlows.ts`: −capital on the contract, + on
  cash), so the contract account's value (−intrinsic) against its aportes (−premium) gives the
  position's P/L and expiry turns the premium into P/L with no further event; an unknown kind
  must never fall into the generic «dollar inflow = deposit» branch (make that branch throw on
  an unlisted kind).
- **Tax:** `optionTaxLotEvents.ts` (short lots: open on sale, close on expiry / buy-back /
  assignment; a premium of an expired short option is a short-term gain on the expiry day; an
  assigned call adds the premium to the stock sale's proceeds, an exercised long put adds its
  premium to the basis) feeding the Schedule D / 8949 path the residency feature builds;
  `equityTaxLotEventsFromRows` keeps throwing on option kinds, which never reach it;
  `foreignEquityAccounts` excludes contract accounts.
- **Client:** `units_kind` «contracts» on the position, the contract's terms on the account
  page, the movement form's option kinds, the add-account form's contract input (underlying,
  right, strike, expiry).
- **Demo:** the events beside the dividend loop in `simulate.ts` (strike from
  `market.close(underlying, day)`, ~5 % OTM, 45 days; the assigned one when the close crosses
  the strike), the 1099-B story in `taxDocuments.ts`, `invariants.ts` option-aware (contracts
  net to zero at every expiry).

### Checks

A short call's value is −intrinsic and its P/L the premium less intrinsic, day by day; expiry
with no event; an assignment's three legs reconcile (contracts 0, shares −100 n, cash +strike
× 100 n) and the aportes identity holds on every account and the bucket; the 1040's Schedule D
carries the premiums; a Chilean-resident year with an option event throws.

## 4. L2 — the instrument registry: exchange and currency are registered facts, not a suffix

### Why (the user's question, 2026-11-10)

Wave L decides a ticker's market from its Yahoo suffix (`.SN`, `.L`, `.NYB`) when it has no
`market_symbols` row, and `marketQuoteCurrency` reads the currency the same way. The user asked
for the exchange to be a stored fact about the instrument, and for the app to be price-provider
agnostic. Both are right: the suffix is Yahoo's spelling, not an exchange; the real identifiers
are the ISIN and the MIC (CSPX is IE00B5BMR087 on XLON). Today the registry exists (migration 210
+ 303: `ticker`, `quote_currency`, `market_kind`, `name`, `exchange`, `instrument_type`,
`verified_at`) but only the watchlist writes it; every stock account created before 2026-10-04,
the proxy basket, the benchmarks, the demo's accounts and the two coins fall through to the
suffix table (`EXCHANGE_SUFFIX_MARKET`) and the hard-coded `TICKER_MARKET`.

### The model

- **The registry is the one source of an instrument's facts.** `market_symbols` (name kept —
  22 modules read the currency and 16 the market through two functions; the table is "the
  instrument registry" in the docs) gains, in migration 305: `mic` (ISO 10383, nullable: XNYS,
  XNAS, ARCX, XLON, XSGO; null for a coin or an index), `isin` (nullable), `display_symbol`
  (the symbol without a provider's exchange suffix: CSPX, CFIETFIPSA, SPY — what the leaf name
  and the position show), `source` (`yahoo` | `coingecko` | `bolsa_santiago` | `declared`: who
  stated the facts) beside `verified_at`. `market_kind` stays the calendar/session key the
  readers need (`nyse`, `santiago`, `london`, `crypto24`); `exchange` keeps the provider's own
  exchange name as provenance.
- **The ticker stays the app's instrument key**, spelled today as Yahoo's symbol in every row
  (`equity_daily`, `live_market_quotes`, `accounts.equity_ticker`, `option_contracts.
  underlying_ticker`, the benchmarks, the proxy basket's `price_ticker`). Decoupling the key
  from the provider's symbol (a `market_symbol_provider_ids(ticker, provider, provider_symbol)`
  map, an ISIN+MIC key) is a later plan: Yahoo is the only equity provider, every key equals its
  Yahoo symbol, and renaming the key across the price tables is a big-bang the facts do not need.
- **Readers never parse a ticker.** `equityMarketKind(ticker)` and `marketQuoteCurrency(ticker)`
  return the registered row's fields or THROW («<ticker> is not registered; run
  `register:market-symbols`»). `EXCHANGE_SUFFIX_MARKET`, `TICKER_MARKET` and the `.SN → clp` rule
  are deleted; `generate.ts` names a leaf from `display_symbol`, not by stripping `.SN` / `.L`.
  `check:conventions` flags `endsWith(".` and `lastIndexOf(".")` on a ticker outside the
  provider adapters.
- **Price providers are adapters behind one interface** (`server/src/priceProviders/`):
  `describeSymbol(symbol) → InstrumentFacts {quote_currency, market_kind, mic, exchange, name,
  instrument_type, display_symbol}`, `dailyCloses(symbol, range)`, `liveQuote`, `search`. The
  Yahoo adapter wraps `yahooSymbols.ts` / `equityYahooEod.ts` / the stream: the
  `exchangeTimezoneName → market_kind` and `exchangeName → mic` tables, the pence refusal and the
  suffix stripping live INSIDE it — the only code that knows a Yahoo symbol's shape. The
  CoinGecko and Bolsa de Santiago fetchers stay where they are and are declared as the adapters
  of what they already do (EOD only), not forced into every method; the interface's optional
  methods say so. Nothing outside the adapters imports a `yahoo*` module for a fact about an
  instrument (an audit of the 64 modules naming Yahoo: most name it in a comment or a sync
  source label — those stay; the imports of `classifyYahooSymbol` / `verifyYahooSymbol` and the
  meta-currency assertion in `equityEodSync.ts` go through the adapter).
- **Registration is the only door.** `registerInstrument(ticker, {provider})` asks the adapter
  and writes the row; called by the stock account creation (`createPanelAccount.ts`, which
  verifies the symbol today only for the watchlist), the option underlying (O1), the watchlist
  add (already), the benchmark seed, the proxy composition sync (`price_ticker`), the EOD and
  live syncs refusing an unregistered ticker in their lists (they read the registry for the
  list, so none can be). The demo generator **declares** its instruments (`DEMO_TICKERS` gains
  `market_kind`, `quote_currency`, `display_symbol`, `mic`; rows written with `source:
  "declared"` before any account) — the synthetic path never calls a provider; the real-market
  loader cross-checks the declared facts against the provider's (a mismatch fails the build).
- **The backfill is a report-first script that fails loudly**, `server/scripts/register-market-
  symbols.ts [--apply]`: every ticker in use (`accounts.equity_ticker`, `option_contracts.
  underlying_ticker`, `watchlist_items`, `benchmarks.ticker`, the proxy basket holdings' price
  tickers, `market_display_series`, distinct `equity_daily` tickers) without a row, asked of the
  provider, printed with the facts, written with `--apply`; a ticker the provider cannot classify
  (an unknown timezone, a currency outside USD / CLP, no meta) fails the script. The deploy runs
  it with `--apply` BEFORE restarting the server (`scripts/server-deploy.sh`; the script applies
  pending migrations as every `db.ts` import does — intended here, it needs 305), so a ticker the
  rule would throw on fails the deploy and rolls back instead of taking the first request down.
  This replaces the ssh check of the suffix rule: the script finds the odd ticker itself. On the
  demo the generator's declarations make it a no-op.

### Checks

Every ticker on both generated databases has a row (`register-market-symbols.ts` reports none
missing); `equityMarketKind("XYZ.PA")` and `marketQuoteCurrency("ANY")` throw without a row,
whatever the suffix; a Yahoo meta with `Europe/London` + USD registers london / usd / XLON, with
`GBp` is refused; the adapter audit (`check:conventions`) passes; the London and Santiago
session tests still pass reading registered rows; the demo and Vitest generations, both suites.

## Waves

- **Wave R1 — residency, Chile (one agent, research first):** the sources above read and quoted
  (LIR arts. 3, 4, 10, 58–60, 103, 107; Código Tributario art. 8; DFL-2 art. 15; the AT2026
  instructions for non-residents; the treaty arts. 4, 6, 23); migration 302; `taxResidency.ts`,
  the API and the panel section; the F22's non-resident base, the split year, the Adicional
  identity, the rows that say why a code is absent; the demo's declaration and the April loop
  re-converged; the PFIC decision applied to the story (default (a)).
- **Wave R2 — residency, US (one agent):** Schedule E, B, D / 8949, Form 1116, the 8621 flag,
  `availableUsTaxYears` off the residency; the 1040 reading the F22's Chilean tax; the demo's
  2025 return re-settled.
- **Wave L — the London market (one agent):** everything in §2, the fail-fast suffix rule
  first; the home server publishes the grown market asset; the IBKR story moved to 2023-05 with
  the 2024-03 sale.
- **Wave O1 — options, model and valuation (one agent):** migrations 304, the holding, the
  flow kinds, the capital rule, the position meta, the client forms.
- **Wave L2 — the instrument registry (one agent; after L, before the push to main):** §4 —
  migration 305, the provider adapters, registration at every door, the deleted suffix rules,
  the report-first backfill script wired into the deploy, the generator's declared instruments.
- **Wave O2 — options, tax and story (one agent):** the lot events, Schedule D, the demo events,
  the invariants.
- Each wave: `cd server && npm run test`, both generations, the local demo pair; merge to `main`
  on the user's word; one demo release after R2 (the tax story) and one after O2. R1 before R2
  (R2 reads the Adicional); L and O1 independent of both and of each other; O2 after R2 and O1.
  Started 2026-11-10: R1, L and O1 in parallel (worktrees `us-r1-residency`, `us-l-london`,
  `us-o1-options`, deps from `us-deps`), decisions 2–4 at their proposed values; L2 planned the
  same day after the user's question on the suffix rule, to land before the three go to main.

## Decisions for the user

1. The PFIC story: (a) the cushion to a DAP ladder at the move and no IPSA ETF as a US
   resident, or (b) keep both with the 8621 mark-to-market election. **Taken 2026-11-10: (b).**
   The IPSA ETF only exists since 2025-05 on the real market, so it cannot be a resident-era
   holding sold before the move; keeping both and electing mark-to-market is the consistent
   story, exercises more of the app (8621 in R2) and leaves R1's story untouched.
2. The declared date: 2024-04-15, the move (proposed), or the first stub, 2024-04-19.
3. UCITS as a resident-era holding sold before the move (proposed), or not at all.
4. Options after the move only (proposed; the Chilean derivatives law stays unmodelled).

## Status (2026-11-10): R1, L and O1 built in parallel, merged into the integration branch

- **R1 (`us-r1-residency`, 6 commits):** `tax_residency_periods` (migration 302, hook, write log),
  `taxResidency.ts` readers and writers, `GET|POST|DELETE /api/tax-residency`, a Settings section;
  the F22 has a `regime` (resident | nonresident | split) beside its `base`: a non-resident year
  runs 158 → 32 → 34 (línea 72, 35 % Impuesto Adicional; 305 = 304 + 34 + 952 + 1830 − 198 − 833 +
  900), the departure year is two parts, every excluded item is listed with its reason
  (`nonresident`, `treaty_art13_8`, `fund_unico_withheld`, `withheld_at_source`, `no_igc`). Two
  plan readings corrected from the sources: a non-resident's art. 107 gain is still the 10 % único
  (N° 6–7, cost = cost paid), and the Chilean fund's gain is the administradora's withheld 10 %
  único (Ley 20.712 art. 82 B), not the Adicional; DFL-2 art. 15 exempts the rent from the
  Adicional too; convention art. 13(8) leaves a non-resident's crypto gain to the US. Unverified:
  the SII's position on a non-resident's crypto source; whether art. 13(8) reaches fund cuotas.
  Not built: LIR art. 103's departure return; DJ yearly figures stay whole in the resident part.
- **L (`us-l-london`, 4 commits):** `equityMarketKind` throws on an unknown exchange suffix
  (`.SN`, `.L`, `.NYB` known; a `market_symbols` row wins); the `london` kind through sessions
  (`londonSession.ts`, 08:00–16:30), the LSE calendar 2023–2027 from gov.uk, the live gates, the
  Yahoo bar dates, `stocks_london` (migration 303; due 16:40 London with carry-over), the
  currency assertion on every London write (a pence line is refused). Demo: IBKR opens 2023-05
  with US$1.000/month into CSPX.L + VWRA.L from the dollar checking (a standing order — the peso
  cushion's gates stopped the planned Fintual wires), sold 2024-03-12 (gain US$1.883,80 → 1104 of
  AT2025, resident part), the US phase from 2024-05 unchanged. Yahoo: both USD, history to 2010 /
  2019. **The market asset must be republished before the demo release** (the spec grew).
- **O1 (`us-o1-options`, 5 commits):** `option_contracts` + `option_assignments` + the
  `brokerage_opciones` bucket (migration 304), the `option` holding marked at intrinsic value
  (signed contracts, multiplier, 0 after expiry, a missing underlying close throws), six flow kinds
  with per-kind sign rules, premiums as capital out of / into the contract account, the generic
  dollar-inflow branch throwing on an unlisted kind, `assignOptionContract`, the add-account and
  movement forms. Identity proven on a fixture (sold call expiring: P/L = premium; assignment:
  three legs reconcile, bucket P/L +400). O2 still owes the tax lots, Schedule D and the story.
- **Merged tree:** typecheck ok (check-deps cycles unchanged at 37 / 102); client 85 files / 475
  tests; the demo regenerated (AT2025 split: resident part 158 22.572.983 incl. the UCITS gain,
  non-resident part 32 8.139.700 / 34 2.848.895, 305 3.271.365; AT2026 non-resident 32 13.136.220
  / 34 4.597.677; 1040 2025 line 24 US$27.453, owed US$282; `stocks_london` ok; CSPX / VWRA in
  the nav; the opciones group answers); server suite on a regenerated Vitest database 503 files / 3342 tests.
- **Before the push to main:** one query on the home server for a dot-suffixed ticker other than
  `.SN` / `.L` / `.NYB` (`accounts.equity_ticker`, `market_symbols`, the watchlist, the proxy
  basket) — the suffix rule throws on the first read of an unknown one. The documented primary
  tickers are bare or `.SN`, and `DX-Y.NYB` is covered.
