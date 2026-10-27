/**
 * Which checking movements are spending — the ones the Expenses page counts as gastos lines.
 * The net-worth flows table («Flujos de patrimonio», `exclude_spending`) leaves them out, so it
 * lists what moves wealth (income, transfers between own accounts, deposits to investments) and
 * the expense list stays on the Expenses page.
 *
 * One rule with the Expenses page: a movement is spending when every gastos line it yields
 * (`loadFinalizedCheckingGastosLinesReadOnly`: the cartola / daily-feed debits, their pieces, and
 * the credits marked as refunds) counts toward gasto del mes (`countsTowardGastosMes`). A debit
 * matched to a deposit, an internal transfer or a «no cuenta» line yields a line in an excluded
 * category and stays; a movement split between spending and such a portion stays too.
 */
import { CC_INSTALLMENT_GASTOS_MODES, countsTowardGastosMes } from "./flowsExpensesGastos.js";
import { loadFinalizedCheckingGastosLinesReadOnly } from "./flowsExpenses.js";

export function checkingMovementKey(movementId: number, accountId: number): string {
  return `${movementId}|${accountId}`;
}

/** `checkingMovementKey` of every checking movement the Expenses page counts as spending. */
export function checkingSpendingMovementKeys(): Set<string> {
  const countsByMovement = new Map<string, boolean>();
  for (const line of loadFinalizedCheckingGastosLinesReadOnly()) {
    // Mirror lines of lost-cartola deposits carry negative ids: no movement behind them.
    if (line.source !== "checking" || line.statement_line_id <= 0) continue;
    const key = checkingMovementKey(line.statement_line_id, line.account_id);
    const counts = CC_INSTALLMENT_GASTOS_MODES.some((mode) => countsTowardGastosMes(line, mode));
    countsByMovement.set(key, (countsByMovement.get(key) ?? true) && counts);
  }
  const out = new Set<string>();
  for (const [key, counts] of countsByMovement) if (counts) out.add(key);
  return out;
}
