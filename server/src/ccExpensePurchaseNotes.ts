import { db } from "./db.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { legacyCheckingGastosPurchaseKey } from "./checkingGastosCategoryPersist.js";
import { resolvePurchaseKeyForGastosLine } from "./ccExpensePurchaseKey.js";
import { mergeAutoDepositMatchNote } from "./ccExpenseDepositMatchNotes.js";
import { mergeAutoAdditionalCardNote } from "./ccAdditionalCardExpenseMatch.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

export function purchaseNotesMapKey(accountId: number, purchaseKey: string): string {
  return `${accountId}|${purchaseKey}`;
}

function accountAllowedForExpensePurchaseNotes(accountId: number): boolean {
  if (listCreditCardMasterAccountIds().includes(accountId)) return true;
  return listMovementBalanceCashAccountIds().includes(accountId);
}

export function loadCcExpensePurchaseNotes(accountIds: number[]): Map<string, string> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const ph = accountIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT account_id, purchase_key, notes
       FROM cc_expense_purchase_notes
       WHERE account_id IN (${ph})`
    )
    .all(...accountIds) as { account_id: number; purchase_key: string; notes: string }[];
  for (const row of rows) {
    out.set(purchaseNotesMapKey(row.account_id, row.purchase_key), row.notes ?? "");
  }
  return out;
}

export function getCcExpensePurchaseNote(accountId: number, purchaseKey: string): string {
  const row = db
    .prepare(
      `SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
    )
    .get(accountId, purchaseKey) as { notes: string } | undefined;
  return row?.notes ?? "";
}

export function setCcExpensePurchaseNote(opts: {
  accountId: number;
  purchaseKey: string;
  notes: string | null | undefined;
}): { notes: string } {
  const purchaseKey = String(opts.purchaseKey ?? "").trim();
  if (!purchaseKey) {
    throw new Error("purchase_key required");
  }
  const allowed = accountAllowedForExpensePurchaseNotes(opts.accountId);
  if (!allowed) {
    throw new Error("account not in credit card expenses scope");
  }

  const text = String(opts.notes ?? "").trim();
  if (!text) {
    db.prepare(
      `DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
    ).run(opts.accountId, purchaseKey);
    return { notes: "" };
  }

  db.prepare(
    `INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).run(opts.accountId, purchaseKey, text);
  return { notes: text };
}

export type FlowCcExpenseLineBeforeNotes = Omit<
  FlowCcExpenseLineRow,
  "purchase_key" | "purchase_notes" | "origin_label"
> & {
  auto_deposit_match_note?: string;
  auto_additional_card_note?: string;
};

export function enrichFlowLinesWithPurchaseNotes(
  lines: FlowCcExpenseLineBeforeNotes[],
  notesByKey?: Map<string, string>
): Omit<FlowCcExpenseLineRow, "origin_label">[] {
  const accountIds = [...new Set(lines.map((ln) => ln.account_id))];
  const notes =
    notesByKey ??
    loadCcExpensePurchaseNotes(
      accountIds.length > 0 ? accountIds : listCreditCardMasterAccountIds()
    );
  return lines.map((ln) => {
    const { auto_deposit_match_note, auto_additional_card_note, ...rest } = ln;
    const purchase_key = resolvePurchaseKeyForGastosLine(rest);
    const dbNotes =
      notes.get(purchaseNotesMapKey(ln.account_id, purchase_key)) ??
      (purchase_key.startsWith("checking-cartola:") && ln.statement_line_id > 0
        ? notes.get(
            purchaseNotesMapKey(
              ln.account_id,
              legacyCheckingGastosPurchaseKey(
                ln.statement_line_id,
                rest.checking_purchase_portion === "deposit" ? "deposit" : "gastos"
              )
            )
          )
        : undefined) ??
      "";
    let purchase_notes = dbNotes;
    if (auto_deposit_match_note) {
      purchase_notes = mergeAutoDepositMatchNote(purchase_notes, auto_deposit_match_note);
    }
    if (auto_additional_card_note) {
      purchase_notes = mergeAutoAdditionalCardNote(purchase_notes, auto_additional_card_note);
    }
    return { ...rest, purchase_key, purchase_notes };
  });
}
