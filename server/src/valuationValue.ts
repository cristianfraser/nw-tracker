/**
 * Phase 1 of the `valuations` value+currency refactor (migration 154): every stored
 * valuation is CLP, and every reader must prove it — select `currency` alongside
 * `value` and pass rows through this guard. Mirrors the `equity_daily` rule: readers
 * throw on a stored-currency mismatch, never coerce (fix rows, don't paper over).
 *
 * Phase 2 (native USD-cash valuations converted at read via `fxMonthEndForBalanceUsd`)
 * must revisit every caller of this function — grep for `assertValuationCurrencyClp`.
 */
export function assertValuationCurrencyClp(currency: string, ctx: string): void {
  if (currency !== "clp") {
    throw new Error(
      `${ctx}: valuation stored in '${currency}' — phase-1 readers only support clp`
    );
  }
}
