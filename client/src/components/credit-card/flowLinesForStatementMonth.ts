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
  if (statementLineIds.size === 0) return [];

  return flowsLines.filter(
    (ln) =>
      ln.account_id === accountId &&
      (statementLineIds.has(ln.statement_line_id) ||
        (ln.category_statement_line_id != null &&
          statementLineIds.has(ln.category_statement_line_id)))
  );
}
