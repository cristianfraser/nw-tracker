import { chileCalendarTodayYmd } from "./chileDate.js";
/**
 * Single-row cross-account transfers (`from_account_id` → `to_account_id`, `account_id` NULL).
 */

import type { Database } from "better-sqlite3";
import { accountBucketKindSlug, bucketSlugForAccountId } from "./accountBucket.js";
import { signedAmountClpForBrokerageFlow } from "./brokerageFlowMovement.js";
import { historyTierMemo } from "./aggregationCache.js";
import { db, dbInTransaction } from "./db.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  movementClpLegOrZero,
  movementUsdLeg,
  type MovementCurrency,
} from "./movementAmounts.js";

export type MovementTransferRow = {
  id?: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount: number;
  currency: string;
  counter_amount: number | null;
  counter_currency: string | null;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  /**
   * A transfer between two units accounts (an AFP fund switch): the units bought on the to-leg,
   * when they differ from the units sold (`units_delta`, the from-leg). Null on every other row.
   * Optional because many readers select movements without it; every reader that attributes
   * units to a transfer's to-leg must select it (`transferToLegUnits` reads it first).
   */
  counter_units_delta?: number | null;
  flow_kind: string | null;
};

/**
 * Units credited to a transfer's to-leg: its own count when the row carries one
 * (`counter_units_delta`), else the one count both legs share (`units_delta`). Raw (signed as
 * stored, nullable) — callers apply the sign convention of their path. The one place the
 * to-leg's units are read, so a reader cannot attribute the sold count to the buying account.
 */
export function transferToLegUnits(
  row: Pick<MovementTransferRow, "units_delta" | "counter_units_delta">
): number | null {
  return row.counter_units_delta ?? row.units_delta;
}

/** Units debited from a transfer's from-leg: always `units_delta`. Raw, like `transferToLegUnits`. */
export function transferFromLegUnits(row: Pick<MovementTransferRow, "units_delta">): number | null {
  return row.units_delta;
}

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
  const clpLeg = movementClpLegOrZero(row);
  if (isMovementTransferRow(row)) {
    const mag = absAmount(clpLeg);
    if (row.from_account_id === accountId) return -mag;
    if (row.to_account_id === accountId) return mag;
    return 0;
  }
  if (row.account_id !== accountId) return 0;
  if (row.flow_kind != null) {
    return signedAmountClpForBrokerageFlow(row.flow_kind, clpLeg, movementUsdLeg(row));
  }
  return clpLeg;
}

/** Signed USD cash impact (USD-cash accounts and transfer legs). */
export function signedUsdDeltaForAccountMovement(
  row: MovementTransferRow,
  accountId: number
): number {
  const usdLeg = movementUsdLeg(row);
  if (isMovementTransferRow(row)) {
    const mag = absAmount(usdLeg);
    if (mag === 0) return 0;
    const fk = row.flow_kind;
    const units = row.units_delta;
    const hasUnits = units != null && Number.isFinite(units) && units !== 0;
    if (row.from_account_id === accountId) {
      // stock_sell USD proceeds land on USD cash (to_account), not the equity from leg.
      if (fk === "stock_sell") return 0;
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
    return absAmount(usdLeg);
  }
  if (fk === "withdrawal_usd") return -absAmount(usdLeg);
  // Interest / bank-paid yield credited in USD raises the cash balance (P/L, not capital — the
  // deposited line excludes it, see accountDeposits / cash interest helpers).
  if (fk === "savings_earnings") return absAmount(usdLeg);
  // Commission charged in USD lowers it — the fee twin of interest (P/L cost, not capital).
  if (fk === "cash_fee") return -absAmount(usdLeg);
  return 0;
}

/** Share units credited on `accountId` (legacy account_id, transfer to_account buy, or from_account sell). */
export function unitsDeltaForAccountMovement(
  row: MovementTransferRow,
  accountId: number
): number {
  const valid = (u: number | null | undefined): u is number =>
    u != null && Number.isFinite(u) && u !== 0;
  if (isMovementTransferRow(row)) {
    if (row.flow_kind === "stock_sell") {
      const sold = transferFromLegUnits(row);
      if (row.from_account_id === accountId && valid(sold)) return -Math.abs(sold);
      return 0;
    }
    const bought = transferToLegUnits(row);
    return row.to_account_id === accountId && valid(bought) ? bought : 0;
  }
  const units = row.units_delta;
  return row.account_id === accountId && valid(units) ? units : 0;
}

/** Equity flow kinds whose transfer-leg units are read by the stock/share path, not the cuota path. */
const EQUITY_TRANSFER_FLOW_KINDS = new Set([
  "stock_buy",
  "stock_sell",
  "compra_usd",
  "compra_usd_venta_clp",
]);

/**
 * Σ manual transfer-leg units for a cuota/coin account through `asOfYmd`
 * (account as `to` = +|to-leg units|, as `from` = −|units_delta|). Excludes equity flow-kind
 * legs, which the brokerage share path already counts. Fintual / crypto / AFP readers add this
 * on top of their `account_id`-ledger sums so a `checking → fund` transfer moves the fund
 * balance too. A fund switch (`afp_fund_switch`) carries both counts: the sending fund loses
 * the cuotas it sold, the receiving fund gains the cuotas it bought (`counter_units_delta`).
 */
export function transferLegUnitsThroughDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const total = ledgerTotalThrough("transfer_leg_units", accountId, asOfYmd, dbHandle, false, (handle) =>
    (
      handle
        .prepare(
          `SELECT id, occurred_on, from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
           FROM movements
           WHERE account_id IS NULL
             AND units_delta IS NOT NULL
             AND (from_account_id = ? OR to_account_id = ?)`
        )
        .all(accountId, accountId) as MovementTransferRow[]
    ).map((r) => ({ id: r.id!, occurred_on: r.occurred_on, delta: transferLegUnitsDelta(r, accountId) }))
  );
  return Number.isFinite(total) ? total : 0;
}

function ledgerDeltaKey(r: MovementTransferRow) {
  return { id: r.id!, occurred_on: r.occurred_on, account_id: r.account_id, from_account_id: r.from_account_id };
}

function transferLegUnitsDelta(r: MovementTransferRow, accountId: number): number {
  if (r.flow_kind != null && EQUITY_TRANSFER_FLOW_KINDS.has(r.flow_kind)) return 0;
  if (r.to_account_id === accountId) return absAmount(transferToLegUnits(r));
  if (r.from_account_id === accountId) return -absAmount(transferFromLegUnits(r));
  return 0;
}

type LedgerDelta = { id: number; occurred_on: string; delta: number; account_id?: number | null; from_account_id?: number | null };

/** One index branch of the per-call SQL: its rows in (day, id) order and their running sums. */
type LedgerRun = { dates: string[]; deltas: number[]; prefix: number[] };

/**
 * One account's movement deltas, in the order the per-call SQL scan returned them, so a sum adds
 * in the same order and gives the same float: SQLite answered `account_id = ? OR from_account_id
 * = ? OR to_account_id = ?` index branch by index branch (`idx_movements_{account,from,to}_occurred`),
 * each in (day, id) order — a row once, in the first branch it matches.
 */
type LedgerPrefix = LedgerRun[];

function buildLedgerRun(rows: LedgerDelta[]): LedgerRun {
  rows.sort((a, b) => (a.occurred_on < b.occurred_on ? -1 : a.occurred_on > b.occurred_on ? 1 : a.id - b.id));
  const prefix = [0];
  for (const r of rows) prefix.push(prefix[prefix.length - 1]! + r.delta);
  return { dates: rows.map((r) => r.occurred_on), deltas: rows.map((r) => r.delta), prefix };
}

function buildLedgerPrefix(deltas: LedgerDelta[], accountId: number, byBranch: boolean): LedgerPrefix {
  if (!byBranch) return [buildLedgerRun(deltas)];
  const branches: LedgerDelta[][] = [[], [], []];
  for (const r of deltas) {
    branches[r.account_id === accountId ? 0 : r.from_account_id === accountId ? 1 : 2]!.push(r);
  }
  return branches.map(buildLedgerRun);
}

/**
 * Σ of an account's per-movement deltas dated on or before `asOfYmd`. The account's deltas sit
 * in the history tier: movements and the account metadata a delta reads are mark-input tables,
 * so any write to them (any connection) drops the tier before the next read, and a live-quote
 * tick moves nothing they read. Inside a transaction (or against another handle) the rows are
 * read directly — the write may be rolled back.
 *
 * Every caller's dates are `YYYY-MM-DD` (so are all stored `occurred_on`), so the string
 * comparison is `date(occurred_on) <= date(?)`.
 */
function ledgerTotalThrough(
  name: string,
  accountId: number,
  asOfYmd: string,
  dbHandle: Database,
  byBranch: boolean,
  loadDeltas: (handle: Database) => LedgerDelta[]
): number {
  let ledger: LedgerPrefix;
  if (dbHandle !== db || dbInTransaction()) {
    ledger = buildLedgerPrefix(loadDeltas(dbHandle), accountId, byBranch);
  } else {
    const memo = historyTierMemo<number, LedgerPrefix>(`movement_ledger_prefix.${name}`);
    const cached = memo.get(accountId);
    if (cached) ledger = cached;
    else {
      ledger = buildLedgerPrefix(loadDeltas(db), accountId, byBranch);
      memo.set(accountId, ledger);
    }
  }
  let total = 0;
  for (const run of ledger) {
    // k = rows of this branch dated on or before asOfYmd.
    let lo = 0;
    let hi = run.dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (run.dates[mid]! <= asOfYmd) lo = mid + 1;
      else hi = mid;
    }
    // Adding to an exact 0 gives the branch's own running sum; otherwise add row by row.
    if (total === 0) total = run.prefix[lo]!;
    else for (let i = 0; i < lo; i++) total += run.deltas[i]!;
  }
  return total;
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
  SELECT id, account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL},
         occurred_on, note, units_delta, counter_units_delta, flow_kind
  FROM movements
  WHERE account_id = ?
     OR from_account_id = ?
     OR to_account_id = ?
  ORDER BY occurred_on DESC, id DESC`;

export function listMovementRowsForAccount(accountId: number): MovementTransferRow[] {
  return db.prepare(MOVEMENTS_FOR_ACCOUNT_SQL).all(accountId, accountId, accountId) as MovementTransferRow[];
}

export function sumClpThroughDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  return Math.round(
    ledgerTotalThrough("clp", accountId, asOfYmd, dbHandle, true, (handle) =>
      (
        handle
          .prepare(
            `SELECT id, occurred_on, account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, flow_kind
             FROM movements
             WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
          )
          .all(accountId, accountId, accountId) as MovementTransferRow[]
      ).map((r) => ({ ...ledgerDeltaKey(r), delta: signedClpDeltaForAccountMovement(r, accountId) }))
    )
  );
}

export function sumUsdThroughDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  return ledgerTotalThrough("usd", accountId, asOfYmd, dbHandle, true, (handle) =>
    (
      handle
        .prepare(
          `SELECT id, occurred_on, account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, units_delta, flow_kind, note
           FROM movements
           WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
        )
        .all(accountId, accountId, accountId) as MovementTransferRow[]
    ).map((r) => ({ ...ledgerDeltaKey(r), delta: signedUsdDeltaForAccountMovement(r, accountId) }))
  );
}

/** Sentinel upper bound: every known row, whatever its bank date. */
const DISPLAY_LEDGER_NO_CUTOFF = "9999-12-31";

/**
 * Upper bound for a DISPLAY read of a ledger at `asOfYmd`.
 *
 * A bank posts an after-cutoff wire on the next workday, and its feed lists the row under
 * that date before the day arrives (Santander's bank day ends at 14:00 — a Friday-afternoon
 * transfer is dated Monday), so the ledger can hold rows dated after Chile today. History
 * keeps those bank dates — a past day is exactly what the bank said it was — but "now" has
 * no upper bound: a movement we already know about counts today, and it keeps counting when
 * the calendar reaches its bank date, so a value never steps twice. The deposit-event
 * timeline applies the same rule (`buildMergedDepositMap`), which is what keeps every
 * flow-adjusted P/L at 0 for such a row on every day it is shown.
 *
 * Reconciliation readers must NOT use this: a cartola anchor or a month-end check compares
 * against a bank document that is strictly as-of its own period end (`sumClpThroughDate`).
 */
export function displayLedgerCutoffYmd(asOfYmd: string): string {
  return asOfYmd < chileCalendarTodayYmd() ? asOfYmd : DISPLAY_LEDGER_NO_CUTOFF;
}

/** `sumClpThroughDate` for display: strict before today, every known row from today on. */
export function sumClpThroughDisplayDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  return sumClpThroughDate(accountId, displayLedgerCutoffYmd(asOfYmd), dbHandle);
}

/** `sumUsdThroughDate` for display: strict before today, every known row from today on. */
export function sumUsdThroughDisplayDate(accountId: number, asOfYmd: string, dbHandle: Database = db): number {
  return sumUsdThroughDate(accountId, displayLedgerCutoffYmd(asOfYmd), dbHandle);
}

export function sumUnitsThroughDate(
  accountId: number,
  asOfYmd: string,
  flowKinds: readonly string[],
  dbHandle: Database = db
): number {
  if (flowKinds.length === 0) return 0;
  const ph = flowKinds.map(() => "?").join(", ");
  return ledgerTotalThrough(`units.${flowKinds.join(",")}`, accountId, asOfYmd, dbHandle, true, (handle) =>
    (
      handle
        .prepare(
          `SELECT id, occurred_on, account_id, from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
           FROM movements
           WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
             AND flow_kind IN (${ph})`
        )
        .all(accountId, accountId, accountId, ...flowKinds) as MovementTransferRow[]
    ).map((r) => ({ ...ledgerDeltaKey(r), delta: unitsDeltaForAccountMovement(r, accountId) }))
  );
}

export type TransferCreateInput = {
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
  note: string | null;
  amount: number;
  currency: MovementCurrency;
  counter_amount: number | null;
  counter_currency: MovementCurrency | null;
  units_delta: number | null;
  /** The to-leg's own unit count (a fund switch); needs `units_delta`, see `validateTransferCreate`. */
  counter_units_delta: number | null;
  flow_kind: string | null;
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
  const amount = absAmount(input.amount);
  const units = input.units_delta;
  const hasUnits = units != null && Number.isFinite(units) && units !== 0;
  if (amount === 0 && !hasUnits) {
    throw new Error("Transfer requires an amount or units_delta.");
  }
  const counterUnits = input.counter_units_delta;
  if (counterUnits != null) {
    if (!Number.isFinite(counterUnits) || counterUnits === 0) {
      throw new Error("counter_units_delta must be a non-zero number (the units bought on the to-leg).");
    }
    if (!hasUnits) {
      throw new Error("counter_units_delta requires units_delta (the units sold on the from-leg).");
    }
  }
  if ((input.counter_amount == null) !== (input.counter_currency == null)) {
    throw new Error("counter_amount and counter_currency must be set together.");
  }
  if (input.counter_currency != null && input.counter_currency === input.currency) {
    throw new Error("counter_currency must differ from currency.");
  }
}

export function accountNameForId(accountId: number): string | null {
  const row = db
    .prepare(`SELECT name FROM accounts WHERE id = ?`)
    .get(accountId) as { name: string } | undefined;
  return row?.name ?? null;
}
