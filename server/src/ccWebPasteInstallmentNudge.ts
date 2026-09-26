import { db } from "./db.js";
import { findMatchingInstallmentPurchase, purchaseAmountsMatch } from "./ccCrossImportDedupe.js";
import {
  billingMonthForPurchaseDate,
  loadCreditCardBillingConfig,
} from "./ccBillingMonth.js";
import {
  billingMonthContainingPurchase,
  billingMonthForManualLedgerPurchase,
} from "./ccManualBillingMonth.js";
import { firstCuotaBillingMonth } from "./ccCuotaPurchaseKinds.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "./ccCreditCardValuations.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

export type CcInstallmentFirstDueNudge = {
  purchase_id: number;
  merchant: string | null;
  from: string | null;
  to: string;
  /** `feed_type`: the feed's cuota type fixed the month; `open_month`: an untyped re-listing. */
  rule: "feed_type" | "open_month";
};

const selPlanDetail = db.prepare<[number]>(
  `SELECT p.source, p.first_due_month,
          (SELECT COUNT(*) FROM cc_installment_payments pay WHERE pay.purchase_id = p.id) AS payment_count
   FROM cc_installment_purchases p WHERE p.id = ?`
);

const updFirstDueMonth = db.prepare<[string, number]>(
  `UPDATE cc_installment_purchases SET first_due_month = ? WHERE id = ?`
);

/**
 * A web paste of "movimientos no facturados" re-lists a manual installment plan's upcoming cuota
 * (BCI Lider posts it under the original purchase date). That line is import-skipped as an
 * installment overlap, but it is also evidence that the plan's first cuota bills in THIS
 * facturación. The manual-plan heuristic (`purchaseFirstDueYm`) now guesses the purchase's own
 * cycle by default, so the nudge usually confirms the guess — it still matters as stored
 * evidence (write-once) that survives if the default heuristic ever changes.
 * When a pasted charge maps to a manual plan that has not yet billed any cuota and whose purchase
 * date naturally falls in the open cycle, pin `first_due_month` to the open billing month.
 *
 * Guarded so the nudge is a one-time, evidence-driven correction:
 *   - plan `source = 'manual'` (PDF plans carry their own cuota dates),
 *   - zero rows in `cc_installment_payments` (no billed cuota to derive from yet),
 *   - `first_due_month` still NULL (write-once — a later re-paste of cuota 2 can't drag it),
 *   - the purchase's own billing cycle equals the open month (a stale paste in a later month
 *     won't misfire).
 * A subsequent PDF cuota-01 line still overrides the stored value at read time.
 *
 * **Typed feed rows (2026-09-26).** When the matched row is the plan's own purchase row from the
 * Santander feed (principal-sized, typed «CUOTA COMERCIO» / «PRECIO CONTADO»), its type fixes the
 * month outright — cuota comercio bills at the close after the purchase cycle, precio contado at
 * its own (`ccCuotaPurchaseKinds.ts`) — so it pins that month and corrects an earlier pin: the
 * open-month rule had put the 2026-08-28 «EXPRESS PLAZA L» cuota comercio plan in September. The
 * result depends only on the purchase date, so a repeat cannot drag it; a statement cuota line
 * still wins at read time, and a plan with statement payments is never touched.
 */
export function applyWebPasteInstallmentFirstDueNudges(
  accountId: number,
  parsedLines: readonly CcWebPasteLine[]
): CcInstallmentFirstDueNudge[] {
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (!openBm) return [];
  const config = loadCreditCardBillingConfig(accountId);

  const nudges: CcInstallmentFirstDueNudge[] = [];
  const nudged = new Set<number>();

  for (const line of parsedLines) {
    const amountClp = Math.abs(Math.trunc(line.amount_clp));
    if (amountClp <= 0) continue; // PAGOs / USD-only lines carry no CLP charge

    const match = findMatchingInstallmentPurchase(
      accountId,
      line.merchant,
      line.transaction_date,
      amountClp
    );
    if (!match || nudged.has(match.id)) continue;

    const detail = selPlanDetail.get(match.id) as
      | { source: string; first_due_month: string | null; payment_count: number }
      | undefined;
    if (!detail) continue;
    if (detail.source !== "manual") continue;
    if (detail.payment_count > 0) continue;

    if (line.cuota_purchase && purchaseAmountsMatch(match.total_amount_clp, amountClp)) {
      const target = firstCuotaBillingMonth(
        line.cuota_purchase.kind,
        billingMonthContainingPurchase(accountId, match.purchase_date)
      );
      nudged.add(match.id);
      if (detail.first_due_month === target) continue;
      updFirstDueMonth.run(target, match.id);
      nudges.push({
        purchase_id: match.id,
        merchant: match.merchant,
        from: detail.first_due_month,
        to: target,
        rule: "feed_type",
      });
      continue;
    }

    if (detail.first_due_month != null) continue;
    if (billingMonthForPurchaseDate(match.purchase_date, config) !== openBm) continue;

    updFirstDueMonth.run(openBm, match.id);
    nudged.add(match.id);
    nudges.push({
      purchase_id: match.id,
      merchant: match.merchant,
      from: detail.first_due_month,
      to: openBm,
      rule: "open_month",
    });
  }

  if (nudges.length > 0) {
    upsertCreditCardValuationsFromLedger(accountId);
    recomputeCcBillingMonthBalances(accountId);
  }

  return nudges;
}
