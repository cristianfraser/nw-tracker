/**
 * Interest a card charges inside an installment plan's cuotas — a cost of financing like the
 * section-3 charges, so the card's P/L counts it (`ccFinancingCostClpByDate`).
 *
 * A plan's `total_amount_clp` is the sum of its printed cuotas; each statement cuota line prints
 * the purchase's principal (`amount_clp`) and the plan's rate (`interest_rate_text`). The interest
 * is total − principal, read only when the statement prints a rate above zero: a 0% plan's total
 * can sit a few pesos off its principal from cuota rounding (BCI rounds each cuota up), which is
 * not interest. A plan no statement has printed yet (hand-entered, or created from the card feed,
 * which shows the principal only) has no interest until its first statement does.
 *
 * Dated on the purchase date: the owed walk adds the plan's whole total that day
 * (`normalizedInstallmentPurchaseEvents`), so booking the interest the same day keeps the
 * derived flow (−Δowed + financing) at the principal.
 */
import { cacheKeyCcBillingDetail, getAggregationCached } from "./aggregationCache.js";
import { normalizeTransactionDateIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";

export type CcInstallmentInterest = {
  purchase_id: number;
  /** ISO purchase date. */
  iso: string;
  principal_clp: number;
  total_clp: number;
  interest_clp: number;
  rate_text: string;
};

/** «3,09 %», «0,00% (T)», «0,00» → percent. Throws on anything else. */
export function printedInstallmentRatePct(text: string): number {
  const m = /^\s*(\d+(?:,\d+)?)\s*%?/.exec(text);
  if (!m) throw new Error(`unreadable installment rate «${text}»`);
  return Number(m[1]!.replace(",", "."));
}

type LineRow = {
  purchase_id: number;
  purchase_date: string;
  total_amount_clp: number;
  principal_clp: number | null;
  rate_text: string | null;
};

/** Plans of the account whose statement prints a rate above zero, with their interest. */
export function ccInstallmentInterestForAccount(accountId: number): CcInstallmentInterest[] {
  return getAggregationCached(`${cacheKeyCcBillingDetail(accountId)}|inst_interest`, () => {
    const rows = db
      .prepare(
        `SELECT ip.id AS purchase_id, ip.purchase_date, ip.total_amount_clp,
                l.amount_clp AS principal_clp, l.interest_rate_text AS rate_text
         FROM cc_installment_purchases ip
         JOIN cc_installment_payments p ON p.purchase_id = ip.id
         JOIN cc_statement_lines l ON l.parser_row_id = p.parser_row_id
         WHERE ip.account_id = ? AND ip.total_amount_clp IS NOT NULL
         ORDER BY ip.id`
      )
      .all(accountId) as LineRow[];
    const byPlan = new Map<number, LineRow[]>();
    for (const r of rows) byPlan.set(r.purchase_id, [...(byPlan.get(r.purchase_id) ?? []), r]);

    const out: CcInstallmentInterest[] = [];
    for (const [purchaseId, lines] of byPlan) {
      const rated = lines.filter((l) => l.rate_text != null && l.rate_text.trim() !== "");
      const positive = rated.filter((l) => printedInstallmentRatePct(l.rate_text!) > 0);
      if (positive.length === 0) continue;
      if (positive.length !== rated.length) {
        throw new Error(`installment plan ${purchaseId}: its statements print both a zero and a positive rate`);
      }
      const principals = new Set(lines.map((l) => l.principal_clp));
      if (principals.size !== 1 || lines[0]!.principal_clp == null) {
        throw new Error(`installment plan ${purchaseId}: its cuota lines print different principals`);
      }
      const principal = lines[0]!.principal_clp!;
      const total = Math.round(lines[0]!.total_amount_clp);
      const interest = total - Math.round(principal);
      if (!(interest > 0)) {
        throw new Error(
          `installment plan ${purchaseId}: printed rate ${positive[0]!.rate_text} but total ${total} ` +
            `is not above the principal ${principal}`
        );
      }
      const iso = normalizeTransactionDateIso(lines[0]!.purchase_date);
      if (!iso) throw new Error(`installment plan ${purchaseId}: unreadable purchase date ${lines[0]!.purchase_date}`);
      out.push({
        purchase_id: purchaseId,
        iso,
        principal_clp: Math.round(principal),
        total_clp: total,
        interest_clp: interest,
        rate_text: positive[0]!.rate_text!,
      });
    }
    return out;
  });
}
