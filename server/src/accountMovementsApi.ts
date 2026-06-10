import { noteIsDeptoPiePayment } from "./deptoDividendosLedger.js";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";

export type AccountMovementApiRow = {
  id: number;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
  flow_type: string;
  flow_type_label: string;
};

const movementsStmt = db.prepare(
  `SELECT id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker
   FROM movements WHERE account_id = ? ORDER BY occurred_on DESC, id DESC`
);

function mapMovementRows(
  accountId: number,
  rows: Omit<AccountMovementApiRow, "flow_type" | "flow_type_label">[]
): AccountMovementApiRow[] {
  return rows.map((r) => {
    const flow_type = movementFlowTypeFromRow({
      note: r.note,
      amount_clp: r.amount_clp,
      flow_kind: r.flow_kind,
      accountId,
      movementId: r.id,
      occurred_on: r.occurred_on,
    });
    return {
      ...r,
      flow_type,
      flow_type_label: movementFlowTypeLabel(flow_type),
    };
  });
}

/** All movements for many accounts (one query). */
export function listAccountMovementsForApiBulk(
  accountIds: readonly number[]
): Map<number, AccountMovementApiRow[]> {
  const out = new Map<number, AccountMovementApiRow[]>();
  if (!accountIds.length) return out;

  const unique = [...new Set(accountIds)];
  const ph = unique.map(() => "?").join(",");
  const raw = db
    .prepare(
      `SELECT id, account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker
       FROM movements
       WHERE account_id IN (${ph})
       ORDER BY account_id, occurred_on DESC, id DESC`
    )
    .all(...unique) as (Omit<AccountMovementApiRow, "flow_type" | "flow_type_label"> & {
    account_id: number;
  })[];

  const byAccount = new Map<number, Omit<AccountMovementApiRow, "flow_type" | "flow_type_label">[]>();
  for (const r of raw) {
    const arr = byAccount.get(r.account_id) ?? [];
    const { account_id: _aid, ...row } = r;
    arr.push(row);
    byAccount.set(r.account_id, arr);
  }

  for (const id of unique) {
    const cat = db
      .prepare(
        `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(id) as { bucket_slug: string } | undefined;
    let rows = byAccount.get(id) ?? [];
    if (cat && accountBucketKindSlug(cat.bucket_slug) === "mortgage") {
      rows = rows.filter((r) => !noteIsDeptoPiePayment(r.note));
    }
    out.set(id, mapMovementRows(id, rows));
  }
  return out;
}

export function listAccountMovementsForApi(accountId: number): AccountMovementApiRow[] {
  const cat = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  let rows = movementsStmt.all(accountId) as Omit<AccountMovementApiRow, "flow_type" | "flow_type_label">[];
  if (cat && accountBucketKindSlug(cat.bucket_slug) === "mortgage") {
    rows = rows.filter((r) => !noteIsDeptoPiePayment(r.note));
  }
  return mapMovementRows(accountId, rows);
}
