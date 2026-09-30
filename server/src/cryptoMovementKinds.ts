/**
 * The kind of each crypto coin movement (`crypto_movement_kinds`, migration 195) and the
 * structural rule that deduces it from the ledger alone, never from a note:
 *
 * - a `cash_fee` row that removes coin is a `send_fee`; a `savings_earnings` row that adds coin is
 *   a `round_trip_return` (the two P/L flow kinds the Buda rebuild writes for unit-only rows);
 * - a row paired with the opposite row of the same pesos on the same day in the Buda CLP buffer
 *   is a trade: coin in = `buy` (the buffer paid), coin out = `sell` (the buffer received);
 * - an unpaired coin-out and coin-in of the same pesos on the same day on two different coins are
 *   a `swap_out` / `swap_in`;
 * - any other coin-out is a `coin_out`; any other coin-in throws (nothing explains it).
 *
 * Pairing takes each counterpart once, in id order, so twin rows pair one to one.
 */
import { db } from "./db.js";

export const CRYPTO_MOVEMENT_KINDS = [
  "buy",
  "sell",
  "swap_out",
  "swap_in",
  "coin_out",
  "send_fee",
  "round_trip_return",
] as const;
export type CryptoMovementKind = (typeof CRYPTO_MOVEMENT_KINDS)[number];

export type CryptoCoinRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount: number;
  units_delta: number;
  flow_kind: string | null;
};
export type CryptoBufferRow = { id: number; occurred_on: string; amount: number };

/** Kinds for every coin row, keyed by movement id; throws on a row the rule cannot explain. */
export function deduceCryptoMovementKinds(
  coinRows: readonly CryptoCoinRow[],
  bufferRows: readonly CryptoBufferRow[]
): Map<number, CryptoMovementKind> {
  const kinds = new Map<number, CryptoMovementKind>();
  const byId = [...coinRows].sort((a, b) => a.id - b.id);
  const freeBuffer = [...bufferRows].sort((a, b) => a.id - b.id);
  const unpaired: CryptoCoinRow[] = [];
  for (const r of byId) {
    if (!(r.units_delta !== 0 && Number.isFinite(r.units_delta))) {
      throw new Error(`Crypto kinds: movement ${r.id} moves ${r.units_delta} units`);
    }
    const coinIn = r.units_delta > 0;
    if (r.flow_kind === "cash_fee") {
      if (coinIn) throw new Error(`Crypto kinds: fee movement ${r.id} adds coin`);
      kinds.set(r.id, "send_fee");
      continue;
    }
    if (r.flow_kind === "savings_earnings") {
      if (!coinIn) throw new Error(`Crypto kinds: movement ${r.id} (savings_earnings) removes coin`);
      kinds.set(r.id, "round_trip_return");
      continue;
    }
    if (r.flow_kind != null) throw new Error(`Crypto kinds: movement ${r.id} has flow kind ${r.flow_kind}`);
    if (coinIn !== r.amount > 0) {
      throw new Error(`Crypto kinds: movement ${r.id} moves ${r.units_delta} units for ${r.amount} pesos`);
    }
    const i = freeBuffer.findIndex((b) => b.occurred_on === r.occurred_on && b.amount === -r.amount);
    if (i >= 0) {
      freeBuffer.splice(i, 1);
      kinds.set(r.id, coinIn ? "buy" : "sell");
    } else {
      unpaired.push(r);
    }
  }
  const outs = unpaired.filter((r) => r.units_delta < 0);
  for (const r of unpaired) {
    if (r.units_delta < 0) continue;
    const j = outs.findIndex(
      (o) => o.occurred_on === r.occurred_on && o.account_id !== r.account_id && o.amount === -r.amount
    );
    if (j < 0) {
      throw new Error(
        `Crypto kinds: movement ${r.id} adds ${r.units_delta} coin on ${r.occurred_on} with no buffer payment and no swap`
      );
    }
    kinds.set(outs[j]!.id, "swap_out");
    kinds.set(r.id, "swap_in");
    outs.splice(j, 1);
  }
  for (const o of outs) kinds.set(o.id, "coin_out");
  return kinds;
}

/** Stored kinds for the given movements; throws when one has none (run the backfill). */
export function loadCryptoMovementKinds(movementIds: readonly number[]): Map<number, CryptoMovementKind> {
  const out = new Map<number, CryptoMovementKind>();
  const get = db.prepare(`SELECT kind FROM crypto_movement_kinds WHERE movement_id = ?`);
  for (const id of movementIds) {
    const r = get.get(id) as { kind: CryptoMovementKind } | undefined;
    if (!r) throw new Error(`Crypto kinds: movement ${id} has no kind — run scripts/backfill-crypto-movement-kinds.ts`);
    out.set(id, r.kind);
  }
  return out;
}

const insertKind = db.prepare(
  `INSERT INTO crypto_movement_kinds (movement_id, kind) VALUES (?, ?)
   ON CONFLICT(movement_id) DO UPDATE SET kind = excluded.kind`
);

/** Writes kinds (callers run it inside their own transaction when it must be atomic with the rows). */
export function writeCryptoMovementKinds(kinds: ReadonlyMap<number, CryptoMovementKind>): void {
  for (const [id, kind] of kinds) insertKind.run(id, kind);
}
