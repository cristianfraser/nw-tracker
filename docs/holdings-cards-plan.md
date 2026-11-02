# Cards as per-currency sub-balances (phase 5 of `holdings-currency-plan.md`, 2026-11-02)

## Today (before this change)

- **Anchors.** `upsertCreditCardValuationsFromLedger` (`ccCreditCardValuations.ts`) writes one
  `valuations` row per month-end (CLP) from the billing detail's statement frame
  (`buildBillingDetailByMonth` → `balance_statement_clp` = facturado + cupo en cuotas + the
  activity through the month-end a later facturación bills, `unbilledAtMonthEndAdjustmentsClp`),
  plus a «today» stamp = the walk. Stamps a later import contradicts are purged
  (`purgeContradictedDailyStamps`).
- **Walk.** owed(d) = anchor (CLP) + Σ `normalizedPostCloseLines(...).clp` in (anchor, d]
  (`postCloseLiveBalanceAdjustmentClp`, plus plan purchases at full total). Three copies of the
  composition: `ccOwedWalkClpAtYmd` (today), `accountMarkClpAtYmd` (history; phase-2 module) and
  `liabilityTree.linkedCreditCardBalanceTotalClpAsOf` (cash netting).
- **Where dollars become pesos (the debt frame).** Every USD amount in a value is converted at
  the `fx_daily` mid of its facturación's pay-by − 1 (`balanceUsdFxDateIso`, `payByFxDateIso`):
  statement facturado (`facturadoFromStatement`, `usdToClpAsDebt`), provisional SALDO INICIAL
  (`signedUsdToClpAsDebt`), open-cycle lines and payments (`effectiveCcExpenseLineAmountClp` at the
  statement's frame date), a dollar payment at the frame of the facturación it paid
  (`paidFacturacionStatementDate`), a dollar header leg likewise, and a linked traspaso's USD leg at
  minus its CLP twin's pesos (`ccTraspasoLinkedClpByUsdLineId`) so the pair nets to zero.
- **Per currency already:** `ccOwedByCurrency` (the bank's cupo frame) and the bank cupo check
  (`ccBankCupoCheck.ts`) compare each currency with the bank's own figure; they do not read the
  walk.

## New model

- A card holds two sub-balances, CLP and USD (one per facturación and currency, but the value only
  needs the per-currency sum: every sub-balance of one currency converts at the same date rate).
  Value at d = Σ `convertCurrency(owed_c, c, "clp", d, {side})`, side `debt` (a dollar debt in
  pesos at the BUY rate; a peso debt in dollars at the SELL rate), side `asset` for a currency the
  card is in credit in (a negative sub-balance is money the bank owes).
- **Evidence stays native.** Each `normalizedPostCloseLines` entry carries `currency` and `amount`
  (dollars to the cent for a dollar line, payment, header leg or traspaso leg; pesos otherwise).
  The old `clp` field stays for what a facturación SHOWS it cost (the financing-cost P/L,
  `ccFinancingCostClpByDate`).
- **Anchors native, in a card table.** `valuations` is UNIQUE(account, date) with a CHECK on
  currency and every generic reader (phase 2) asserts CLP, so per-currency rows cannot live there.
  New `cc_owed_anchors(account_id, as_of_date, currency, amount)` (migration 259) holds the walk's
  anchors; `valuations` keeps one CLP row per anchor date = the converted value at that date — the
  cache the group charts (`valuationTimeseries`), the liabilities overview and the mark-input
  triggers read, so those surfaces follow without edits.
- **Splitting the statement frame per currency without a second detail builder.** The detail's
  balance is affine in the debt-frame dollar rate. The anchor writer builds it three more times
  with every debt-frame rate replaced by one uniform rate (900, 1000, 1100 CLP/USD;
  `withUniformDebtUsdRate` in `ccExpenseAmountClp.ts`, consulted by every debt-frame conversion):
  usd = (b(1100) − b(900)) / 200, clp = b(1000) − 1000 · usd, and b(1100) − b(1000) must equal
  b(1000) − b(900) or the writer throws (a clamp or branch that mixes currencies would break it).
  The cached stream is bypassed in those passes by reading each entry's native amount.
- **Walk native.** owed_c(d) = anchor_c + Σ amount of currency c in (anchor, d]; anchor = the latest
  native anchor on or before d (strictly before for today, as now). A card with no native anchor
  (no plan ledger: CMR) keeps its CLP `valuations` rows as CLP anchors.
- **Entry points kept:** `ccOwedWalkClpAtYmd`, `latestCreditCardValuationRowAsOf` (now the walk
  converted at d, `as_of_date` = d, so `accountMarkClpAtYmd` adds nothing on top),
  `latestCreditCardDisplayedBalance` (today: the walk; past: the stored row, now in the new frame),
  `postCloseLiveBalanceAdjustmentClp` (unchanged, old frame; only the legacy fallback uses it).
  New: `ccOwedByCurrencyAtYmd(accountId, ymd)` → `{clp, usd, as_of_date}` for phase 2's card
  branch of `accountHoldingQtyAt`, so a card shown in USD converts its peso sub-balance at the sell
  rate and keeps its dollars — the CLP entry points cannot express that (a CLP total converted to
  USD would read dollars × buy ÷ sell).

## Identities

- Statement frame (detalle, `balance_statement_clp`): unchanged, internal (the Cupo card's used
  figure, the stored snapshot). Per currency: USD balance = USD facturado + its unbilled lines (no
  dollar plans); CLP balance = CLP facturado + cupo + its lines. Both hold by construction of the
  split.
- The detalle columns the user sees and the historial lines are the owed walk sampled at month-ends
  (`ccHistorialLinesAtMonthEndsClp`), so they follow the new value.
- Bank cupo check: unchanged and per currency already; unaffected (it reads facturaciones and lines,
  not anchors).
- `verify-cc-billed-cuotas.ts` (CLP cuotas) and `verify-cc-financing-identity.ts` (financing in the
  debt frame, both sides) do not read values; unaffected.

## Traspaso de deuda

The USD abono (−US$x on the dollar statement) and the CLP cargo (+$y on the peso statement) are
dated the same day (checked on all 9 links in the real DB). Natively they move x dollars out of the
USD sub-balance and y pesos into the CLP one; no pairing is needed for value. On that day the value
moves by y − x·buy(d): the bank's conversion against the market buy rate. That step is debt that
really changed (the bank fixed the pesos), and by the P/L rule below it is flow, not P/L. The link
table stays (the facturación's paid rate reads it).

## P/L (user decision 2026-11-02: the fx move on dollar debt is P/L)

Book treatment: a foreign-currency liability revalued at the date's rate is an fx gain or loss,
loss-negative like the rest of the card's P/L. Per day:

- P/L = −(section-3 charges + plan interest) − usd(d−1) · (R(d) − R(d−1)), where usd(d−1) is the
  dollars owed at the end of the previous day and R the debt-side rate (buy; sell for a dollar
  credit; a day the side flips takes each day's own). `ccUsdRevaluationCostClpByDate` sweeps the
  dollar walk day by day (past days memoized with the card's satellites, today at the live rate);
  `ccFinancingCostClpByDate` adds it to the charges (`ccSection3FinancingClpByDate`, which the
  financing identity script checks alone).
- Flow stays derived as −Δowed + cost in the modules that build it (`dailySeries`,
  `accountPerformance`). With V(d) = clp(d) + usd(d) · R(d) that equals the evidence at each
  event's own day rate (Δclp + Δusd · R(d)) — what the decision asks — with no edit to those
  modules. The peso side keeps today's rule (anchor re-framing is flow).
- Σ days = month by construction: the month reads `ccFinancingCostClpBetween`, the sum of the same
  daily map, and Δowed over a month is the sum of the daily Δ.
- Unit: the cost is in pesos and the USD P/L converts it (`perfSheetClpFlowInUnit`). In USD the
  revaluation belongs to the PESO sub-balance instead (a dollar debt does not move in dollars); a
  unit-aware leg needs phase 2 (open question 2).

## Migration and re-stamp

- Migration 259 creates `cc_owed_anchors`.
- `server/scripts/restamp-cc-owed-anchors.ts [--apply]` (report-first): per card with a plan
  ledger, writes the month-end native anchors and decomposes each stored non-month-end stamp
  (stamp − the old-frame dollar part of the walk from its month-end = CLP; the native dollar walk =
  USD), then rewrites every `valuations` row of the card to the new value at its date. Runtime CC
  writes keep both tables in step (`upsertCreditCardValuationsFromLedger`).

## Parity expectation

On a day whose USD sub-balance is 0, the value is identical to the peso. Otherwise
new − old = Σ unpaid dollars × buy(d) − (their old frame pesos). Measured 2026-11-02 on a copy of
the 2026-10-30 snapshot, clock frozen at 2026-10-29 18:00, old (1027a277) vs new, 235 dates per
card (every month-end since 2017 + the last 120 days):

- Peso-only cards (the BCI and CMR masters): identical on every date.
- The current Santander master owes dollars on every sampled date: 141 dates differ, median 7.xxx,
  max 6x.xxx (2025-06-30); every difference implies an old frame rate in a plausible range. Today
  (US$3xx,xx owed): +7xx.
- The retired Santander master: 56 dates with dollars owed (median 1.xxx, max 6x.xxx); 28 dates
  with no dollars owed still differ, by up to 3.xxx — the old frame's own residue (a dollar charge
  and the payment that cleared it valued at two frame rates), which the native walk nets to zero.
- Cash netting (the linked cards on the Efectivo card): 222 dates differ, max 6x.xxx.
- Card P/L: 88 of the last 120 days carry an fx term on the current master (largest day 2x.xxx,
  Σ −3x.xxx); over the whole history Σ fx P/L −3xx.xxx and −2xx.xxx on the two Santander masters.
  `pl = −cost` holds to the peso on every day of the daily series.
- `verify-cc-billed-cuotas.ts`, `verify-cc-financing-identity.ts` (section-3 charges) and the bank
  cupo check (recheck, every verdict ok) stay green.

## Open questions

1. Phase 2 must consume `ccOwedByCurrencyAtYmd` for a card shown in USD (the CLP entry points stay
   right for CLP display only).
2. Card P/L in USD display: the fx revaluation is computed in pesos and converted, so in USD it
   still describes the dollar sub-balance's peso move; the right USD figure (the peso sub-balance
   revalued at the sell rate) needs a unit-aware cost leg in `dailySeries` / `accountPerformance`.
3. `balance_statement_clp` (statement frame, internal) still converts at the debt frame: the Cupo
   card's «used» figure and the stored snapshot read it. Move them to the per-currency figure when
   the Cupo card shows each currency apart.
4. The mark-input rule that trims a card 75 days back on an fx row (`markInputChanges.ts`, phase 3)
   over-trims now: a card's past value reads only its own day's rate.
