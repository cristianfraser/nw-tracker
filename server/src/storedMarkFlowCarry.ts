import { netDepositFlowBetween } from "./flowsDeposits.js";

/**
 * Book-value carry for manual-marked accounts (terminal stored-`valuations` forward-fill):
 * a stale mark carries forward **plus net personal flows since its date**, so a deposit
 * between marks raises the value on its own day and the day's P/L is 0 — the true
 * inter-mark P/L lands on the next mark day, clean of the flow.
 *
 * The flow window `(stored_as_of, as_of]` uses `netDepositFlowBetween` — the exact reference
 * the daily-series flow legs and the d1 cell use — so `pl = delta − flow = 0` on flow days
 * by construction. A mark dated the flow day has an empty window (the mark already reflects
 * it; no double count). Never apply to credit-card or mortgage balances: CC owed-on-date has
 * its own derivation, and a mortgage payment's balance effect is amortization only.
 */
export function storedMarkValueWithFlowCarry(
  accountId: number,
  storedValueClp: number,
  storedAsOfYmd: string,
  asOfYmd: string
): number {
  if (storedAsOfYmd >= asOfYmd) return storedValueClp;
  return storedValueClp + netDepositFlowBetween(accountId, storedAsOfYmd, asOfYmd, "clp");
}
