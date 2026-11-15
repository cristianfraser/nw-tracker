import { accountKindSlugForAccountId } from "./accountBucket.js";
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardExpenseMatch.js";
import { cardLast4ForCreditCardAccount } from "./cards/facturacion.js";
import { db } from "./db.js";
import type { ExpenseLineOrigin, FlowCcExpenseLineSource } from "./expenseLineTypes.js";

export type { ExpenseLineOrigin };

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
  if (source === "manual") return "Manual";
  if (source === "payslip") return "Liquidación";
  if (source === "cc") {
    const last4 = cardLast4ForCreditCardAccount(accountId);
    if (last4) return last4;
    return names.get(accountId) ?? "Tarjeta";
  }
  const kind = accountKindSlugForAccountId(accountId);
  if (kind === "cuenta_vista") return names.get(accountId) ?? "Cuenta vista";
  return names.get(accountId) ?? "Cuenta corriente";
}


const ORIGIN_KIND: Record<FlowCcExpenseLineSource, ExpenseLineOrigin["kind"]> = {
  cc: "card",
  checking: "checking",
  manual: "manual",
  payslip: "payslip",
};

export function expenseLineOrigin(
  line: {
    account_id: number;
    source: FlowCcExpenseLineSource;
    origin_card_last4?: string | null;
    primary_card_last4?: string | null;
  },
  names: Map<number, string>
): ExpenseLineOrigin {
  const kind = ORIGIN_KIND[line.source];
  if (kind === "manual" || kind === "payslip") {
    return { kind, account_name: null, card_last4: null, additional: false };
  }
  const account_name = names.get(line.account_id) ?? null;
  if (kind === "checking") return { kind, account_name, card_last4: null, additional: false };
  const origin = String(line.origin_card_last4 ?? "").trim();
  return {
    kind,
    account_name,
    card_last4: origin || cardLast4ForCreditCardAccount(line.account_id) || null,
    additional: isAdditionalCardExpenseLine(line.origin_card_last4, line.primary_card_last4),
  };
}

export function enrichFlowLinesWithOriginLabels<
  T extends {
    account_id: number;
    source: FlowCcExpenseLineSource;
    origin_card_last4?: string | null;
    primary_card_last4?: string | null;
  },
>(lines: readonly T[]): (T & { origin_label: string; origin: ExpenseLineOrigin })[] {
  const names = loadAccountNameById(lines.map((ln) => ln.account_id));
  return lines.map((ln) => ({
    ...ln,
    origin_label: expenseLineOriginLabel(ln.account_id, ln.source, names),
    origin: expenseLineOrigin(ln, names),
  }));
}
