import { clearAccountCategoryMetaCache } from "./liabilitiesValuation.js";
import { db } from "./db.js";

type AccountRow = {
  id: number;
  account_kind: string;
  source_account_id: number | null;
  notes: string | null;
};

function loadAccountRow(accountId: number): AccountRow | null {
  return (
    (db
      .prepare(
        `SELECT id, account_kind, source_account_id, notes FROM accounts WHERE id = ?`
      )
      .get(accountId) as AccountRow | undefined) ?? null
  );
}

function isCreditCardMasterNotes(notes: string | null): boolean {
  return String(notes ?? "").startsWith("credit_card_master|");
}

/** CC master ↔ liability_view pairs stay in sync (same as superseded-card helpers). */
function relatedAccountIdsForExcludeSync(accountId: number, row: AccountRow): number[] {
  const ids = new Set<number>();
  if (row.account_kind === "liability_view" && row.source_account_id != null) {
    ids.add(row.source_account_id);
  }
  if (isCreditCardMasterNotes(row.notes)) {
    const views = db
      .prepare(
        `SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`
      )
      .all(accountId) as { id: number }[];
    for (const { id } of views) ids.add(id);
  }
  ids.delete(accountId);
  return [...ids];
}

export function updateAccountExcludeFromGroupTotals(
  accountId: number,
  raw: unknown
): { exclude_from_group_totals: 0 | 1 } | null {
  if (typeof raw !== "boolean") return null;
  const row = loadAccountRow(accountId);
  if (!row) return null;

  const value = raw ? 1 : 0;
  const relatedIds = relatedAccountIdsForExcludeSync(accountId, row);
  const allIds = [accountId, ...relatedIds];

  const tx = db.transaction(() => {
    const stmt = db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`);
    for (const id of allIds) stmt.run(value, id);
  });
  tx();
  clearAccountCategoryMetaCache();

  return { exclude_from_group_totals: value };
}
