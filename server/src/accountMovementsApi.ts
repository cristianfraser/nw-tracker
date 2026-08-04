import { deptoPieMovementIdSet } from "./deptoDividendosLedger.js";
import { compareFlowRowsForDisplay } from "./brokerageFlowMovement.js";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import {
  accountNameForId,
  counterpartAccountIdFor,
  signedClpDeltaForAccountMovement,
  transferDirectionForAccount,
  type MovementTransferRow,
} from "./movementTransfer.js";

export type AccountMovementApiRow = {
  id: number;
  /**
   * Native amount in `currency`. CLP rows carry the signed per-account delta (legacy
   * `amount_clp` display semantics); non-CLP rows carry the stored amount unsigned,
   * with direction expressed by `transfer_direction`/`flow_type` as before.
   */
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  ticker: string | null;
  flow_type: string;
  flow_type_label: string;
  counterpart_account_id: number | null;
  counterpart_account_name: string | null;
  transfer_direction: "out" | "in" | null;
};

const movementsForAccountStmt = db.prepare(
  `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
          occurred_on, note, units_delta, flow_kind, ticker
   FROM movements
   WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
   ORDER BY occurred_on DESC, id DESC`
);

function mapMovementRows(accountId: number, rows: MovementTransferRow[]): AccountMovementApiRow[] {
  const mapped = rows.map((r) => {
    const counterpartId = counterpartAccountIdFor(r, accountId);
    const flow_type = movementFlowTypeFromRow({
      note: r.note,
      signed_clp_delta: signedClpDeltaForAccountMovement(r, accountId),
      flow_kind: r.flow_kind,
      transfer_direction: transferDirectionForAccount(r, accountId),
    });
    return {
      id: r.id!,
      amount: r.currency === "clp" ? signedClpDeltaForAccountMovement(r, accountId) : r.amount,
      currency: r.currency,
      counter_amount: r.counter_amount,
      counter_currency: r.counter_currency,
      occurred_on: r.occurred_on,
      note: r.note,
      units_delta: r.units_delta,
      flow_kind: r.flow_kind,
      ticker: r.ticker,
      flow_type,
      flow_type_label: movementFlowTypeLabel(flow_type),
      counterpart_account_id: counterpartId,
      counterpart_account_name: counterpartId != null ? accountNameForId(counterpartId) : null,
      transfer_direction: transferDirectionForAccount(r, accountId),
    };
  });
  return mapped.sort(compareFlowRowsForDisplay);
}

/** All movements for many accounts (one query). */
export function listAccountMovementsForApiBulk(
  accountIds: readonly number[]
): Map<number, AccountMovementApiRow[]> {
  const out = new Map<number, AccountMovementApiRow[]>();
  for (const id of accountIds) {
    out.set(id, listAccountMovementsForApi(id));
  }
  return out;
}

export function listAccountMovementsForApi(accountId: number): AccountMovementApiRow[] {
  const cat = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  let rows = movementsForAccountStmt.all(accountId, accountId, accountId) as MovementTransferRow[];
  if (cat && accountBucketKindSlug(cat.bucket_slug) === "mortgage") {
    const pieIds = deptoPieMovementIdSet();
    rows = rows.filter((r) => r.id == null || !pieIds.has(r.id));
  }
  return mapMovementRows(accountId, rows);
}
