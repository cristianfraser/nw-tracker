import { db } from "./db.js";

export type ExpenseFlowGroupSlug = "real_estate";

export function expenseAccountIdByGroupSlug(
  groupSlug: ExpenseFlowGroupSlug,
  accountSlug: string
): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM expense_accounts a
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = ? AND a.slug = ?`
    )
    .get(groupSlug, accountSlug) as { id: number } | undefined;
  return row?.id ?? null;
}
