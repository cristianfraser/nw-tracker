import { db } from "./db.js";

export type AccountKind = "master" | "liability_view";

export type AccountSourceRow = {
  id: number;
  source_account_id: number | null;
  account_kind: AccountKind;
};

/** Operational account that holds movements, valuations, CC ledger, etc. */
export function resolveOperationalAccountId(accountId: number): number {
  const row = db
    .prepare(`SELECT source_account_id FROM accounts WHERE id = ?`)
    .get(accountId) as { source_account_id: number | null } | undefined;
  return row?.source_account_id ?? accountId;
}

export function getAccountSourceRow(accountId: number): AccountSourceRow | null {
  const row = db
    .prepare(`SELECT id, source_account_id, account_kind FROM accounts WHERE id = ?`)
    .get(accountId) as AccountSourceRow | undefined;
  return row ?? null;
}

/** IDs to match in nav lookup (liability leaf or its master). */
export function accountIdsForNavMatch(accountId: number): number[] {
  const row = getAccountSourceRow(accountId);
  if (!row) return [accountId];
  if (row.account_kind === "liability_view" && row.source_account_id != null) {
    return [accountId, row.source_account_id];
  }
  const views = db
    .prepare(`SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`)
    .all(accountId) as { id: number }[];
  return [accountId, ...views.map((v) => v.id)];
}
