import { mergedFacturacionLines } from "../../pages/accountDetail/mergedFacturacionLines";
import type { CcStatementDto, FlowCcExpenseLineRow } from "../../types";

/** Flow expense rows that belong to imported statement lines for one billing month. */
export function flowLinesForBillingStatementMonth(
  flowsLines: readonly FlowCcExpenseLineRow[],
  statements: readonly CcStatementDto[],
  accountId: number,
  billingMonth: string
): FlowCcExpenseLineRow[] {
  const statementLineIds = new Set(
    mergedFacturacionLines(statements, billingMonth).map((ln) => ln.id)
  );

  return flowsLines.filter((ln) => {
    if (ln.account_id !== accountId) return false;
    // Facturación = movements on this month's imported statements only (not gastos totals / ledger fill).
    if (ln.line_role === "installment_purchase_total") return false;
    if (statementLineIds.size === 0) return false;
    return statementLineIds.has(ln.statement_line_id);
  });
}
