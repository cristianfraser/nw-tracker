import { mergedFacturacionLines } from "../../pages/accountDetail/mergedFacturacionLines";
import type { CcFacturacionDto, CcStatementDto, FlowCcExpenseLineRow } from "../../types";

function payByCalendarMonth(payByIso: string | null | undefined): string | null {
  const iso = String(payByIso ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  return iso.slice(0, 7);
}

function flowLinesFromImportedStatements(
  flowsLines: readonly FlowCcExpenseLineRow[],
  statements: readonly CcStatementDto[],
  accountId: number,
  billingMonth: string
): FlowCcExpenseLineRow[] {
  const statementLineIds = new Set(
    mergedFacturacionLines(statements, billingMonth).map((ln) => ln.id)
  );
  if (statementLineIds.size === 0) return [];

  return flowsLines.filter((ln) => {
    if (ln.account_id !== accountId) return false;
    if (ln.line_role === "installment_purchase_total") return false;
    return statementLineIds.has(ln.statement_line_id);
  });
}

function deducedInstallmentCuotaLines(
  flowsLines: readonly FlowCcExpenseLineRow[],
  accountId: number,
  payByIso: string | null | undefined
): FlowCcExpenseLineRow[] {
  const payByYm = payByCalendarMonth(payByIso);
  if (!payByYm) return [];

  return flowsLines.filter((ln) => {
    if (ln.account_id !== accountId) return false;
    if (ln.line_role !== "installment_cuota") return false;
    return ln.billing_month === payByYm;
  });
}

/** Flow expense rows that belong to imported statement lines for one billing month. */
export function flowLinesForBillingStatementMonth(
  flowsLines: readonly FlowCcExpenseLineRow[],
  statements: readonly CcStatementDto[],
  accountId: number,
  billingMonth: string
): FlowCcExpenseLineRow[] {
  return flowLinesFromImportedStatements(flowsLines, statements, accountId, billingMonth);
}

/**
 * Facturación modal lines: closed months = PDF/imported statement rows only;
 * open month = web-paste únicos + ledger-deduced installment cuotas (pay-by month).
 */
export function flowLinesForFacturacionMonth(
  flowsLines: readonly FlowCcExpenseLineRow[],
  statements: readonly CcStatementDto[],
  accountId: number,
  row: Pick<CcFacturacionDto, "billing_month" | "pay_by_iso" | "is_open_month">
): FlowCcExpenseLineRow[] {
  const imported = flowLinesFromImportedStatements(
    flowsLines,
    statements,
    accountId,
    row.billing_month
  );
  if (!row.is_open_month) return imported;

  const byKey = new Map<string, FlowCcExpenseLineRow>();
  for (const ln of imported) {
    byKey.set(`stmt:${ln.statement_line_id}`, ln);
  }
  for (const ln of deducedInstallmentCuotaLines(flowsLines, accountId, row.pay_by_iso)) {
    byKey.set(`cuota:${ln.statement_line_id}`, ln);
  }
  return [...byKey.values()];
}
