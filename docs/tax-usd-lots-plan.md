# Dollar tax lots: request-time rule, card payments, fee, own transfers, F22 (plan, 2026-10-09)

Decisions (user, 2026-10-09, after the research summarized in the memory note):

1. A card's dollar debt paid with dollars (`pago_tarjeta` from a USD cash account, and any dollar
   outflow to a non-USD-cash account) is a disposal: realized under `oficio_2573` AND under
   `oficio_2390` (paying a third party is not «holding»), deferred only under `none`. Proceeds at
   the dólar observado of the payment day.
2. A fee charged in dollars (the broker's withdrawal fee, `cash_fee`) is a lost cost: the dollars
   leave at zero proceeds and their cost is NOT a deductible loss (SII FAQ on crypto commissions,
   Oficio 1474/2020; Oficio 2208/2022). Tagged `fee`, reported, excluded from the year's result.
3. One FIFO queue per account (Oficio 233/2018: FIFO or LIFO, never average); an own transfer moves
   the exact slices, original purchase date and cost intact, from the source queue to the
   destination queue. A broker withdrawal request reserves its gross FIFO at request time (the
   cost tracer's rule), the booking carries the net's slices and the fee's slices.
4. F22: the realized result is first-category income — line 58 d), code 1901, IDPC 25% with the
   credit in line 5 — mirroring the foreign share path (`foreignSharesIdpcClp` / 1914), default
   route `idpc_1901`; alternative route `igc_1032` reuses the crypto path (169 for a loss). The
   result (not the cost) is reajustado to December like the crypto gain. Report-only until filed.
5. Both modules share one walk: the cost tracer emits `own_transfer` lots per carried slice instead
   of one blended lot. Today's 2026-10-09 payment rate is unchanged by construction.

## Phase 1 — shared walk (`usdCashLotWalk.ts`), both modules on it

- New `server/src/usdCashLotWalk.ts`: per-account queues of slices
  `{acquiredOn, acquireMovementId, cents, clp, source}`; events ordered by the cost tracer's rule
  (Chile date; within a day by `movement_event_times` when every event of the day has one, else
  arrivals first, then id; a request among its account's events by time); request-time
  reservations and bookings as in `usdCashCostLots.ts`; own transfers carry slices; a shortfall
  above a cent throws. Pricing of inflows is a caller-supplied function (the tracer prices at the
  real pesos / `fxRowOnOrBefore`; the tax module at the observado or `pesos_paid`).
- `usdCashCostLots.ts` rewritten on the walk. Its outputs are unchanged except that an
  `own_transfer` outflow now lists one lot per carried slice; `usdCashCostLots.test.ts` passes
  unchanged (add a case where a moved batch spans two purchase rates and is partly spent).
- `usdCashTaxLotEvents.ts` rewritten on the walk: `usdCashTaxDisposals({posture, purchaseCost})`
  over every USD cash account (`isUsdCashAccount`), returning `UsdFxDisposal[]`
  (`TaxLotDisposal` + `accountId` + `tag: "realized" | "deferred" | "fee"`) and the open slices.
  Event rules: purchase (CLP → USD transfer) acquires at observado × units or the pesos paid;
  dividend / sale proceeds / interest / plain dollar deposit acquire at observado; `stock_buy`
  disposes (realized under 2573, deferred under 2390 and none); `pago_tarjeta` and any outflow to
  a non-USD-cash account dispose (realized under 2573 and 2390, deferred under none); reconversion
  to pesos disposes (realized unless `none`); `cash_fee` disposes at zero proceeds tagged `fee`;
  an own transfer (USD cash → USD cash) carries slices; anything else throws.
- Dry run on a `.backup` copy of the real DB: the cost tracer's per-payment pesos identical before
  and after; the tax disposals listed for the user (counts and dates, no amounts in the repo).

## Phase 2 — the year's result (`usdFxTaxGains.ts`)

- `usdFxTaxGainsForYear(incomeYear, {posture, purchaseCost, route}, load = usdCashTaxDisposals)`:
  realized disposals of the year, each with proceeds, cost (no IPC on the cost), gain, the
  December reajuste on the result as `cryptoTaxGains.ts` does (same helper, same estimate rule
  for an open year), the fee disposals listed apart with their lost cost, deferred disposals
  listed for information. Result: `{disposals, feesLostClp, deferredClp, resultClp,
  resultDecemberClp, route, reajusteToMonth}`.
- Fix the crypto citation: the no-fee-deduction rule's source is the SII FAQ citing Oficio
  1474/2020; 2208/2022 restates it.

## Phase 3 — F22 wiring and page (after the art. 107 work is committed)

- `f22Draft.ts`: an `fx_result` block. Route `idpc_1901`: code 1901 in line 58 d), IDPC at
  `IDPC_RATE`, the credit in line 5 (same mechanics as the foreign shares' 1914, net zero on 304
  except through 158), kept out of the 169 pool; a loss offsets only the year's other art. 20 N°5
  first-category income and is otherwise lost. Route `igc_1032`: adds to 1032, a loss into 169
  like crypto. Report-only (`estimated`).
- `f22DraftPayload.ts` + `TaxReturnPage.tsx`: a «Diferencias de cambio» section listing the
  disposals (date, dollars, cost date(s), observado both days, result), the fees lost, the
  deferred total, the route and the posture; i18n keys in master.json.
