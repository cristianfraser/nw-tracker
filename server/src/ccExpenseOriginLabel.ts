import { cardLast4ForCreditCardAccount } from "./ccManualBillingMonth.js";
import { db } from "./db.js";
import type {
  FlowCcExpenseLineRow,
  FlowCcExpenseLineRowDraft,
  FlowCcExpenseLineSource,
} from "./flowsCreditCardExpenses.js";

export function loadAccountNameById(accountIds: readonly number[]): Map<number, string> {
  const unique = [...new Set(accountIds.filter((id) => id > 0))];
  const map = new Map<number, string>();
  if (unique.length === 0) return map;
  const ph = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, name FROM accounts WHERE id IN (${ph})`)
    .all(...unique) as { id: number; name: string }[];
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    if (name) map.set(row.id, name);
  }
  return map;
}

export function expenseLineOriginLabel(
  accountId: number,
  source: FlowCcExpenseLineSource,
  names: Map<number, string>
): string {
  if (source === "cc") {
    const last4 = cardLast4ForCreditCardAccount(accountId);
    if (last4) return last4;
    return names.get(accountId) ?? "Tarjeta";
  }
  return names.get(accountId) ?? "Cuenta corriente";
}

export function enrichFlowLinesWithOriginLabels(
  lines: readonly FlowCcExpenseLineRowDraft[]
): FlowCcExpenseLineRow[] {
  const names = loadAccountNameById(lines.map((ln) => ln.account_id));
  return lines.map((ln) => ({
    ...ln,
    origin_label: expenseLineOriginLabel(ln.account_id, ln.source, names),
  }));
}
