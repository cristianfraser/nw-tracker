import { balanceUsdFxDateIso } from "./ccBillingBalances.js";
import { statementDatesForFacturacion } from "./ccOpenWebPastePdfReconcile.js";
import {
  isClpSection3FinancingChargeMerchant,
  isUsdSection3FinancingChargeMerchant,
} from "./ccStatementSection3.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import {
  type CcInstallmentPurchaseComputed,
  installmentInterestClpForCuota,
} from "./creditCardInstallments.js";
import {
  ccInstallmentLedgerRowCount,
  ccInstallmentsDbApiPayload,
} from "./ccInstallmentLedgerDb.js";

/**
 * Section-3 bank charges (intereses, comisiones, impuestos) billed in one facturación, all cards
 * on the master: the lines of the statements that make up the facturación (the one rule,
 * `statementDatesForFacturacion` — a stale open bucket belongs to the open month), dollars at the
 * facturación's debt rate (pay-by − 1, `balanceUsdFxDateIso`), the frame the daily card P/L
 * (`ccFinancingCostDaily.ts`) values the same charges in.
 */
export function statementSection3ChargesClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number {
  const dates = new Set(statementDatesForFacturacion(accountId, billingMonth));
  let sum = 0;
  for (const st of listCcStatementsForAccount(accountId)) {
    if (!dates.has(st.statement_date)) continue;
    let clpPerUsd: number | null = null;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (line.installment_flag) continue;
      if (st.currency === "usd") {
        const amt = line.amount_usd ?? 0;
        if (!isUsdSection3FinancingChargeMerchant(line.merchant, amt) || amt <= 0) continue;
        if (clpPerUsd == null) {
          const fxDate = balanceUsdFxDateIso(accountId, st.statement_date);
          const fx = fxMonthEndForBalanceUsd(fxDate);
          if (!fx || !(fx.clp_per_usd > 0)) {
            throw new Error(
              `Account ${accountId}: no USD/CLP rate on or before ${fxDate} for the ${st.statement_date} financing charges`
            );
          }
          clpPerUsd = fx.clp_per_usd;
        }
        sum += Math.round(amt * clpPerUsd);
      } else {
        const amt = line.amount_clp ?? 0;
        if (!isClpSection3FinancingChargeMerchant(line.merchant) || amt <= 0) continue;
        sum += amt;
      }
    }
  }
  return Math.round(sum);
}

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
  billingMonth: string
): number {
  let sum = 0;
  for (const p of purchases) {
    if (p.annual_interest_pct <= 0) continue;
    const off = p.schedule_offset_months;
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
  purchases: readonly CcInstallmentPurchaseComputed[]
): string[] {
  const months = new Set<string>();
  for (const st of listCcStatementsForAccount(accountId)) {
    if (st.billing_month) months.add(st.billing_month);
  }
  for (const p of purchases) {
    const off = p.schedule_offset_months;
    for (let i = 0; i < p.installment_count; i++) {
      months.add(addCalendarMonths(p.first_due_month, i + off));
    }
  }
  return [...months].sort((a, b) => a.localeCompare(b));
}

/** Monthly financing cost (intereses/comisiones + installment interest) by billing month. */
export function buildCreditCardFinancingPlByBillingMonth(
  accountId: number,
  purchases: readonly CcInstallmentPurchaseComputed[]
): CcFinancingPlMonthRow[] {
  const allPurchases = purchases;
  const months = collectBillingMonths(accountId, allPurchases);
  if (months.length === 0) return [];

  let ytdYear = 0;
  let ytdRun = 0;
  let cum = 0;
  const out: CcFinancingPlMonthRow[] = [];

  for (const billingMonth of months) {
    const statement_charges_clp = statementSection3ChargesClpForBillingMonth(accountId, billingMonth);
    const installment_interest_clp = installmentInterestClpForBillingMonth(allPurchases, billingMonth);
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

export type CcFinancingPlSummary = {
  cumulative_clp: number;
  ytd_clp: number;
  current_month_clp: number;
};

/**
 * Lightweight dashboard summary of CC financing costs (intereses + installment interest).
 * Returns null when no statement data exists for the account.
 */
export function creditCardFinancingPlSummaryForDashboard(
  masterAccountId: number,
  todayYm: string
): CcFinancingPlSummary | null {
  const hasLedger = ccInstallmentLedgerRowCount(masterAccountId) > 0;
  let purchases: CcInstallmentPurchaseComputed[] = [];
  if (hasLedger) {
    const payload = ccInstallmentsDbApiPayload(masterAccountId);
    purchases = [...payload.purchases, ...payload.purchases_completed];
  }

  const rows = buildCreditCardFinancingPlByBillingMonth(masterAccountId, purchases);
  if (rows.length === 0) return null;

  let currentRow: CcFinancingPlMonthRow | undefined;
  for (const row of rows) {
    if (row.billing_month <= todayYm) currentRow = row;
  }
  if (!currentRow) currentRow = rows[rows.length - 1];

  return {
    cumulative_clp: currentRow.cumulative_financing_cost_clp,
    ytd_clp: currentRow.ytd_financing_cost_clp,
    current_month_clp: currentRow.financing_cost_clp,
  };
}
