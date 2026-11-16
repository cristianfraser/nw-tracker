import type {
  AccountMortgageLedgerResponse,
  AccountMonthlyPerformanceRow,
  AccountSummaryResponse,
  DashboardAccountRow,
  DeptoMortgageSheetRow,
  DeptoPaymentScenarioRow,
  Money,
} from "../../types";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";

function money(value: number | null | undefined, currency: string | null | undefined): Money | null {
  return value != null && currency != null ? { value, currency } : null;
}

/**
 * The cards' figures, each with the currency it is in. A figure read from the ledger is in its
 * row's `loan_currency` or `payment_currency`; the fallbacks for a ledger still loading are the
 * home currency (the summary's valuation and the dashboard row: callers pass them only in pesos).
 */
export type MortgageSummaryCardsData = {
  /** The balance in the loan's currency. */
  balanceLoan: Money | null;
  /** The balance in the payment currency. */
  balancePay: Money | null;
  lastPayment: Money | null;
  lastPaymentDate: string | null;
  nextPayment: Money | null;
  nextPaymentDate: string | null;
};

export type PropertySummaryCardsData = {
  /** Net equity in the loan's currency and in the payment currency. */
  valueLoan: Money | null;
  valuePay: Money | null;
  /** Deposited, in `depositedUnit` (the account summary's unit). */
  deposited: number | null;
  depositedUnit: string;
  /** P/L this year and all-time, in `plUnit`. */
  plYtd: number | null;
  plTotal: number | null;
  /** The unit the P/L figures are in: the monthly performance rows', else pesos (the dashboard row fallback). */
  plUnit: string;
};

function sortRowsByOccurredDesc(rows: readonly DeptoMortgageSheetRow[]): DeptoMortgageSheetRow[] {
  return [...rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)));
}

/** Latest sheet row with mortgage balance fields (post-payment snapshot). */
export function latestLedgerSnapshotRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  for (const row of sortRowsByOccurredDesc(rows)) {
    if (row.credito_restante_loan != null || row.restante_pay != null) return row;
  }
  return null;
}

/** Latest sheet row with property net-value fields. */
export function latestPropertyValueRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  for (const row of sortRowsByOccurredDesc(rows)) {
    if (row.valor_neto_loan != null || row.valor_neto_pay != null) return row;
  }
  return null;
}

/** Last dividend payment row (`pago_pay > 0`). */
export function lastMortgagePaymentRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  let best: DeptoMortgageSheetRow | null = null;
  for (const row of rows) {
    if (!(row.pago_pay > 0)) continue;
    if (best == null || row.occurred_on.localeCompare(best.occurred_on) > 0) best = row;
  }
  return best;
}

export function nextMortgagePaymentScenario(
  scenarios: readonly DeptoPaymentScenarioRow[] | undefined
): DeptoPaymentScenarioRow | null {
  return scenarios?.find((r) => r.is_next_payment) ?? null;
}

function latestMonthlyPerfRow(
  rows: readonly AccountMonthlyPerformanceRow[]
): AccountMonthlyPerformanceRow | null {
  if (!rows.length) return null;
  return rows.reduce((best, row) =>
    row.as_of_date.localeCompare(best.as_of_date) > 0 ? row : best
  );
}

export function buildMortgageSummaryCardsData(
  ledger: AccountMortgageLedgerResponse,
  summary: Pick<AccountSummaryResponse, "latest_valuation">,
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[],
  /** A dashboard row in pesos (its unit is the payload's: callers pass it only in CLP). */
  accountDashRow: DashboardAccountRow | null
): MortgageSummaryCardsData {
  const snapshot = latestLedgerSnapshotRow(ledger.rows);
  const lastPayment = lastMortgagePaymentRow(ledger.rows);
  const nextPayment = nextMortgagePaymentScenario(ledger.payment_scenarios);
  const latestPerf = latestMonthlyPerfRow(monthlyPerfRows);

  // The performance row's closing balance is the ledger's, in the loan's currency: shown once the
  // ledger names that currency.
  const balanceLoan =
    money(snapshot?.credito_restante_loan, snapshot?.loan_currency) ??
    money(latestPerf?.closing_balance_uf, ledger.meta?.loan_currency);
  const balancePay =
    money(snapshot?.restante_pay, snapshot?.payment_currency) ??
    money(summary.latest_valuation ?? accountDashRow?.current_value, HOME_CURRENCY);

  return {
    balanceLoan,
    balancePay,
    lastPayment: money(lastPayment?.pago_pay, lastPayment?.payment_currency),
    lastPaymentDate: lastPayment?.occurred_on ?? null,
    nextPayment: money(nextPayment?.min_payment_pay, nextPayment?.payment_currency),
    nextPaymentDate: nextPayment?.occurred_on ?? null,
  };
}

export function buildPropertySummaryCardsData(
  ledger: AccountMortgageLedgerResponse,
  summary: Pick<AccountSummaryResponse, "unit" | "deposits" | "latest_valuation">,
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[],
  /** A dashboard row in pesos (its unit is the payload's: callers pass it only in CLP). */
  accountDashRow: DashboardAccountRow | null
): PropertySummaryCardsData {
  const valueRow = latestPropertyValueRow(ledger.rows);
  const latestPerf = latestMonthlyPerfRow(monthlyPerfRows);

  return {
    valueLoan: money(valueRow?.valor_neto_loan, valueRow?.loan_currency),
    valuePay:
      money(valueRow?.valor_neto_pay, valueRow?.payment_currency) ??
      money(summary.latest_valuation ?? accountDashRow?.current_value, HOME_CURRENCY),
    deposited: summary.deposits,
    depositedUnit: summary.unit,
    plYtd: latestPerf?.ytd_nominal_pl ?? accountDashRow?.delta_year ?? null,
    plTotal: latestPerf?.cumulative_nominal_pl ?? accountDashRow?.delta_total ?? null,
    // The performance rows carry their unit; the dashboard row fallback is pesos (callers pass it
    // only in CLP).
    plUnit: latestPerf?.unit ?? "clp",
  };
}
