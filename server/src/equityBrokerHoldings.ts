/**
 * A stock account holds one ticker across every broker (one account per ticker): a Racional
 * buy and a Fintual buy of the same symbol both land on it. The broker is only on the cash
 * leg of each trade, so the per-broker split is the stock's share units grouped by the cash
 * account on the other side — the `from` of a buy, the `to` of a sale. A single-leg units row
 * (no cash leg) is its own group with no account, except a split (`stock_split`), which
 * multiplies every group's shares by its ratio.
 *
 * Same rows and per-row units as `brokerageShareUnitsThroughDate`, so the groups add up to
 * the position; a difference throws.
 */

import { BROKERAGE_SHARE_UNITS_FLOW_KINDS, brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { db } from "./db.js";
import {
  isMovementTransferRow,
  unitsDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";

export type EquityBrokerHolding = {
  /** Cash account on the other side of the trades; null for single-leg units rows. */
  cash_account_id: number | null;
  cash_account_name: string | null;
  units: number;
  /** units ÷ the position's units. */
  share: number;
  /** The position's value × share, in the unit the position's value was given in; null when it has none. */
  value: number | null;
};

const UNITS_EPS = 1e-9;

const shareKindsPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

const stmtShareRows = db.prepare(
  `SELECT id, occurred_on, account_id, from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
   FROM movements
   WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
     AND occurred_on <= ?
     AND flow_kind IN (${shareKindsPh})`
);

const stmtAccountName = db.prepare(`SELECT name FROM accounts WHERE id = ?`);

function cashCounterpartId(row: MovementTransferRow, accountId: number): number | null {
  if (!isMovementTransferRow(row)) return null;
  const other = row.from_account_id === accountId ? row.to_account_id : row.from_account_id;
  if (other == null || other === accountId) {
    throw new Error(`equityBrokerHoldings: transfer on account ${accountId} has no other endpoint`);
  }
  return other;
}

/**
 * Units held through `asOfYmd`, by cash account; groups at zero (sold out at that broker)
 * are left out. Sorted by units, largest first.
 */
export function equityBrokerHoldings(
  accountId: number,
  asOfYmd: string,
  /** The position's value in the caller's display unit (each group gets its share of it). */
  positionValue: number | null
): EquityBrokerHolding[] {
  const rows = stmtShareRows.all(
    accountId,
    accountId,
    accountId,
    asOfYmd,
    ...BROKERAGE_SHARE_UNITS_FLOW_KINDS
  ) as (MovementTransferRow & { id: number; occurred_on: string })[];
  // A split scales what each broker held before it, so the rows are replayed in date order.
  rows.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id - b.id);

  const unitsByCash = new Map<number | null, number>();
  for (const r of rows) {
    const units = unitsDeltaForAccountMovement(r, accountId);
    if (units === 0) continue;
    if (r.flow_kind === "stock_split") {
      const held = [...unitsByCash.values()].reduce((a, b) => a + b, 0);
      if (!(held > UNITS_EPS)) throw new Error(`equityBrokerHoldings: split ${r.id} on account ${accountId} with no shares held`);
      const ratio = (held + units) / held;
      for (const [k, v] of unitsByCash) unitsByCash.set(k, v * ratio);
      continue;
    }
    const key = cashCounterpartId(r, accountId);
    unitsByCash.set(key, (unitsByCash.get(key) ?? 0) + units);
  }

  const total = [...unitsByCash.values()].reduce((a, b) => a + b, 0);
  const position = brokerageShareUnitsThroughDate(accountId, asOfYmd);
  if (Math.abs(total - position) > UNITS_EPS) {
    throw new Error(
      `equityBrokerHoldings: account ${accountId} groups add up to ${total} units, position is ${position}`
    );
  }
  if (total <= UNITS_EPS) return [];

  const out: EquityBrokerHolding[] = [];
  for (const [cashId, units] of unitsByCash) {
    if (Math.abs(units) <= UNITS_EPS) continue;
    const name =
      cashId == null
        ? null
        : ((stmtAccountName.get(cashId) as { name: string } | undefined)?.name ?? null);
    if (cashId != null && name == null) {
      throw new Error(`equityBrokerHoldings: cash account ${cashId} not found`);
    }
    const share = units / total;
    out.push({
      cash_account_id: cashId,
      cash_account_name: name,
      units,
      share,
      value: positionValue != null && Number.isFinite(positionValue) ? positionValue * share : null,
    });
  }
  out.sort((a, b) => b.units - a.units);
  return out;
}
