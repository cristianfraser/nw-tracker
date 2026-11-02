import { deptoPieMovementIdSet } from "./deptoDividendosLedger.js";
import { compareFlowRowsForDisplay } from "./brokerageFlowMovement.js";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  accountNameForId,
  counterpartAccountIdFor,
  isMovementTransferRow,
  signedClpDeltaForAccountMovement,
  signedUsdDeltaForAccountMovement,
  transferDirectionForAccount,
  unitsDeltaForAccountMovement,
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
  /** A fund switch's to-leg units (`transferToLegUnits`); null on every other row. */
  counter_units_delta: number | null;
  flow_kind: string | null;
  flow_type: string;
  flow_type_label: string;
  counterpart_account_id: number | null;
  counterpart_account_name: string | null;
  transfer_direction: "out" | "in" | null;
  /** A transfer's origin and target, whichever account views it; null on a single-account movement. */
  from_account_id: number | null;
  from_account_name: string | null;
  to_account_id: number | null;
  to_account_name: string | null;
  /**
   * Whether money (or units) entered or left the viewing account. Null only on a movement of
   * nothing (zero amount, no units: an opening-balance anchor of zero).
   */
  money_direction: "in" | "out" | null;
  /**
   * `occurred_on` is after Chile today: the bank posts it later but today's balance already
   * includes it (`displayLedgerCutoffYmd`). The row keeps its bank date; the client badges it.
   */
  forward_posted: boolean;
};

const movementsForAccountStmt = db.prepare(
  `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
          occurred_on, note, units_delta, counter_units_delta, flow_kind
   FROM movements
   WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
   ORDER BY occurred_on DESC, id DESC`
);

/**
 * Whether the movement put money into the viewing account or took it out: a transfer by its
 * leg, any other movement by its signed amount in its own currency, else by its units (a
 * unit-only row of zero pesos). A movement of nothing (zero amount, no units) has none; any
 * other movement none of those decides is bad data and throws.
 */
export function moneyDirectionForAccount(row: MovementTransferRow, accountId: number): "in" | "out" | null {
  const leg = transferDirectionForAccount(row, accountId);
  if (leg) return leg;
  const signed =
    row.currency === "clp"
      ? signedClpDeltaForAccountMovement(row, accountId)
      : row.currency === "usd"
        ? signedUsdDeltaForAccountMovement(row, accountId)
        : 0;
  if (signed > 0) return "in";
  if (signed < 0) return "out";
  const units = unitsDeltaForAccountMovement(row, accountId);
  if (units > 0) return "in";
  if (units < 0) return "out";
  const movesUnits = row.units_delta != null && Number.isFinite(row.units_delta) && row.units_delta !== 0;
  if (row.amount === 0 && !movesUnits) return null;
  throw new Error(
    `movement ${row.id} on account ${accountId}: neither its amount (${row.amount} ${row.currency}, flow_kind ${row.flow_kind ?? "none"}) nor its units say whether money came in or went out`
  );
}

function mapMovementRows(accountId: number, rows: MovementTransferRow[]): AccountMovementApiRow[] {
  const today = chileCalendarTodayYmd();
  const names = new Map<number, string | null>();
  const nameOf = (id: number): string | null => {
    if (!names.has(id)) names.set(id, accountNameForId(id));
    return names.get(id)!;
  };
  const mapped = rows.map((r) => {
    const counterpartId = counterpartAccountIdFor(r, accountId);
    const transfer = isMovementTransferRow(r);
    const flow_type = movementFlowTypeFromRow({
      signed_clp_delta: signedClpDeltaForAccountMovement(r, accountId),
      flow_kind: r.flow_kind,
      transfer_direction: transferDirectionForAccount(r, accountId),
      currency: r.currency,
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
      counter_units_delta: r.counter_units_delta ?? null,
      flow_kind: r.flow_kind,
      flow_type,
      flow_type_label: movementFlowTypeLabel(flow_type, { currency: r.currency, counter_currency: r.counter_currency }),
      counterpart_account_id: counterpartId,
      counterpart_account_name: counterpartId != null ? nameOf(counterpartId) : null,
      transfer_direction: transferDirectionForAccount(r, accountId),
      from_account_id: transfer ? r.from_account_id! : null,
      from_account_name: transfer ? nameOf(r.from_account_id!) : null,
      to_account_id: transfer ? r.to_account_id! : null,
      to_account_name: transfer ? nameOf(r.to_account_id!) : null,
      money_direction: moneyDirectionForAccount(r, accountId),
      forward_posted: r.occurred_on > today,
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
