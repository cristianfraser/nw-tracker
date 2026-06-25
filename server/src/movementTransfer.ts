/**
 * Single-row cross-account transfers (`from_account_id` → `to_account_id`, `account_id` NULL).
 */

import type { Database } from "better-sqlite3";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { signedAmountClpForBrokerageFlow } from "./brokerageFlowMovement.js";
import { db } from "./db.js";

export type MovementTransferRow = {
  id?: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
};

export function isMovementTransferRow(row: {
  account_id?: number | null;
  from_account_id?: number | null;
  to_account_id?: number | null;
}): boolean {
  return (
    row.account_id == null &&
    row.from_account_id != null &&
    row.to_account_id != null &&
    row.from_account_id !== row.to_account_id
  );
}

export function movementInvolvesAccount(
  row: Pick<MovementTransferRow, "account_id" | "from_account_id" | "to_account_id">,
  accountId: number
): boolean {
  return (
    row.account_id === accountId ||
    row.from_account_id === accountId ||
    row.to_account_id === accountId
  );
}

export function counterpartAccountIdFor(
  row: Pick<MovementTransferRow, "account_id" | "from_account_id" | "to_account_id">,
  viewedAccountId: number
): number | null {
  if (!isMovementTransferRow(row)) return null;
  if (row.from_account_id === viewedAccountId) return row.to_account_id;
  if (row.to_account_id === viewedAccountId) return row.from_account_id;
  return null;
}

export function transferDirectionForAccount(
  row: Pick<MovementTransferRow, "account_id" | "from_account_id" | "to_account_id">,
  viewedAccountId: number
): "out" | "in" | null {
  if (!isMovementTransferRow(row)) return null;
  if (row.from_account_id === viewedAccountId) return "out";
  if (row.to_account_id === viewedAccountId) return "in";
  return null;
}

function absAmount(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.abs(n);
}

/** Signed CLP impact of one movement row on `accountId` (transfer + legacy). */
export function signedClpDeltaForAccountMovement(
  row: MovementTransferRow,
  accountId: number
): number {
  if (isMovementTransferRow(row)) {
    const mag = absAmount(row.amount_clp);
    if (row.from_account_id === accountId) return -mag;
    if (row.to_account_id === accountId) return mag;
    return 0;
  }
  if (row.account_id !== accountId) return 0;
  if (row.flow_kind != null) {
    return signedAmountClpForBrokerageFlow(row.flow_kind, row.amount_clp, row.amount_usd);
  }
  return row.amount_clp;
}

/** Signed USD cash impact (USD-cash accounts and transfer legs). */
export function signedUsdDeltaForAccountMovement(
  row: MovementTransferRow,
  accountId: number
): number {
  if (isMovementTransferRow(row)) {
    const mag = absAmount(row.amount_usd);
    if (mag === 0) return 0;
    const fk = row.flow_kind;
    const units = row.units_delta;
    const hasUnits = units != null && Number.isFinite(units) && units !== 0;
    if (row.from_account_id === accountId) {
      // stock_sell USD proceeds land on USD cash (to_account), not the equity from leg.
      if (fk === "stock_sell") return 0;
      // migration:usd-cash stock_buy legs mirror equity funding; USD cash was not debited at import.
      if (fk === "stock_buy" && row.note?.includes("migration:usd-cash")) return 0;
      return -mag;
    }
    if (row.to_account_id === accountId) {
      // stock_buy: share units on the stock leg consume USD from cash (from_account).
      if (fk === "stock_buy" && hasUnits) return 0;
      return mag;
    }
    return 0;
  }
  if (row.account_id !== accountId) return 0;
  const fk = row.flow_kind;
  if (fk === "compra_usd" || fk === "compra_usd_venta_clp") {
    const units = row.units_delta;
    if (units != null && Number.isFinite(units) && units !== 0) return 0;
    // Mirror compra legs (historical import / CLP-wire link); USD cash was not credited at import.
    if (row.note?.includes("migration:fx-merge") || row.note?.includes("clp-wire-link")) return 0;
    return absAmount(row.amount_usd);
  }
  if (fk === "withdrawal_usd") return -absAmount(row.amount_usd);
  return 0;
}

/** Share units credited on `accountId` (legacy account_id, transfer to_account buy, or from_account sell). */
export function unitsDeltaForAccountMovement(
  row: MovementTransferRow,
  accountId: number
): number {
  const units = row.units_delta;
  if (units == null || !Number.isFinite(units) || units === 0) return 0;
  if (isMovementTransferRow(row)) {
    if (row.flow_kind === "stock_sell") {
      if (row.from_account_id === accountId) return -Math.abs(units);
      return 0;
    }
    return row.to_account_id === accountId ? units : 0;
  }
  return row.account_id === accountId ? units : 0;
}

export function isUsdCashKindSlug(kindSlug: string): boolean {
  return kindSlug === "usd";
}

export function isUsdCashAccount(accountId: number): boolean {
  const slug = bucketSlugForAccountId(accountId);
  if (!slug) return false;
  return isUsdCashKindSlug(accountBucketKindSlug(slug));
}

const MOVEMENTS_FOR_ACCOUNT_SQL = `
  SELECT id, account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
         units_delta, flow_kind, amount_usd, ticker
  FROM movements
  WHERE account_id = ?
     OR from_account_id = ?
     OR to_account_id = ?
  ORDER BY occurred_on DESC, id DESC`;

export function listMovementRowsForAccount(accountId: number): MovementTransferRow[] {
  return db.prepare(MOVEMENTS_FOR_ACCOUNT_SQL).all(accountId, accountId, accountId) as MovementTransferRow[];
}

export function sumClpThroughDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  const rows = dbHandle
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, amount_clp, flow_kind, amount_usd
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND occurred_on <= ?`
    )
    .all(accountId, accountId, accountId, asOfYmd) as MovementTransferRow[];
  let total = 0;
  for (const r of rows) {
    total += signedClpDeltaForAccountMovement(r, accountId);
  }
  return Math.round(total);
}

export function sumUsdThroughDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  const rows = dbHandle
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, amount_usd, units_delta, flow_kind, note
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND occurred_on <= ?`
    )
    .all(accountId, accountId, accountId, asOfYmd) as MovementTransferRow[];
  let total = 0;
  for (const r of rows) {
    total += signedUsdDeltaForAccountMovement(r, accountId);
  }
  return total;
}

export function sumUnitsThroughDate(
  accountId: number,
  asOfYmd: string,
  flowKinds: readonly string[],
  dbHandle: Database = db
): number {
  if (flowKinds.length === 0) return 0;
  const ph = flowKinds.map(() => "?").join(", ");
  const rows = dbHandle
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, units_delta, flow_kind
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND occurred_on <= ?
         AND flow_kind IN (${ph})`
    )
    .all(accountId, accountId, accountId, asOfYmd, ...flowKinds) as MovementTransferRow[];
  let total = 0;
  for (const r of rows) {
    total += unitsDeltaForAccountMovement(r, accountId);
  }
  return total;
}

export type TransferCreateInput = {
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
  note: string | null;
  amount_clp: number;
  amount_usd: number | null;
  units_delta: number | null;
  flow_kind: string | null;
  ticker: string | null;
};

export function resolveTransferEndpoints(
  currentAccountId: number,
  counterpartAccountId: number,
  counterpartRole: "to" | "from" | undefined
): { from_account_id: number; to_account_id: number } {
  if (currentAccountId === counterpartAccountId) {
    throw new Error("counterpart_account_id must differ from the current account.");
  }
  const role = counterpartRole ?? "to";
  if (role === "to") {
    return { from_account_id: currentAccountId, to_account_id: counterpartAccountId };
  }
  return { from_account_id: counterpartAccountId, to_account_id: currentAccountId };
}

export function validateTransferCreate(input: TransferCreateInput): void {
  if (input.from_account_id === input.to_account_id) {
    throw new Error("from_account_id and to_account_id must differ.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurred_on)) {
    throw new Error("occurred_on is required (YYYY-MM-DD).");
  }
  const clp = absAmount(input.amount_clp);
  const usd = absAmount(input.amount_usd);
  const units = input.units_delta;
  const hasUnits = units != null && Number.isFinite(units) && units !== 0;
  if (clp === 0 && usd === 0 && !hasUnits) {
    throw new Error("Transfer requires amount_clp, amount_usd, or units_delta.");
  }
}

export function isInternalTransferMovement(row: MovementTransferRow): boolean {
  return isMovementTransferRow(row);
}

export function accountNameForId(accountId: number): string | null {
  const row = db
    .prepare(`SELECT name FROM accounts WHERE id = ?`)
    .get(accountId) as { name: string } | undefined;
  return row?.name ?? null;
}
