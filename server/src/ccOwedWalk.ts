/**
 * A credit card's owed balance on any date — including **today** — from the same frame:
 * the last stored anchor before that date plus the signed evidence dated after it (charges +,
 * PAGOs −, installment contracts at full value on their purchase date).
 *
 * Today used to be valued by the live billing formula instead (facturado + cupo en cuotas −
 * cuota a pagar next mes). That is a different framing of the same debt, so the whole gap
 * between the two landed in today's delta: on 2026-07-23, with no purchase made that day,
 * ·1015 showed +15.486 — exactly one TGR cuota (92.918 ÷ 6) that the billing frame counts and
 * the evidence walk does not. Valuing today the same way as every other day makes a day with
 * no evidence read 0 by construction.
 *
 * The live billing formula still drives the billing surfaces (Balance total, detalle por mes),
 * where the billing frame is the point.
 */
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { db } from "./db.js";
import { assertValuationCurrencyClp } from "./valuationValue.js";

export type CcOwedWalkMark = { value_clp: number; as_of_date: string };

const stmtAnchorBefore = db.prepare(
  `SELECT as_of_date, value AS value_clp, currency FROM valuations
   WHERE account_id = ? AND as_of_date < ?
   ORDER BY as_of_date DESC LIMIT 1`
);

/**
 * Owed at `asOfYmd` walked from the newest anchor **strictly before** it, so writing a stamp
 * for that same date can never make the walk circular (the stamp is derived from this).
 * `as_of_date` reports the anchor the walk started from, matching the historical branch.
 */
export function ccOwedWalkClpAtYmd(accountId: number, asOfYmd: string): CcOwedWalkMark | null {
  const anchor = stmtAnchorBefore.get(accountId, asOfYmd) as
    | { as_of_date: string; value_clp: number; currency: string }
    | undefined;
  if (anchor) assertValuationCurrencyClp(anchor.currency, "ccOwedWalkClpAtYmd");
  if (anchor?.value_clp == null || !Number.isFinite(anchor.value_clp)) return null;
  const value_clp = Math.round(
    anchor.value_clp +
      postCloseLiveBalanceAdjustmentClp(accountId, anchor.as_of_date, asOfYmd, {
        includeInstallmentPurchases: true,
      })
  );
  return { value_clp, as_of_date: anchor.as_of_date };
}
