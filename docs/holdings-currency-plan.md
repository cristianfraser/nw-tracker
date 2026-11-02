# Holdings: value accounts in what they hold (2026-11-02)

## Why

Every account value is built in pesos first and converted out of them. A dollar cash account's
value is its ledger dollars × the stored sell rate (`usdCashBalanceClpAt`); a stock's is units ×
USD close × fx (`computeEquityMtmClp`); a fund's is cuotas × CLP price. Readers that want another
unit then convert the pesos back: `accountValueClpToUnitAt` / `clpToUnitAt` (60 references),
with exceptions per account type — dollar cash in USD re-reads its ledger dollars
(`clpToUnitAt.ts:113`, `dailySeries.ts:471`, `groupMonthlyPerfConsolidation.ts:223`), and a value
dated today is divided by the fx of the day its pesos were priced (`priced_on`) so a stock
priced at Friday's close gets its own dollars back.

Two things go wrong because of it:

- **Round trips.** Dollars → pesos → dollars at two different rates reads the spread or the
  wrong day's fx as P/L. `priced_on` exists only to undo one of them.
- **Stale rates where the pesos are not the point.** The dollar cash account is valued at the
  stored sell rate on or before today, never the live rate, so its day P/L in pesos is 0 all day
  while the peso moves (Fintual USD on 2026-11-02). A peso fund shown in USD is divided by its
  cuota day's stored fx, so it reads 0 in USD until the next cuota (Reserva, same day).

Currencies are also hardcoded across the rate tables (`fx_daily.clp_per_usd`,
`eur_daily.clp_per_eur`, `uf_daily.clp_per_uf`, `fx_daily_bid_ask.buy/sell_clp_per_usd`,
`fund_unit_daily.unit_value_clp`, the CLP-denominated spread constant `FX_BID_ASK_SPREAD_CLP`)
and in the readers (`isUsdCashAccount` 45 references in 19 files, `isClpCashKindSlug`, the
depto ledger's `*_uf` / `*_clp` column pairs).

The model this plan builds: **an account holds one thing, its value is a quantity of that thing,
and one converter turns a quantity into any display unit** along a graph of price pairs, at the
side of the spread that closes the position.

## Decisions (agreed 2026-11-02 — overturn here, not in code)

1. **What an account holds is its currency.** A currency (CLP, USD, UF, EUR) or an instrument
   (a stock: SPY; a coin: BTC, ETH — the account holds BTC, «BTC-USD» is only the name of a price
   series; a fund's cuotas: `afp_uno_cuota_a`). Its value at a date is a quantity of that holding.
2. **A credit card has no currency.** It holds sub-balances, one per facturación and currency;
   its value is their sum, each converted.
3. **One converter.** Nothing else reads a rate or a price to value an account. A past date reads
   the stored row on or before it; today reads the live one (quote, CLP=X).
4. **Spread side: what closes the position.** An asset converts at the side you would get
   selling it: foreign → CLP at the **sell** rate, CLP → foreign at the **buy** rate. A debt flips
   it: a dollar debt shown in pesos at the **buy** rate (you buy dollars to repay it), a peso debt
   shown in dollars at the **sell** rate. UF has no spread. No currency is named in the rule.
5. **Loans: store what the bank states, in the currency it states it.** A payment enters in pesos
   (what the bank charges that day): amortization, extra amortization, interest, fire and life
   insurance are stored in the payment's currency. The balance after the payment, the minimum and
   the maximum are stated in the loan's currency (UF) and stored in it. A part's UF figure is a
   conversion (pesos ÷ the UF of the payment day), derived when read, never stored. The
   property's appraisal is a valuation of the property account in UF.
6. **Cache.** The per-account daily series stores quantities of the holding, not pesos.
7. **Round trips go.** After this lands, a general audit of the remaining currency round trips
   (flows, tax lots, card frames, client) — see «After» below.

## The model

### Assets and pairs

- **What an account holds is derived, in one function** (`holdings.ts`, `accountHolding(id)`;
  the pure rule is `holdingFromFacts`): `credit_card` → card; an account valued from coin units
  → the coin (BTC, ETH; price series `BTC-USD`); from share units → the stock (quote currency
  from `equityQuoteCurrency`); `afp` → its fund series (UNO Fondo A when undeclared); `afc` with
  a series → it; a Fintual fund → its series (none declared throws); `usd` → USD; `clp` → CLP;
  property and mortgage → UF; every other kind → CLP. Built 2026-11-02 instead of the
  `accounts.holding` column first planned: the rules already live in the kind and identity
  columns, and a NOT NULL column would need every account creator (and the hundreds of test
  fixtures inserting accounts) to set it. A column can replace the function later without
  touching its callers.
- **Pairs.** A pair is (base, quote) with a source: `USD/CLP` (`fx_daily` mid, `fx_daily_bid_ask`
  buy/sell, live CLP=X), `UF/CLP` (`uf_daily`), `EUR/CLP` (`eur_daily`), and one per instrument
  (its price series in its quote asset, live quote today). `rates.ts` registers them in one place
  and reads the existing tables; the tables are not merged in this plan.
- **Spread per pair.** `FX_BID_ASK_SPREAD_CLP` (4 CLP) becomes the USD/CLP pair's inferred
  half-spread; a pair without bid/ask data reads its mid on both sides (UF, EUR, instruments).

### Price data in the quote's currency

- `equity_daily` already stores `close` + `currency`. `BTC-USD` / `ETH-USD` rows keep their
  ticker as `price_key`.
- `fund_unit_daily.unit_value_clp` → `unit_value` + `currency` (migration; every row `clp`
  today; 31 files read it — the rename goes through one reader).

### The converter

`convertQty(qty, from, to, ymd, { side, now })` walks the pair graph (an instrument to its quote
asset, then currency pairs, through CLP when there is no direct pair: BTC → USD → CLP;
USD → UF = USD → CLP → UF). `side` is `asset` or `debt` (decision 4). Past day: stored row on or
before; today (Chile): the live quote / live CLP=X while its session or fx day is open, the stored
close after. Missing rate or price: null, never a substitute (callers keep today's null rules).
Rates and prices for past days are memoized per (pair, day, side) in the history tier.

### Native values

`accountHoldingQtyAt(accountId, ymd)` → `{ qty, holding, as_of }`, one branch per way an account
records what it holds:

| How it records | Quantity | Today's source |
|---|---|---|
| Cash ledger (CLP, USD, any currency) | Σ movement legs in that currency | `sumClpThroughDisplayDate` / `sumUsdThroughDisplayDate` generalized to a currency |
| Units (stocks, coins, cuota ledgers, Fintual funds) | Σ `units_delta` + transfer legs | `transferLegUnitsThroughDate` |
| Stored marks (DAP, manual marks) | `valuations.value` in `valuations.currency` + flow carry | `storedMarkValueWithFlowCarry` |
| Property | today: net equity in UF (appraisal − loan balance); see «Open question» | depto ledger → valuations |
| Loan (mortgage) | balance after the latest payment, in the loan's currency | loan ledger |
| Card | one quantity per open sub-balance (facturación × currency) | see «Cards» |

`accountValueAt(accountId, ymd, unit, { now })` = `convertQty` of that quantity, side from the
account (`liability` kinds → `debt`). `accountMarkClpAtYmd` and `accountTodayValue` become thin
wrappers over it while their 54 + 23 callers move; `priced_on` stops being read by any
conversion (it stays on `accountTodayValue` as information until the readers are gone).

## Phases

Each phase lands on its own, with the app working and the parity check below green.

### Phase 1 — rates and assets (no number moves)

- `rates.ts`: the pair registry, `rateAt(base, quote, ymd, side, {now})`, `convertQty`.
  Implemented over the existing tables; `fxRowOnOrBefore`, `fxForLiveMtm`,
  `usdCashClpRateOnOrBefore`, `convertTs`, `pastDayUnitConverter`, `clpToUsdAtPayment` call into
  it with the side they use today (mid where they read mid), so nothing moves yet.
- `holdings.ts` (`accountHolding`). Migration 257: `fund_unit_daily.unit_value_clp` →
  `unit_value` + `currency`.
- Unit tests: pair walking (direct, inverse, through CLP), side per asset/debt, past vs live,
  missing data → null.

### Phase 2 — native quantities and the converter behind today's readers

- `accountHoldingQtyAt` for every branch except cards and the loan (those keep their current CLP
  computation, wrapped as a CLP holding until phases 4 and 5).
- `accountMarkClpAtYmd`, `accountTodayValue`, `accountValueClpToUnitAt`, `clpToUnitAt` (for
  values), `computeEquityMtmClp*`, `computeCryptoMtmClp*`, `usdCashBalanceClpAt` /
  `usdCashBalanceLive` route through `accountValueAt`. The dollar-cash special cases go:
  `clpToUnitAt.ts:113`, `dailySeries.ts:471`, `groupMonthlyPerfConsolidation.ts:223`,
  `valuationTimeseries.ts:412`, `accountMarkClpAtYmd.ts:78`, `accountChartInactive.ts:76`.
- Spread side switched on (decision 4) and the live rate for today (decision 3). This is the
  phase where numbers move — see «Expected changes».
- `dashboardAccounts.ts` builds `current_value_*` / `prior_*_close_*` by calling
  `accountValueAt` once per unit, never by dividing one by a rate.

### Phase 3 — cache in quantities

- `markSeriesStore.ts` / `accountMarkDailyCache.ts` store `qty` per day per account (a card: per
  sub-balance) instead of pesos; values in a unit are built at read from the memoized day rates
  and prices (history tier, `buildHistoryTierValue`).
- `markInputChanges.ts` `SOURCE_RULES`: a change to `fx_daily`, `uf_daily`, `eur_daily`,
  `fx_daily_bid_ask`, `equity_daily`, `fund_unit_daily` no longer trims any quantity series — it
  drops the rate/price memo for its days. Movement, valuation and ledger changes still trim from
  their date. The card `cardBackDays: 75` fx rule goes with phase 5.
- One cache for every display unit: the `<unit>` part of the daily aggregation keys stays (the
  aggregations are per unit), the per-account series does not need it.

### Phase 4 — loans and the property

- New `loan_payments` (keyed by the payment movement): `loan_account_id`, `kind` (regular | pie
  | prepago), `cuota`, `loan_currency`, in the loan's currency `balance_after`, `min_payment`,
  `max_payment`; in `payment_currency` (the bank's charge) `principal`, `extra_principal`,
  `interest`, `insurance_fire`, `insurance_life`. The movement's own `amount` + `currency` is the
  total paid.
- Migration from `depto_payments`: parts from the `*_clp` columns, balance / min / max from the
  `*_uf` columns; the `*_uf` part columns and the stored derived figures (`valor_neto_*`,
  `pagado_neto_uf`, `pago_acumulado_clp`, `amount_uf`) are dropped and computed when read.
  `valor_vivienda_uf` becomes `valuations` rows of the property account in UF on each payment
  date. Insurance has no UF column today, and none is needed (decision 5).
- The 17 readers move: `deptoDividendosLedger.ts`, `deptoLedgerFromMovements.ts`,
  `mortgagePayment*.ts`, `mortgageSheetPaymentsApply.ts`, `mortgageUfReminder.ts`,
  `mortgageScenarioPayments.ts`, `mortgagePrepaymentComparison.ts`, `flowsRealEstateExpenses.ts`,
  `f22AppEstimates.ts`, `markInputChangeTriggers211.ts`, `demoData/generate.ts`, and the
  hooks in `db.ts` / `legacyNoteBackfills.ts` (which keep speaking the old schema: they run
  before the migration on a fresh DB).
- The mortgage-sheet import compares the balance, minimum and maximum in UF and the parts in
  pesos, and keeps the hard check that the derived UF amortization reproduces the balance drop
  (0,0002 UF).
- The mortgage holds UF (its balance), the property holds UF (appraisal); net equity and the
  ledger's UF day figures are derived.

### Phase 5 — cards as sub-balances

- A card's quantity at a date is a set of (facturación, currency, owed) — the billed and unpaid
  facturaciones plus the open cycle, each in its own currency — summed after conversion with the
  debt side. Built from the same evidence the owed walk uses today (anchors, lines, payments,
  header legs, plans), but per currency instead of pre-converted at the facturación's pay-by − 1.
- This replaces the «debt frame» of AGENTS.md «Card dollars in pesos» for VALUES (owed walk,
  month-end anchors, detalle, Pasivos, cash netting): an unpaid dollar sub-balance follows the
  date's rate until paid. What a facturación SHOWS it cost (the paid rate on its row, the bars,
  its expense lines) is a historical fact and stays as it is.
- The stored month-end anchors (`valuations` rows, CLP) become per-currency rows
  (`valuations.currency`), re-stamped once.
- Its own sub-plan before code: the identities the billing detail prints (facturado + cupo =
  balance) must hold per currency, and `verify-cc-billed-cuotas.ts` /
  `verify-cc-financing-identity.ts` / the bank cupo check must stay green.

### Phase 6 — cleanup

- Delete what nothing calls: `usdCashUsdToClpAt`, `usdCashClpRateOnOrBefore`, `usdCashBalanceClpAt`,
  `accountValueClpToUnitAt`, `usdFromClpAtLiveFrame`, `priced_on`, the CLP-only names in
  `rates`. `isUsdCashAccount` / `isClpCashKindSlug` callers that only meant «holds dollars /
  pesos» read the holding.
- AGENTS.md: replace «Today's value and its USD», the dollar-cash bullets and «Card dollars in
  pesos» with the holdings model; add the spread-side rule.

## Verification

Every phase: on a copy of the real DB, build every payload (home bundle, nav context, every
group and account page bundle, daily series full history, consolidations, flows overview, card
ledgers, mortgage) in CLP and USD with the old and the new code at a frozen clock, and diff.

- Phase 1: byte-identical.
- Phase 2 onward: identical except the changes listed below, each checked to be exactly the
  expected one (the size of the spread, the live-vs-stored fx on today's point).
- Phase 4: the mortgage and property values identical to the peso (the conversion is the same
  multiplication, moved); the sheet import's dry run clean.
- Phase 5: card values identical on every day a facturación has no unpaid dollar sub-balance; on
  the other days the difference is the dollars × (date rate − pay-by − 1 rate).
- Tests through `cd server && npm run test` only.

## Expected changes (phase 2 and 5)

- **CLP holdings shown in USD:** mid → buy rate (USD net worth lower by half the spread on peso
  holdings, ~0,2 %).
- **Dollar stocks and coins shown in CLP:** mid → sell rate.
- **Dollar cash in CLP today:** the live sell rate instead of the stored one (its day P/L moves
  with the peso, as stocks do).
- **Peso funds in USD today:** the live buy rate instead of their cuota day's stored fx.
- **Debts:** the mortgage (UF) has no spread; a peso card balance in USD at the sell rate; card
  dollars in pesos at the buy rate and the date's rate (phase 5).
- **Flows are not changed by this plan** (`flowEventInUnit` already converts each event's own
  legs; CLP → USD at the buy rate, which matches decision 4).

## Open question

- **Property: gross or net.** The property account today is valued at net equity
  (`deptoNetEquityUfBySnapshotDates`: appraisal − crédito restante), and the mortgage account
  carries the same balance as a debt. Under «value = what the account holds» the property would
  hold its appraisal (gross UF) and the mortgage the debt, net worth subtracting it once.
  Settle before phase 4: either keep net equity as the property's quantity (a derived UF figure,
  numbers unchanged), or switch to gross and check how net worth and the Pasivos totals count
  the mortgage today so it is subtracted exactly once.

## Out of scope

- Merging the rate tables into one; a USD- or EUR-denominated loan (the table supports it, no
  import writes one).
- The client: it receives values in the requested unit, as today.
- Flows, tax lots (`usdCashCostLots`, `usdCashTaxLotEvents`), dollar deposit pricing
  (`equityBrokerageCapitalFlows`), cash interest — they price at cost or at the event, not as a
  value.

## After

- **Round-trip audit:** list every remaining path that converts into pesos and back (flows,
  tax lots, card frames, client) and decide each.
- **Live USD/CLP:** with phase 2 the dollar cash account follows the live rate; re-check the
  Efectivo card's day P/L on a weekday afternoon.
