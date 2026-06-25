import { statementSection3ChargesClpForBillingMonth } from "./ccStatementSection3.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import {
  type CcInstallmentPurchaseComputed,
  installmentInterestClpForCuota,
} from "./creditCardInstallments.js";

export type CcFinancingPlMonthRow = {
  billing_month: string;
  statement_charges_clp: number;
  installment_interest_clp: number;
  financing_cost_clp: number;
  ytd_financing_cost_clp: number;
  cumulative_financing_cost_clp: number;
};

function installmentInterestClpForBillingMonth(
  purchases: readonly CcInstallmentPurchaseComputed[],
  extraOffsetsByPurchaseId: Readonly<Record<string, number>>,
  billingMonth: string
): number {
  let sum = 0;
  for (const p of purchases) {
    if (p.annual_interest_pct <= 0) continue;
    const off = p.schedule_offset_months + (extraOffsetsByPurchaseId[p.purchase_id] ?? 0);
    const paid = Math.min(Math.max(0, p.installments_paid), p.installment_count);
    for (let i = paid; i < p.installment_count; i++) {
      const dueMonth = addCalendarMonths(p.first_due_month, i + off);
      if (dueMonth !== billingMonth) continue;
      sum += installmentInterestClpForCuota(
        p.principal_clp,
        p.annual_interest_pct,
        p.installment_count,
        i,
        p.cuota_clp
      );
    }
  }
  return sum;
}

function collectBillingMonths(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[],
  extraOffsetsByPurchaseId: Readonly<Record<string, number>>
): string[] {
  const months = new Set<string>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month) months.add(st.billing_month);
  }
  for (const p of purchases) {
    const off = p.schedule_offset_months + (extraOffsetsByPurchaseId[p.purchase_id] ?? 0);
    for (let i = 0; i < p.installment_count; i++) {
      months.add(addCalendarMonths(p.first_due_month, i + off));
    }
  }
  return [...months].sort((a, b) => a.localeCompare(b));
}

/** Monthly financing cost (intereses/comisiones + installment interest) by billing month. */
export function buildCreditCardFinancingPlByBillingMonth(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[],
  extraOffsetsByPurchaseId: Readonly<Record<string, number>> = {}
): CcFinancingPlMonthRow[] {
  const allPurchases = purchases;
  const months = collectBillingMonths(accountId, allPurchases, extraOffsetsByPurchaseId);
  if (months.length === 0) return [];

  let ytdYear = 0;
  let ytdRun = 0;
  let cum = 0;
  const out: CcFinancingPlMonthRow[] = [];

  for (const billingMonth of months) {
    const statement_charges_clp = statementSection3ChargesClpForBillingMonth(accountId, billingMonth);
    const installment_interest_clp = installmentInterestClpForBillingMonth(
      allPurchases,
      extraOffsetsByPurchaseId,
      billingMonth
    );
    const financing_cost_clp = statement_charges_clp + installment_interest_clp;

    const y = Number(billingMonth.slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += financing_cost_clp;
    cum += financing_cost_clp;

    out.push({
      billing_month: billingMonth,
      statement_charges_clp,
      installment_interest_clp,
      financing_cost_clp,
      ytd_financing_cost_clp: ytdRun,
      cumulative_financing_cost_clp: cum,
    });
  }

  return out;
}
