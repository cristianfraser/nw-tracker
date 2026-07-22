/**
 * Converts a confirmed mirror pair (movementMirrorPairs.ts) into one transfer row and back.
 *
 * The transfer takes the outflow leg's date (causal order: source before destination) — except
 * when the outflow leg is month-precision (cuenta de ahorro: conventional month-end dates); then
 * it takes the inflow (real-day cartola) leg's date so the checking timeline and its re-import
 * dedupe stay intact. It carries the cuota leg's `units_delta` when one leg moves cuotas (cuota
 * readers add transferLegUnitsThroughDate on top of the account_id ledger, so balances stay exact).
 * Both legs are deleted; their exact content (ids, dates, amounts, units, notes) is preserved in
 * `movement_mirror_merges` (keyed by the transfer movement, ON DELETE CASCADE) so the conversion
 * is fully undoable. The transfer's note is a human summary only.
 *
 * Caveats (also surfaced in the panel copy):
 * - Ambiguous-tier pairs outside the business-day window: re-importing that cartola month can
 *   re-insert the bank leg (import dedupe window is 1 business day).
 */
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import { listMirrorPairCandidates, mirrorLegIsMonthPrecision } from "./movementMirrorPairs.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";

export type MirrorMergeLegSnapshot = {
  movement_id: number;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

function mirrorMergeHumanNote(outYmd: string, inYmd: string): string {
  return `Traspaso espejo (retiro ${outYmd} → depósito ${inYmd})`;
}

export type MirrorPairRef = { out_movement_id: number; in_movement_id: number };

export class MirrorConvertStaleError extends Error {
  pair: MirrorPairRef;
  constructor(pair: MirrorPairRef, reason: string) {
    super(`mirror pair ${pair.out_movement_id}→${pair.in_movement_id}: ${reason}`);
    this.pair = pair;
  }
}

export type ConvertedMirrorPair = {
  transfer_movement_id: number;
  out_movement_id: number;
  in_movement_id: number;
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
  /** Earliest date touched by the conversion (cache invalidation covers forward from here). */
  earliest_affected_on: string;
};

type LegRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

/**
 * Converts pairs in one all-or-nothing transaction. Every requested pair must be a *current*,
 * non-blocked candidate — a stale UI, a double submit, or a leg consumed by another conversion
 * throws MirrorConvertStaleError and nothing is written.
 */
export function convertMirrorPairs(pairs: MirrorPairRef[]): { converted: ConvertedMirrorPair[] } {
  if (pairs.length === 0) return { converted: [] };
  const legStmt = db.prepare(
    `SELECT id, account_id, occurred_on, amount_clp, units_delta, note
     FROM movements WHERE id = ? AND account_id IS NOT NULL`
  );
  const insTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)`
  );
  const delLeg = db.prepare(`DELETE FROM movements WHERE id = ?`);
  const insMirrorMerge = db.prepare(
    `INSERT INTO movement_mirror_merges (
       transfer_movement_id,
       out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_occurred_on, in_amount_clp, in_units_delta, in_note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Income include/exclude overrides describe the single-leg row as an income candidate; once
  // converted to a transfer the row is internal by construction and the override is moot.
  // (No ON DELETE CASCADE on this FK, so it must go explicitly before the leg.)
  const delIncomeOverride = db.prepare(
    `DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`
  );

  const run = db.transaction((requested: MirrorPairRef[]): ConvertedMirrorPair[] => {
    const candidates = new Map(
      listMirrorPairCandidates().map((c) => [`${c.out.movement_id}|${c.in.movement_id}`, c])
    );
    const converted: ConvertedMirrorPair[] = [];
    for (const ref of requested) {
      const cand = candidates.get(`${ref.out_movement_id}|${ref.in_movement_id}`);
      if (!cand) throw new MirrorConvertStaleError(ref, "not a current candidate");
      if (cand.blocked) throw new MirrorConvertStaleError(ref, `blocked: ${cand.blocked_reason}`);
      const out = legStmt.get(ref.out_movement_id) as LegRow | undefined;
      const inn = legStmt.get(ref.in_movement_id) as LegRow | undefined;
      if (!out || !inn) throw new MirrorConvertStaleError(ref, "leg no longer exists");

      const note = mirrorMergeHumanNote(out.occurred_on, inn.occurred_on);
      const unitsSource = out.units_delta ?? inn.units_delta;
      const transferUnits =
        unitsSource != null && Number.isFinite(unitsSource) && unitsSource !== 0
          ? Math.abs(unitsSource)
          : null;
      // Month-precision out leg (ahorro retiro dated a conventional month-end): the inflow is
      // the real-day leg — using it keeps the checking timeline/cartola dedupe intact.
      const outMonthPrecision = mirrorLegIsMonthPrecision(accountKindSlugForAccountId(out.account_id));
      const inMonthPrecision = mirrorLegIsMonthPrecision(accountKindSlugForAccountId(inn.account_id));
      const transferDate =
        outMonthPrecision && !inMonthPrecision ? inn.occurred_on : out.occurred_on;
      const r = insTransfer.run(
        out.account_id,
        inn.account_id,
        Math.round(Math.abs(out.amount_clp)),
        transferDate,
        note,
        transferUnits
      );
      insMirrorMerge.run(
        Number(r.lastInsertRowid),
        out.id,
        out.occurred_on,
        out.amount_clp,
        out.units_delta,
        out.note,
        inn.id,
        inn.occurred_on,
        inn.amount_clp,
        inn.units_delta,
        inn.note
      );
      delIncomeOverride.run(out.id);
      delIncomeOverride.run(inn.id);
      delLeg.run(out.id);
      delLeg.run(inn.id);
      converted.push({
        transfer_movement_id: Number(r.lastInsertRowid),
        out_movement_id: out.id,
        in_movement_id: inn.id,
        from_account_id: out.account_id,
        to_account_id: inn.account_id,
        occurred_on: transferDate,
        earliest_affected_on:
          out.occurred_on < inn.occurred_on ? out.occurred_on : inn.occurred_on,
      });
    }
    return converted;
  });

  const converted = run(pairs);
  for (const c of converted) {
    // Invalidation clears forward months from the earliest touched date, covering both legs'
    // original months and the transfer date.
    clearCheckingBalanceCache(c.from_account_id);
    clearCheckingBalanceCache(c.to_account_id);
    invalidateAggregationForAccountDate(c.from_account_id, c.earliest_affected_on);
    invalidateAggregationForAccountDate(c.to_account_id, c.earliest_affected_on);
  }
  return { converted };
}

/**
 * Deletes a mirror-merge transfer and re-inserts the two original single-leg rows exactly as
 * they were (dates, amounts, units, notes — new ids). Rejections/links that referenced the old
 * ids already cascaded at conversion time and do not come back.
 */
export function undoMirrorConversion(transferMovementId: number): {
  restored_out_id: number;
  restored_in_id: number;
} {
  const row = db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id
       FROM movements WHERE id = ?`
    )
    .get(transferMovementId) as
    | { id: number; account_id: number | null; from_account_id: number | null; to_account_id: number | null }
    | undefined;
  if (!row) throw new Error(`movement ${transferMovementId} not found`);
  if (row.account_id != null || row.from_account_id == null || row.to_account_id == null) {
    throw new Error(`movement ${transferMovementId} is not a transfer row`);
  }
  const merge = db
    .prepare(`SELECT * FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
    .get(transferMovementId) as
    | {
        out_movement_id: number;
        out_occurred_on: string;
        out_amount_clp: number;
        out_units_delta: number | null;
        out_note: string | null;
        in_movement_id: number | null;
        in_occurred_on: string;
        in_amount_clp: number;
        in_units_delta: number | null;
        in_note: string | null;
      }
    | undefined;
  if (!merge) {
    throw new Error(`movement ${transferMovementId} is not a mirror-merge conversion`);
  }
  // CC-payment mirrors (ccPaymentMirrors.ts): the "in" side is statement evidence that was
  // never deleted — undo restores only the checking leg.
  if (merge.in_movement_id == null) {
    const insOut = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, units_delta, note) VALUES (?,?,?,?,?)`
    );
    const restored = db.transaction(() => {
      const outId = Number(
        insOut.run(
          row.from_account_id,
          merge.out_amount_clp,
          merge.out_occurred_on,
          merge.out_units_delta,
          merge.out_note
        ).lastInsertRowid
      );
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferMovementId);
      return { restored_out_id: outId, restored_in_id: outId };
    })();
    clearCheckingBalanceCache(row.from_account_id!);
    invalidateAggregationForAccountDate(row.from_account_id!, merge.out_occurred_on);
    invalidateAggregationForAccountDate(row.to_account_id!, merge.out_occurred_on);
    return restored;
  }
  const data = {
    out: {
      movement_id: merge.out_movement_id,
      occurred_on: merge.out_occurred_on,
      amount_clp: merge.out_amount_clp,
      units_delta: merge.out_units_delta,
      note: merge.out_note,
    },
    in: {
      movement_id: merge.in_movement_id,
      occurred_on: merge.in_occurred_on,
      amount_clp: merge.in_amount_clp,
      units_delta: merge.in_units_delta,
      note: merge.in_note,
    },
  };
  const fromId = row.from_account_id;
  const toId = row.to_account_id;

  const insLeg = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, units_delta, note) VALUES (?,?,?,?,?)`
  );
  const run = db.transaction(() => {
    const outId = Number(
      insLeg.run(fromId, data.out.amount_clp, data.out.occurred_on, data.out.units_delta, data.out.note)
        .lastInsertRowid
    );
    const inId = Number(
      insLeg.run(toId, data.in.amount_clp, data.in.occurred_on, data.in.units_delta, data.in.note)
        .lastInsertRowid
    );
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferMovementId);
    return { restored_out_id: outId, restored_in_id: inId };
  });
  const restored = run();
  const earliest =
    data.out.occurred_on < data.in.occurred_on ? data.out.occurred_on : data.in.occurred_on;
  clearCheckingBalanceCache(fromId);
  clearCheckingBalanceCache(toId);
  invalidateAggregationForAccountDate(fromId, earliest);
  invalidateAggregationForAccountDate(toId, earliest);
  return restored;
}

/** Persists rejections; both ids must be existing single-leg rows (fail fast on anything else). */
export function rejectMirrorPairs(pairs: MirrorPairRef[]): { rejected: number } {
  const legExists = db.prepare(
    `SELECT 1 AS ok FROM movements WHERE id = ? AND account_id IS NOT NULL`
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO movement_mirror_pair_rejections (out_movement_id, in_movement_id) VALUES (?, ?)`
  );
  let rejected = 0;
  const run = db.transaction(() => {
    for (const p of pairs) {
      if (!legExists.get(p.out_movement_id) || !legExists.get(p.in_movement_id)) {
        throw new Error(
          `mirror pair ${p.out_movement_id}→${p.in_movement_id}: both legs must be existing single-leg movements`
        );
      }
      rejected += Number(ins.run(p.out_movement_id, p.in_movement_id).changes);
    }
  });
  run();
  return { rejected };
}

export function unrejectMirrorPairs(pairs: MirrorPairRef[]): { removed: number } {
  const del = db.prepare(
    `DELETE FROM movement_mirror_pair_rejections WHERE out_movement_id = ? AND in_movement_id = ?`
  );
  let removed = 0;
  for (const p of pairs) {
    removed += Number(del.run(p.out_movement_id, p.in_movement_id).changes);
  }
  return { removed };
}
