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
 * A pair in another currency than pesos (two `withdrawal` / `deposit` rows on cash ledgers held in
 * it) becomes a transfer in that currency; the merge row's `out_amount_clp` / `in_amount_clp` then
 * hold the legs signed in the transfer's currency (the columns predate other currencies — the
 * transfer row names it), and undo writes them back as `withdrawal` / `deposit` rows.
 *
 * Each deleted leg's date is kept as the transfer's bank posting on that leg's account
 * (`movement_bank_postings`): the cartola files the money under that day, so re-importing the
 * month finds the transfer by it, and the cartola month-end check reads it.
 */
import { bankPostedOn, recordBankPosting } from "./movementBankPostings.js";


import { db } from "./db.js";
import { listMirrorPairCandidates, mirrorLegIsMonthPrecision, resolveMirrorPairRef } from "./movementMirrorPairs.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { type MovementAmountFields } from "./movementAmounts.js";
import { HOME_CURRENCY, roundToCurrency } from "./displayUnits.js";

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

type LegRow = MovementAmountFields & {
  id: number;
  account_id: number;
  occurred_on: string;
  units_delta: number | null;
  note: string | null;
  flow_kind: string | null;
};

/**
 * A mirror leg's amount signed by its direction, in its own currency: a peso leg carries the sign
 * itself (no flow_kind), a foreign one states it positive under `withdrawal` / `deposit`.
 */
function signedMirrorLegAmount(leg: LegRow, side: "out" | "in"): number {
  if (leg.counter_currency != null) throw new Error(`mirror ${side} leg ${leg.id} is a conversion, not a single-leg row`);
  if (leg.currency === HOME_CURRENCY) {
    if (leg.flow_kind != null) throw new Error(`mirror ${side} leg ${leg.id} carries flow_kind ${leg.flow_kind}`);
    return leg.amount;
  }
  const expected = side === "out" ? "withdrawal" : "deposit";
  if (leg.flow_kind !== expected) throw new Error(`mirror ${side} leg ${leg.id} (${leg.currency}) is ${leg.flow_kind}, not ${expected}`);
  return side === "out" ? -Math.abs(leg.amount) : Math.abs(leg.amount);
}

/**
 * Converts pairs in one all-or-nothing transaction. Every requested pair must be a *current*
 * candidate, or an alternative an ambiguous candidate offers in place of its greedy pick
 * (`resolveMirrorPairRef`) — a stale UI, a double submit, or a leg consumed by another conversion
 * throws MirrorConvertStaleError and nothing is written.
 */
export function convertMirrorPairs(pairs: MirrorPairRef[]): { converted: ConvertedMirrorPair[] } {
  if (pairs.length === 0) return { converted: [] };
  const legStmt = db.prepare(
    `SELECT id, account_id, occurred_on, amount, currency, counter_amount, counter_currency, units_delta, note, flow_kind
     FROM movements WHERE id = ? AND account_id IS NOT NULL`
  );
  const insTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`
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
    `DELETE FROM flow_income_overrides WHERE flow_id = (SELECT flow_id FROM movements WHERE id = ?)`
  );

  const run = db.transaction((requested: MirrorPairRef[]): ConvertedMirrorPair[] => {
    const candidates = listMirrorPairCandidates();
    const converted: ConvertedMirrorPair[] = [];
    for (const ref of requested) {
      const cand = resolveMirrorPairRef(candidates, ref);
      if (!cand) throw new MirrorConvertStaleError(ref, "not a current candidate or alternative");
      const out = legStmt.get(ref.out_movement_id) as LegRow | undefined;
      const inn = legStmt.get(ref.in_movement_id) as LegRow | undefined;
      if (!out || !inn) throw new MirrorConvertStaleError(ref, "leg no longer exists");
      // Both legs are in one currency by construction — throw, don't guess.
      const outAmount = signedMirrorLegAmount(out, "out");
      const innAmount = signedMirrorLegAmount(inn, "in");
      if (out.currency !== inn.currency) throw new MirrorConvertStaleError(ref, `legs in ${out.currency} and ${inn.currency}`);
      const currency = out.currency;

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
        roundToCurrency(Math.abs(outAmount), currency),
        currency,
        transferDate,
        note,
        transferUnits
      );
      insMirrorMerge.run(
        Number(r.lastInsertRowid),
        out.id,
        out.occurred_on,
        outAmount,
        out.units_delta,
        out.note,
        inn.id,
        inn.occurred_on,
        innAmount,
        inn.units_delta,
        inn.note
      );
      // Each deleted leg was its account's own listing of the money: its bank day (its own
      // posting row, else its date — a post-cutoff daily row is stored on an earlier day) stays
      // as the transfer's posting day there (a bank cartola files it under that day).
      recordBankPosting(Number(r.lastInsertRowid), out.account_id, bankPostedOn(out.id, out.account_id));
      recordBankPosting(Number(r.lastInsertRowid), inn.account_id, bankPostedOn(inn.id, inn.account_id));
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

  return { converted: run(pairs) };
}

/**
 * A restored leg takes back the bank day its transfer kept for it: a stored posting row of the
 * transfer on the leg's account (written at conversion when the leg's bank day differed from the
 * transfer's date — a post-cutoff daily row is stored before the day the bank filed it). Without
 * a stored row there is nothing to carry (conversions before migration 199 recorded none).
 */
function carryStoredBankPosting(transferMovementId: number, restoredId: number, accountId: number): void {
  const stored = db
    .prepare(`SELECT posted_on FROM movement_bank_postings WHERE movement_id = ? AND account_id = ?`)
    .get(transferMovementId, accountId) as { posted_on: string } | undefined;
  if (stored) recordBankPosting(restoredId, accountId, stored.posted_on);
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
      `SELECT id, account_id, from_account_id, to_account_id, currency
       FROM movements WHERE id = ?`
    )
    .get(transferMovementId) as
    | { id: number; account_id: number | null; from_account_id: number | null; to_account_id: number | null; currency: string }
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
      `INSERT INTO movements (account_id, amount, currency, occurred_on, units_delta, note) VALUES (?,?,'clp',?,?,?)`
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
      // The restored leg takes back its bank day (the transfer's posting on that account).
      carryStoredBankPosting(transferMovementId, outId, row.from_account_id!);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferMovementId);
      return { restored_out_id: outId, restored_in_id: outId };
    })();
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

  // A peso leg is signed; a foreign one is written back as the withdrawal / deposit it was.
  const currency = row.currency;
  const foreign = currency !== HOME_CURRENCY;
  const insLeg = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, units_delta, note, flow_kind) VALUES (?,?,?,?,?,?,?)`
  );
  const run = db.transaction(() => {
    const outId = Number(
      insLeg.run(
        fromId,
        foreign ? Math.abs(data.out.amount_clp) : data.out.amount_clp,
        currency,
        data.out.occurred_on,
        data.out.units_delta,
        data.out.note,
        foreign ? "withdrawal" : null
      ).lastInsertRowid
    );
    const inId = Number(
      insLeg.run(
        toId,
        foreign ? Math.abs(data.in.amount_clp) : data.in.amount_clp,
        currency,
        data.in.occurred_on,
        data.in.units_delta,
        data.in.note,
        foreign ? "deposit" : null
      ).lastInsertRowid
    );
    // Each restored leg takes back its bank day (the transfer's posting on its account; a
    // post-cutoff daily row is stored before the day the bank filed it).
    carryStoredBankPosting(transferMovementId, outId, fromId);
    carryStoredBankPosting(transferMovementId, inId, toId);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferMovementId);
    return { restored_out_id: outId, restored_in_id: inId };
  });
  return run();
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
