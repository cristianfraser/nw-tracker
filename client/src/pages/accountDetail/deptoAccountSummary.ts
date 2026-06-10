import type {
  AccountMortgageLedgerResponse,
  AccountMonthlyPerformanceRow,
  AccountSummaryResponse,
  DashboardAccountRow,
  DeptoMortgageSheetRow,
  DeptoPaymentScenarioRow,
} from "../../types";

export type MortgageSummaryCardsData = {
  balanceUf: number | null;
  balanceClp: number | null;
  lastPaymentClp: number | null;
  lastPaymentDate: string | null;
  nextPaymentClp: number | null;
  nextPaymentDate: string | null;
};

export type PropertySummaryCardsData = {
  valueUf: number | null;
  valueClp: number | null;
  depositedClp: number;
  plYtdClp: number | null;
  plTotalClp: number | null;
};

function sortRowsByOccurredDesc(rows: readonly DeptoMortgageSheetRow[]): DeptoMortgageSheetRow[] {
  return [...rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)));
}

/** Latest sheet row with mortgage balance fields (post-payment snapshot). */
export function latestLedgerSnapshotRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  for (const row of sortRowsByOccurredDesc(rows)) {
    if (row.credito_restante_uf != null || row.restante_clp != null) return row;
  }
  return null;
}

/** Latest sheet row with property net-value fields. */
export function latestPropertyValueRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  for (const row of sortRowsByOccurredDesc(rows)) {
    if (row.valor_neto_uf != null || row.valor_neto_clp != null) return row;
  }
  return null;
}

/** Last dividend payment row (`pago_clp > 0`). */
export function lastMortgagePaymentRow(
  rows: readonly DeptoMortgageSheetRow[]
): DeptoMortgageSheetRow | null {
  let best: DeptoMortgageSheetRow | null = null;
  for (const row of rows) {
    if (!(row.pago_clp > 0)) continue;
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
  summary: Pick<AccountSummaryResponse, "latest_valuation_clp">,
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[],
  accountDashRow: DashboardAccountRow | null
): MortgageSummaryCardsData {
  const snapshot = latestLedgerSnapshotRow(ledger.rows);
  const lastPayment = lastMortgagePaymentRow(ledger.rows);
  const nextPayment = nextMortgagePaymentScenario(ledger.payment_scenarios);
  const latestPerf = latestMonthlyPerfRow(monthlyPerfRows);

  const balanceUf =
    snapshot?.credito_restante_uf ??
    latestPerf?.closing_balance_uf ??
    null;
  const balanceClp =
    snapshot?.restante_clp ??
    summary.latest_valuation_clp ??
    accountDashRow?.current_value_clp ??
    null;

  return {
    balanceUf,
    balanceClp,
    lastPaymentClp: lastPayment?.pago_clp ?? null,
    lastPaymentDate: lastPayment?.occurred_on ?? null,
    nextPaymentClp: nextPayment?.min_payment_clp ?? null,
    nextPaymentDate: nextPayment?.occurred_on ?? null,
  };
}

export function buildPropertySummaryCardsData(
  ledger: AccountMortgageLedgerResponse,
  summary: Pick<AccountSummaryResponse, "deposits_clp" | "latest_valuation_clp">,
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[],
  accountDashRow: DashboardAccountRow | null
): PropertySummaryCardsData {
  const valueRow = latestPropertyValueRow(ledger.rows);
  const latestPerf = latestMonthlyPerfRow(monthlyPerfRows);

  return {
    valueUf: valueRow?.valor_neto_uf ?? null,
    valueClp:
      valueRow?.valor_neto_clp ??
      summary.latest_valuation_clp ??
      accountDashRow?.current_value_clp ??
      null,
    depositedClp: summary.deposits_clp,
    plYtdClp: latestPerf?.ytd_nominal_pl ?? accountDashRow?.delta_year_clp ?? null,
    plTotalClp:
      latestPerf?.cumulative_nominal_pl ?? accountDashRow?.delta_total_clp ?? null,
  };
}
