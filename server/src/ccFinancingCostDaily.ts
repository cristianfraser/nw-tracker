/**
 * What a credit card actually COSTS, per day: the section-3 bank charges (intereses,
 * comisiones, impuestos) from the same statement evidence that drives the owed walk, dated on
 * the day they were charged, and the interest inside installment plans' cuotas, dated on the
 * purchase date (`ccInstallmentInterest.ts`).
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
 * and por-facturar and the balance steps by ~1M against a walk that saw no transaction (·0781,
 * 2026-06-19: +1.xxx.xxx). That is measurement noise in the buy/pay legs — attributing it to
 * "cost of financing" would be false. Only the charges the bank printed are cost.
 *
 * NOT a personal-capital source: card flows must stay out of `/flows/deposits`, the deposits
 * reconciliation, and the "aportes acum." companions — paying your own card moves wealth
 * between two accounts of one bucket, it does not add or remove any.
 */
import { normalizedPostCloseLines } from "./ccBillingBalances.js";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { ccRevaluationCostByDate } from "./ccOwedWalk.js";
import type { CurrencyCode } from "./rates.js";
import { convertValue } from "./valueConvert.js";

/**
 * CLP financing cost per transaction date (positive = cost), deduped by the owed walk's keys
 * so a charge billed on both a web-paste and a PDF statement counts once. Empty map for cards
 * with no statements. The underlying stream is memoized per account in the aggregation cache,
 * so this is a cheap in-memory fold.
 */
export function ccSection3FinancingClpByDate(accountId: number): Map<string, number> {
  const seen = new Set<string>();
  const byDate = new Map<string, number>();
  for (const l of normalizedPostCloseLines(accountId)) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    if (!l.financing) continue;
    if (l.clp == null || !Number.isFinite(l.clp) || l.clp === 0) continue;
    byDate.set(l.iso, (byDate.get(l.iso) ?? 0) + l.clp);
  }
  for (const plan of ccInstallmentInterestForAccount(accountId)) {
    byDate.set(plan.iso, (byDate.get(plan.iso) ?? 0) + plan.interest_clp);
  }
  return byDate;
}

/**
 * The bank's charges and plan interest per day in `unit`: in pesos as
 * {@link ccSection3FinancingClpByDate} states them; in another unit each charge in the currency it
 * was billed in, converted once at its own day's rate at the debt side (a charge adds to what is
 * owed), so with the card's value in that unit the derived flow is the evidence at each day's rate.
 */
function ccChargesByDateInUnit(accountId: number, unit: CurrencyCode): Map<string, number> {
  if (unit === "clp") return ccSection3FinancingClpByDate(accountId);
  const seen = new Set<string>();
  const byDate = new Map<string, number>();
  const add = (iso: string, qty: number, from: CurrencyCode) => {
    const v = from === unit ? qty : convertValue(qty, from, unit, iso, "debt");
    if (v == null || !Number.isFinite(v)) {
      throw new Error(`card ${accountId}: no ${from}→${unit} rate on or before ${iso} for a financing charge`);
    }
    byDate.set(iso, (byDate.get(iso) ?? 0) + v);
  };
  for (const l of normalizedPostCloseLines(accountId)) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    if (!l.financing) continue;
    if (l.amount == null || !Number.isFinite(l.amount) || l.amount === 0) continue;
    add(l.iso, l.amount, l.currency);
  }
  for (const plan of ccInstallmentInterestForAccount(accountId)) add(plan.iso, plan.interest_clp, "clp");
  return byDate;
}

/**
 * The card's whole P/L as a cost per day (positive = loss) in `unit`: the bank's charges and plan
 * interest plus the fx revaluation of the sub-balances owed in another currency
 * (`ccRevaluationCostByDate`: in pesos the dollars owed — a loss when the peso falls — with each
 * dollar payment at the pesos actually paid; in dollars the pesos owed). With this cost the
 * derived flow `−Δowed + cost`, both in `unit`, is the evidence at each event's day rate, and
 * Σ of the days of a month is the month (the monthly rows read the same map).
 */
export function ccFinancingCostByDateInUnit(accountId: number, unit: CurrencyCode): Map<string, number> {
  const byDate = new Map(ccChargesByDateInUnit(accountId, unit));
  for (const [iso, cost] of ccRevaluationCostByDate(accountId, unit)) {
    byDate.set(iso, (byDate.get(iso) ?? 0) + cost);
  }
  return byDate;
}

/** {@link ccFinancingCostByDateInUnit} in pesos. */
export function ccFinancingCostClpByDate(accountId: number): Map<string, number> {
  return ccFinancingCostByDateInUnit(accountId, "clp");
}

/** Σ card cost (positive) in `unit` in the window `(fromYmd, toYmd]`: charges, plan interest and fx revaluation. */
export function ccFinancingCostBetweenInUnit(
  accountId: number,
  fromYmd: string,
  toYmd: string,
  unit: CurrencyCode
): number {
  let sum = 0;
  for (const [iso, v] of ccFinancingCostByDateInUnit(accountId, unit)) {
    if (iso <= fromYmd || iso > toYmd) continue;
    sum += v;
  }
  return sum;
}

/** {@link ccFinancingCostBetweenInUnit} in pesos. */
export function ccFinancingCostClpBetween(accountId: number, fromYmd: string, toYmd: string): number {
  return ccFinancingCostBetweenInUnit(accountId, fromYmd, toYmd, "clp");
}
