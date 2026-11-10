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

## 5. R2 and O2 — the 1040's worldwide side, and the options' tax and story

Planned 2026-11-10 after L2 went to main. Facts checked on `main` ff45fa61: the 1040 draft has
W-2 wages (1a), bank interest (2b), the standard deduction, Form 8959 and Schedule 3 line 31,
nothing else; a `first_year_full_resident` note drafts 2024 as a full resident year; the April
loop computes the 1040 before the F22 (`generate.ts` ~799: `usAprilSettlementsFromTaxModule`
then `aprilSettlementsFromTaxModule`); the tax-lot engine is long-only (`taxLots.ts`) with
equity and crypto event sources; O1 left `optionAssignmentForStockMovement` /
`…ForOptionMovement` ready for a lot reader.

### R2 — the 1040 of a resident (research first; the readings to verify, sources quoted)

- **2024 is a dual-status return** (Pub. 519): residency under the substantial presence test
  starts on the first day present, the declared 2024-04-15; the nonresident part (Jan 1 → Apr 14)
  has no US-source income; the resident part is worldwide. A single filer cannot elect full-year
  residence (§6013(g)/(h) need a US spouse), and a dual-status return takes **no standard
  deduction** (itemized only; Texas has no income tax, foreign real-property taxes are not
  deductible since the TCJA, so itemized ≈ 0). The `first_year_full_resident` note goes; the
  residency comes from R1's `residencyForIncomeYear(year).us` (`full | none | {from}`), and
  `availableUsTaxYears` keys off it. Expected: 2024's tax rises by the lost deduction.
- **Schedule D / Form 8949 — every sale as a resident**: the US-domiciled stocks at both brokers
  (the IBKR SPY / SGOV sales AND the Racional-held US stocks — a US resident's sales anywhere),
  crypto at Buda (basis and proceeds in dollars at each day's rate), the fund only if sold (see
  8621); short- vs long-term by holding period, FIFO, `equityTaxLotEventsFromRows` /
  `cryptoTaxLotEventsFromRows` reused, wash sales not modelled (stated). Line 7.
- **Schedule B**: Part I the bank and broker interest (US and Chilean); Part II the dividends
  — ordinary 3b and qualified 3a (SPY, VEA… qualified; the IPSA ETF's distributions ordinary);
  Part III «yes» to foreign accounts, with FBAR (FinCEN 114, aggregate > US$10k) and Form 8938
  (US$50k / 75k single) as flags in the notes, never filed by the app.
- **Line 16 through the Qualified Dividends and Capital Gain Tax Worksheet** (0 / 15 / 20 %
  brackets on 3a + net long-term gain), else the dividends and gains would be taxed as wages.
- **Schedule E, one per place** (Pub. 527; Chilean rents in dollars at each day's rate — Pub. 54
  allows the spot rate; the IRS yearly average is the alternative, stated): gross rent (the
  `rent` income overrides), the agency's 7 %, mortgage interest (`loan_payments`),
  contribuciones and gastos comunes (the bill rows), insurance (the loan's seguros),
  **depreciation** of the building share over 30 years ADS straight-line (foreign residential;
  the land share a declared 20 % of the purchase price, stated), both places taxed (no DFL-2 in
  US law). Net to Schedule 1 line 5 → line 8. The passive-loss rules (§469; the US$25k
  allowance phases out at US$100k–150k MAGI — he is above) are applied: a net rental loss is
  suspended, carried, never deducted against wages.
- **Form 1116, passive category**: the Chilean tax of the same income year — the F22's code 34
  (Adicional on the rent) and the 10 % único withheld on the IPSA ETF's distributions — under
  the **accrued** method (elected once, binding; Pub. 514), so year N's Chilean tax credits year
  N's 1040 (the paid method would credit it a year late). Limit = US tax × passive foreign
  income ÷ taxable income. Schedule 3 line 1 → line 20.
- **Form 8621 mark-to-market** (§1296) for the two PFICs, the money-market fund and the IPSA ETF:
  election in the first resident year each is held (2024 for the fund, 2025 for the ETF);
  inclusion = FMV at Dec 31 (pesos → dollars at the day's rate) − adjusted basis (cost in dollars
  at purchase rates), ordinary income on Schedule 1 line 8z; a loss deductible only up to the
  unreversed prior inclusions; basis adjusted each year; a sale = ordinary to the extent of
  unreversed inclusions, the rest capital. The app computes the inclusion and shows the form's
  Part IV figures; the filing itself is the user's.
- **Form 8960 NIIT**: 3,8 % on net investment income above US$200k MAGI (single, not indexed) —
  the 2026 salary plus bonus crosses it; line 23 beside Form 8959.
- **Order and cycle**: the F22 of a non-resident year reads nothing from the 1040, and the 1040
  reads the F22's 34 → the April loop computes the **F22 first, then the 1040** (the reverse of
  today), `writeDemoFiledReturns` before `writeDemoFiledUsReturns`. The split year 2024 is still
  one direction (the F22's resident part has no US income to credit).
- **Demo**: both generations re-converged; expected moves — 2024 tax up (no standard deduction,
  rents Apr–Dec), 2025 up (rents, dividends, gains, the 8621 inclusions) less the 1116 credit;
  `netWorthTargetUsd` restated once from the data if it leaves the band. The tour's tax step
  names the dual-status year and the two returns' direction.
- **Checks**: a filed 2024 and 2025 return reproduce (`assertF1040Identities` extended to the
  schedules' totals: 7 = Schedule D 16/21, 8 = Schedule 1 10, 3a ≤ 3b, 20 ≤ 16); the worksheet
  against the IRS example; Schedule E ties to the rent overrides and the bill rows; 1116 ≤ the
  Chilean tax; 8621's basis roll-forward across years; the dual-status return has no 12e.

### O2 — the options' tax lots and their story

- **`optionTaxLotEvents.ts`** (pure, beside `equityTaxLotEvents.ts`): short lots — a sold
  contract opens a short lot at the premium; it closes on expiry (the premium a short-term gain
  on the expiry day), on a buy-back (premium − cost) or on assignment (the premium joins the
  stock sale's proceeds: `optionAssignmentForStockMovement` adjusts the `stock_sell` event's
  proceeds; an exercised long put adds its premium to the shares' basis); long lots as equities.
  Every option gain is short-term (§1234; no §1256 for equity options). Fed into R2's Schedule D
  as 8949 rows; `foreignEquityAccounts` already excludes contract accounts.
- **A Chilean-resident year with option events throws** in `buildF22Draft` («derivatives under
  Ley 20.544 are not modelled»), by R1's windows — the only Chilean code of this feature.
- **Story (the agent picks from the data and states it)**: the IBKR SPY stack never reaches a
  round lot (US$1k a month after the SGOV reserve), so a covered call on SPY is out; the honest
  shape is a **cash-secured put wheel on a cheap name he already follows** (INTC ≈ US$20 →
  100 shares ≈ US$2k, inside the IBKR idle cash): from 2025-01 a put sold every quarter ~5 % OTM
  45 days out, one assigned when the close crosses the strike (100 INTC shares land at IBKR —
  a second holder of INTC beside the Racional position, which wave A's broker-aware lookup
  allows), then covered calls on those shares, one assigned back. Strikes from
  `market.close(underlying, day)`, the expiry on a Friday, every event on an NYSE day. Events sit
  beside the dividend loop in `simulate.ts`; `invariants.ts` checks contracts net to zero at
  every expiry and the premium legs reconcile with the cash account.
- **Checks**: the lots on a fixture (expired short put = premium gain; assigned put = shares at
  strike − premium basis; assigned call = proceeds + premium), the demo's 2025 Schedule D
  carrying them, both generations.

### Review of this section (2026-11-10): corrections before anything is built

Checked against the code on `main` ff45fa61 and the demo story. Each item changes what R2 / O2
build; where it contradicts a bullet above, this list wins.

**Gaps in the tax readings**

1. **The Chilean broker withholds 15 % US tax on dividends (W-8BEN) — and keeps doing so after
   the move** (`taxDocuments.ts` writes it for every dividend at the broker that is not IBKR).
   For a US resident that is US tax withheld, not a foreign tax: it is a payment on line 25b
   (Form 1042-S), never Form 1116. R2 either credits it there, or the story files a W-9 with the
   Chilean broker at the move (withholding stops). Decide; proposed: credit on 25b — it is what
   happens to a person who forgets the form, and it exercises a real line.
2. **The APV and AFP are missing from the PFIC story.** The plan names two PFICs, but APV A / B
   are mutual funds too (≈ 45 M CLP on the demo) and the AFP a foreign pension. Research item:
   the convention's pension article (deferral of a pension fund's earnings until distribution)
   and whether it reaches a voluntary APV; then either both are stated as treaty-deferred (a
   note on the return, Form 8833 flagged) or the APV funds join the 8621 list. Not deciding this
   silently is the point.
3. **Mark-to-market basis for a PFIC held before residency is its value on the first day as a US
   person, not historic cost** (Reg. §1.1296-1(d)(5), verify). The money-market fund was held
   since 2020: its first inclusion is the 2024-04-15 → 12-31 change only. Also verify the fund is
   «marketable» at all (§1296(e): exchange-traded, or an open-end fund redeemable at NAV under
   Reg. §1.1296-2(d)); if it is not, the default §1291 regime applies and the app flags it
   rather than computing it.
4. **No basis step-up for ordinary assets:** stocks and crypto bought as a Chilean resident keep
   their historic dollar cost, so a post-move sale taxes the whole gain. And the dual-status
   year excludes what was sold before 2024-04-15 (the 2024-02 plays, the UCITS sale of 03-12):
   an NRA's foreign-source gains. State both in Schedule D's header.
5. **Schedule E depreciation does not restart at the move.** Centro has been a rental since
   2020: depreciation is «allowed or allowable» from the placed-in-service date, so 2024 is its
   fifth year, on the historic dollar cost. Vitacura was his home until 2024-06: basis is the
   lesser of cost and value at conversion. Both in dollars at the purchase / conversion day's
   rate. The exchange gain on repaying a UF mortgage (§988) is not modelled — stated.
6. **Form 1116 will credit little, and the plan should expect that.** Chile taxes the GROSS rent
   at 35 %; the US taxes the net after interest, contribuciones and depreciation, which is small
   or a suspended loss. The limit then caps the credit near zero and the excess carries (one
   year back, ten forward). R2 keeps a carryover table per category or states that it does not;
   the 10 % único withheld on the 2026-03 IPSA sale and the 8621 inclusions belong to the same
   passive basket.
7. **The April order is per year, not reversed globally.** A Chilean-resident year with a US
   salary still needs the 1040 first (the F22 credits it — `foreignSalaryForYear` stays for any
   user in that position); a non-resident or split year needs the F22 first. One rule,
   `taxReturnOrder(incomeYear)` from the regime, read by the generator and by any reader that
   chains the two drafts.
8. **Smaller:** NIIT applies only if MAGI passes US$200k — computed, not asserted (the plan's
   «crosses it» is a guess); the underpayment penalty (Form 2210) on the unwithheld rents and
   inclusions is not modelled — stated; a person with US stubs and no declared US residency is a
   1040-NR filer — the 1040 tab says so instead of drafting; the peso → dollar rate is `fx_daily`
   everywhere on the 1040 (one rule, stated), the observado stays the F22's.

**O2**

9. «Every option gain is short-term» is wrong as written: a SHORT option's gain or loss is
   always short-term (§1234(b)); a long option follows its holding period. Covered calls can
   also suspend the stock's holding period — not modelled, stated.
10. In a non-resident year the F22 does not throw on option events: a US-listed option's result
    is foreign-source, so it is one more `excluded` item with reason `nonresident`. The throw is
    for a resident window only.
11. The wheel's size comes from the data: INTC is not a US$20 stock for all of 2025–2026 on the
    real market, and IBKR's idle cash is US$2.000. Collateral is the SGOV reserve (US$15k),
    the underlying and strike are chosen from the stored closes, and an assignment is whatever
    the closes produce — the invariants must hold with zero, one or several.
12. Short lots belong in the lot engine, not beside it: `taxLots.ts` gains signed lots
    (`open_short` / `close_short`), and options are an event source like equities and crypto.
    A second realization path would drift from the first.

**Structure (the user asked for the cleaner shape, 2026-11-10)**

13. **One set of tax-year facts, two returns that map them.** Today each F22 loader reads the
    ledger and returns Chilean-shaped pesos; R2 as written would add a parallel set of readers
    for the 1040 (dividends, interest, disposals, rents, funds). Instead: a jurisdiction-neutral
    `taxFacts/` layer — `dividends(window)`, `interest(window)`, `disposals(window)` (lots in
    the instrument's own currency, with dates), `rentals(window)` (gross, each expense, the
    loan's interest), `fundHoldings(window)` — returning native-currency facts with their source
    (country, payer, account role). `f22Draft.ts` and the 1040 become mappers: which facts enter,
    at which rate, into which code or line. R1's `DateWindow` parameters are already the seam.
14. **The 1040 is a folder, one pure module per form:** `us1040/scheduleB.ts`, `scheduleD.ts`
    (+ `form8949.ts`), `scheduleE.ts`, `qualifiedDividendsWorksheet.ts`, `form1116.ts`,
    `form8621.ts`, `form8960.ts`, `dualStatus.ts`, each `(facts, law) → lines` with its own
    test against an IRS example, and `f1040Identities.ts` composing them. `f1040Draft.ts` at
    eight forms in one file would be the next `f22Draft.ts`.
15. **`f22Draft.ts` gets the same treatment while it is open:** the regime chains (resident,
    non-resident, split) and each income block (salary, fees, rentals, art. 107, crypto, foreign
    income, dollar lots) as modules under `f22/`, the draft a composition. Byte-parity on every
    filed year is the test, as for the earlier untangle streams.

### Waves (continued)

- **Wave T0 (one Opus agent, no behaviour change)** — review items 13 and 15: the `taxFacts/`
  layer and `f22/` split, byte-parity on every filed and drafted year of both generated
  databases; item 12's signed lots in `taxLots.ts` with the existing equity, crypto and dollar
  walks unchanged.
- **Wave R2 (one Opus agent, research first; after T0)** — R2 above as corrected by the review
  (items 1–8, 14): the `us1040/` modules, `usLegalParameters.ts`, `taxDocuments.ts`'s US side,
  `taxReturnOrder`.
- **Wave O2 (one Sonnet agent, in parallel with R2, after T0)** — the option event source on the
  signed lot engine, the F22's resident throw and non-resident exclusion, the demo's wheel and
  the invariants (items 9–11); it does not touch `us1040/`.
- **Wave O2b (small, after both)** — the option disposals into Schedule D / 8949, the
  generations re-converged, the tour's tax step.
- Each wave: `cd server && npm run test`, both generations, the local demo pair; merge to `main`
  on the user's word; the market asset republished and one demo release after O2b.

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

## Status (2026-11-10): L2 built (Opus core + Sonnet tools), merged into the integration branch

- **Core (448d92c6 → b4915bfc):** migration 305 adds `mic`, `isin`, `display_symbol`, `source` to
  `market_symbols` (plain `ADD COLUMN`s; the hook fills display symbol and MIC on existing rows
  and re-creates the write-log UPDATE trigger; it also declares SPY, the benchmark migration 207
  seeds). `registerInstrument` (refuses to reframe a ticker with stored bars) and
  `requireMarketSymbol` (throws, naming the script) in `marketSymbols.ts`; `priceProviders/`
  with the Yahoo adapter (`describeYahooSymbol`, `yahooExchangeMic`, `yahooDisplaySymbol` — the
  only suffix parsing left; `checkYahooSeriesCurrency` replaced the EOD sync's assertion), the
  CoinGecko adapter (the two coins) and the Bolsa de Santiago adapter (closes only); `yahooSymbols.
  ts` deleted. `equityMarketKind` / `marketQuoteCurrency` read the row or throw; eleven suffix
  tests deleted (`equityQuote.ts`, `equityBolsaSantiagoEod.ts`, `brokerAdapter.ts`, `generate.
  ts`, `demoRealMarket.ts`, `foreignShareTaxGains.ts`, `brokerageEquityMtm.ts`, two fixtures, the
  client's `stockQuoteCurrencyForTicker`). `CLP=X` is not an instrument (`YAHOO_USD_CLP_SYMBOL`
  keeps the forex calendar). Doors: the panel account route registers before creating (a provider
  refusal is a 400), the broker mail importers mark a buy of an unregistered ticker
  `requires_manual`, the watchlist and the proxy composition sync register through the adapter.
  The demo declares its instruments (`DEMO_TICKERS` with market kind, currency, display symbol,
  MIC, name, type; `declareDemoInstruments` before any account; the real-market loader throws on
  a mismatch with the provider); the market asset carries no registry rows.
- **Tools (80222a6a, 0e1d880e):** `npm run register:market-symbols -w nw-tracker-server --
  [--only=…] [--apply]` (`instrumentRegistrationPlan.ts`, pure, tested with a fake provider):
  CoinGecko for its known coins, Yahoo otherwise; `declared` and `bolsa_santiago` rows are never
  re-verified; registered rows whose provider facts changed are `update`s; all or nothing in one
  transaction, exit 1 naming every unclassifiable ticker; a second run says «nothing to
  register». Rehearsed on the demo DB (nothing) and on a copy with SPY and BTC-USD deleted
  (listed, restored identically but for `source`). `scripts/server-deploy.sh` runs it with
  `--apply` after the build and before the restart (a failure takes the rollback path).
  `check:conventions` rule 7 flags ticker-suffix parsing outside `priceProviders/`; it found
  nothing left to fix.
- **Checks:** server 505 files / 3357 tests, client 85 / 475, typecheck + check-deps (no new
  cycle), both generations; the merged tree typechecks (942b046f).
- **On the first deploy to the primary** the script calls Yahoo and CoinGecko for every ticker
  in use without a row (the old account tickers: VEA, OILK, the Santiago ones, …); a provider
  outage fails that deploy and rolls back — the old code runs fine on the migrated DB (305 is
  additive). This is the check the ssh query would have been.
