import type { CcFacturacionDto, FlowCcExpenseLineRow } from "../../types";

/**
 * Facturación modal lines: this card's expense rows whose `billing_month` — stamped by the server
 * with the rule its facturado sums use — is the facturación. The client no longer re-derives which
 * statements belong to a month (an older copy of that rule listed September 2026's bucket under
 * October). A closed facturación lists its statements' own lines (`statement_line_id > 0`); an open
 * or provisionally closed one has no statement cuota lines yet, so the ledger's cuotas for the month
 * stand in — not the facturado-financing `split_only` slices, which are Expenses-tab display
 * derivations carrying the FINANCED card's id on the financing card's months (scope `excluded`
 * stays visible: the financing card's own plan cuotas are real rows). Synthetic installment
 * purchase totals never belong to a facturación.
 */
export function flowLinesForFacturacionMonth(
  flowsLines: readonly FlowCcExpenseLineRow[],
  accountId: number,
  row: Pick<CcFacturacionDto, "billing_month" | "is_open_month" | "is_provisional_close">
): FlowCcExpenseLineRow[] {
  const statementLinesOnly = !row.is_open_month && !row.is_provisional_close;
  return flowsLines.filter((ln) => {
    if (ln.account_id !== accountId || ln.billing_month !== row.billing_month) return false;
    if (ln.line_role === "installment_purchase_total") return false;
    if (ln.statement_line_id > 0) return true;
    return !statementLinesOnly && ln.line_role === "installment_cuota" && ln.gastos_scope !== "split_only";
  });
}
