/**
 * Which movements of the Buda CLP buffer cross the checking boundary, read from the ledger's
 * structure — never from a note. A buffer row is a trade when it pays for or receives a coin
 * trade: a coin row of kind `buy` / `sell` (`crypto_movement_kinds`, migration 195) on the same
 * day with the opposite pesos, each coin row taking one buffer row, in id order (the pairing
 * `deduceCryptoMovementKinds` used to give the coin rows their kinds). Every other single-leg peso
 * row with no flow kind is money that came from (a deposit) or went to (a withdrawal) outside the
 * crypto bucket — whoever wrote it, a hand-entered one included. Rows carrying a flow kind (a fee,
 * interest) are neither.
 */
import { db } from "./db.js";

export type BudaBufferCrossings = { deposits: ReadonlySet<number>; withdrawals: ReadonlySet<number> };

type BufferRow = { id: number; occurred_on: string; amount: number; flow_kind: string | null };
type CoinTradeRow = { id: number; occurred_on: string; amount: number; kind: "buy" | "sell" };

/** The buffer's deposits (money in from outside) and withdrawals (money out), by movement id. */
export function budaBufferCrossings(bufferAccountId: number, coinAccountIds: ReadonlySet<number>): BudaBufferCrossings {
  const bufferRows = db
    .prepare(
      `SELECT id, occurred_on, amount, flow_kind FROM movements
       WHERE account_id = ? AND currency = 'clp' AND counter_currency IS NULL ORDER BY id` // convention-ok: the Buda wallet holds pesos only
    )
    .all(bufferAccountId) as BufferRow[];
  const coins = [...coinAccountIds];
  const coinTrades =
    coins.length === 0
      ? []
      : (db
          .prepare(
            `SELECT m.id, m.occurred_on, m.amount, k.kind FROM movements m
             JOIN crypto_movement_kinds k ON k.movement_id = m.id
             WHERE m.account_id IN (${coins.map(() => "?").join(",")}) AND k.kind IN ('buy', 'sell')
             ORDER BY m.id`
          )
          .all(...coins) as CoinTradeRow[]);
  const free = [...bufferRows];
  for (const t of coinTrades) {
    // A buy adds coin for pesos the buffer paid (its row is −amount); a sell the reverse.
    const i = free.findIndex((b) => b.occurred_on === t.occurred_on && b.amount === -t.amount);
    if (i < 0) {
      throw new Error(
        `Buda buffer: coin ${t.kind} movement ${t.id} (${t.occurred_on}, ${t.amount}) has no opposite buffer row that day`
      );
    }
    free.splice(i, 1);
  }
  const deposits = new Set<number>();
  const withdrawals = new Set<number>();
  for (const b of free) {
    if (b.flow_kind != null) continue;
    if (b.amount > 0) deposits.add(b.id);
    else if (b.amount < 0) withdrawals.add(b.id);
  }
  return { deposits, withdrawals };
}
