/**
 * What a credit card actually COSTS, per day: the section-3 bank charges (intereses,
 * comisiones, impuestos) from the same statement evidence that drives the owed walk, dated on
 * the day they were charged.
 *
 * This is the card's P/L. Everything else that moves an owed balance — buying (borrowing),
 * paying, and the corrections the evidence anchors apply to our reconstruction of both — is
 * capital flow, so consumers derive the flow leg from the balance instead of summing events:
 *
 *   pl   = −financing                       (loss-negative, like the mortgage's cells)
 *   flow = −Δowed + financing               (capital into the debt is positive)
 *
 * which satisfies the liability identity `pl = prior_owed − owed − flow` exactly, on every
 * day, for every card. Deriving rather than summing matters because the stored anchors are
 * live-formula stamps: at a cierre the billing frame re-splits the same debt between facturado
 * and por-facturar and the balance steps by ~1M against a walk that saw no transaction (·7817,
 * 2026-06-19: +1.373.334). That is measurement noise in the buy/pay legs — attributing it to
 * "cost of financing" would be false. Only the charges the bank printed are cost.
 *
 * NOT a personal-capital source: card flows must stay out of `/flows/deposits`, the deposits
 * reconciliation, and the "aportes acum." companions — paying your own card moves wealth
 * between two accounts of one bucket, it does not add or remove any.
 */
import { normalizedPostCloseLines } from "./ccBillingBalances.js";

/**
 * CLP financing cost per transaction date (positive = cost), deduped by the owed walk's keys
 * so a charge billed on both a web-paste and a PDF statement counts once. Empty map for cards
 * with no statements. The underlying stream is memoized per account in the aggregation cache,
 * so this is a cheap in-memory fold.
 */
export function ccFinancingCostClpByDate(accountId: number): Map<string, number> {
  const seen = new Set<string>();
  const byDate = new Map<string, number>();
  for (const l of normalizedPostCloseLines(accountId)) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    if (!l.financing) continue;
    if (l.clp == null || !Number.isFinite(l.clp) || l.clp === 0) continue;
    byDate.set(l.iso, (byDate.get(l.iso) ?? 0) + l.clp);
  }
  return byDate;
}

/** Σ financing cost (CLP, positive) charged in the window `(fromYmd, toYmd]`. */
export function ccFinancingCostClpBetween(
  accountId: number,
  fromYmd: string,
  toYmd: string
): number {
  let sum = 0;
  for (const [iso, clp] of ccFinancingCostClpByDate(accountId)) {
    if (iso <= fromYmd || iso > toYmd) continue;
    sum += clp;
  }
  return sum;
}
