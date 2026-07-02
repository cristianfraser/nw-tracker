import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccLedgerStatementClosingPointsClp } from "./ccCreditCardValuations.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Regression: billingDetailCacheForAccount (used by the valuation chart) and
 * creditCardInstallmentsResponse (used by historial / detalle por mes) must
 * produce identical balance_total_clp per billing month.
 *
 * Root cause of prior divergence: the cache was built with payload.months
 * (filtered to >= nowYm) so cuota_a_pagar_next_mes_clp was 0 for past months,
 * inflating closed-month balances by one cuota each.
 */
describe("CC billing detail / valuation path invariant", () => {
  it("ccLedgerStatementClosingPointsClp matches creditCardInstallmentsResponse billing_detail balance per month", () => {
    const ccAccounts = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%credit_card%'
           AND a.notes LIKE 'credit_card_master|%'
         LIMIT 10`
      )
      .all() as { id: number }[];

    if (ccAccounts.length === 0) return;

    for (const { id } of ccAccounts) {
      const pts = ccLedgerStatementClosingPointsClp(id);
      if (!pts || pts.length === 0) continue;

      const response = creditCardInstallmentsResponse(id);
      const detailByMonth = new Map(
        (response.billing_detail_by_month ?? []).map((r) => [r.billing_month, r.balance_total_clp])
      );

      // Only check months present in both (valuation pts include more months via ledgerMonths union)
      const mismatches: { month: string; valuation: number; historial: number; diff: number }[] = [];
      for (const pt of pts) {
        const ym = pt.as_of_date.slice(0, 7);
        const historialBalance = detailByMonth.get(ym);
        if (historialBalance == null) continue;
        const diff = Math.abs(pt.value_clp - Math.round(historialBalance));
        if (diff > 1) {
          mismatches.push({ month: ym, valuation: pt.value_clp, historial: Math.round(historialBalance), diff });
        }
      }

      expect(mismatches, `account ${id} has billing detail / valuation mismatches: ${JSON.stringify(mismatches)}`).toHaveLength(0);
    }
  });

  it("facturaciones cuota_a_pagar_clp is non-null for past billing months when installment history exists", () => {
    const nowYm = monthKeyFromYmd(chileCalendarTodayYmd());
    const ccAccounts = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%credit_card%'
           AND a.notes LIKE 'credit_card_master|%'
         LIMIT 10`
      )
      .all() as { id: number }[];

    if (ccAccounts.length === 0) return;

    for (const { id } of ccAccounts) {
      const response = creditCardInstallmentsResponse(id);
      if (!response.facturaciones || !response.installment_history_months) continue;

      // Find billing months whose pay_by month is in the history and precedes nowYm
      // (these are the months that were broken: db.months was filtered to >= nowYm,
      //  so cuotaForPayByMonth returned null for them)
      const historyMonthSet = new Set(
        (response.installment_history_months ?? []).map((h) => h.month)
      );

      const broken: { billing_month: string; pay_by: string | undefined }[] = [];
      for (const f of response.facturaciones) {
        if (!f.billing_month || f.billing_month >= nowYm) continue;
        // Infer pay_by month from billing_month+1 (approximate; sufficient for regression check)
        const [y, m] = f.billing_month.split("-").map(Number) as [number, number];
        const payByYm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
        if (!historyMonthSet.has(payByYm)) continue;
        // This month has installments due in the pay_by period — cuota_a_pagar_clp must be set
        if (f.cuota_a_pagar_clp == null) {
          broken.push({ billing_month: f.billing_month, pay_by: f.pay_by ?? undefined });
        }
      }

      expect(
        broken,
        `account ${id} has past facturaciones with null cuota_a_pagar_clp despite installment history: ${JSON.stringify(broken)}`
      ).toHaveLength(0);
    }
  });
});
