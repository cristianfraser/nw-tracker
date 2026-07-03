/**
 * Converts a confirmed mirror pair (movementMirrorPairs.ts) into one transfer row and back.
 *
 * The transfer takes the outflow leg's date (causal order: source before destination) and
 * carries the cuota leg's `units_delta` when one leg moves cuotas (cuota readers add
 * transferLegUnitsThroughDate on top of the account_id ledger, so fund balances stay exact).
 * Both legs are deleted; their exact content (ids, dates, amounts, units, notes) is preserved
 * in the transfer's `mirror-merge|…` note so the conversion is fully undoable.
 *
 * Embedded original notes have `|` encoded as `¦` (U+00A6): note-scanning readers match on
 * `|tag=`/prefix patterns and must never false-match tags inside a merged note (e.g. the
 * `|flow_kind=` regex in depositFlowKind.ts, `%cripto-coin-only-wdw%` contains-checks).
 *
 * Caveats (also surfaced in the panel copy):
 * - `import:excel --force-wipe` deletes single-leg rows per account and re-inserts from the
 *   sheet/certificado; the wipe also deletes `mirror-merge|` transfers touching wiped accounts
 *   (see import-excel-history.ts), so converted pairs reappear as candidates — re-convert via
 *   the panel (rejections cascade away with the legs).
 * - Ambiguous-tier pairs outside the business-day window: re-importing that cartola month can
 *   re-insert the bank leg (import dedupe window is 1 business day).
 */
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import { listMirrorPairCandidates } from "./movementMirrorPairs.js";

export const MIRROR_MERGE_NOTE_PREFIX = "mirror-merge|";

export function isMirrorMergeNote(note: string | null | undefined): boolean {
  return note != null && note.startsWith(MIRROR_MERGE_NOTE_PREFIX);
}

/** `|` cannot survive inside an embedded note (structural separator + tag-scanning readers). */
function encodeEmbeddedNote(note: string | null): string {
  if (note == null) return "-";
  return note.replace(/\|/g, "¦");
}

function decodeEmbeddedNote(encoded: string): string | null {
  if (encoded === "-") return null;
  return encoded.replace(/¦/g, "|");
}

function encodeNum(n: number | null): string {
  return n == null ? "-" : String(n);
}

function decodeNum(s: string): number | null {
  if (s === "-") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`mirror-merge note: invalid number "${s}"`);
  return n;
}

export type MirrorMergeLegSnapshot = {
  movement_id: number;
  occurred_on: string;
  amount_clp: number;
  units_delta: number | null;
  note: string | null;
};

export type MirrorMergeNoteData = {
  out: MirrorMergeLegSnapshot;
  in: MirrorMergeLegSnapshot;
};

export function buildMirrorMergeNote(out: MirrorMergeLegSnapshot, inn: MirrorMergeLegSnapshot): string {
  const leg = (l: MirrorMergeLegSnapshot) =>
    `(${l.movement_id}@${l.occurred_on}@${encodeNum(l.amount_clp)}@${encodeNum(l.units_delta)}):${encodeEmbeddedNote(l.note)}`;
  return `${MIRROR_MERGE_NOTE_PREFIX}out${leg(out)}|in${leg(inn)}`;
}

const MIRROR_MERGE_NOTE_RE =
  /^mirror-merge\|out\((\d+)@(\d{4}-\d{2}-\d{2})@(-?[\d.]+)@(-?[\d.]+|-)\):([^|]*)\|in\((\d+)@(\d{4}-\d{2}-\d{2})@(-?[\d.]+)@(-?[\d.]+|-)\):([^|]*)$/;

/** Parses a `mirror-merge|…` note; throws on anything malformed (fail fast — never guess). */
export function parseMirrorMergeNote(note: string): MirrorMergeNoteData {
  const m = MIRROR_MERGE_NOTE_RE.exec(note);
  if (!m) throw new Error(`not a mirror-merge note: ${note}`);
  return {
    out: {
      movement_id: Number(m[1]),
      occurred_on: m[2]!,
      amount_clp: decodeNum(m[3]!)!,
      units_delta: decodeNum(m[4]!),
      note: decodeEmbeddedNote(m[5]!),
    },
    in: {
      movement_id: Number(m[6]),
      occurred_on: m[7]!,
      amount_clp: decodeNum(m[8]!)!,
      units_delta: decodeNum(m[9]!),
      note: decodeEmbeddedNote(m[10]!),
    },
  };
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

      const note = buildMirrorMergeNote(
        { movement_id: out.id, occurred_on: out.occurred_on, amount_clp: out.amount_clp, units_delta: out.units_delta, note: out.note },
        { movement_id: inn.id, occurred_on: inn.occurred_on, amount_clp: inn.amount_clp, units_delta: inn.units_delta, note: inn.note }
      );
      const unitsSource = out.units_delta ?? inn.units_delta;
      const transferUnits =
        unitsSource != null && Number.isFinite(unitsSource) && unitsSource !== 0
          ? Math.abs(unitsSource)
          : null;
      const r = insTransfer.run(
        out.account_id,
        inn.account_id,
        Math.round(Math.abs(out.amount_clp)),
        out.occurred_on,
        note,
        transferUnits
      );
      delLeg.run(out.id);
      delLeg.run(inn.id);
      converted.push({
        transfer_movement_id: Number(r.lastInsertRowid),
        out_movement_id: out.id,
        in_movement_id: inn.id,
        from_account_id: out.account_id,
        to_account_id: inn.account_id,
        occurred_on: out.occurred_on,
      });
    }
    return converted;
  });

  const converted = run(pairs);
  for (const c of converted) {
    // Outflow date ≤ inflow date and invalidation clears forward months, so this also covers
    // the inflow leg's original month.
    clearCheckingBalanceCache(c.from_account_id);
    clearCheckingBalanceCache(c.to_account_id);
    invalidateAggregationForAccountDate(c.from_account_id, c.occurred_on);
    invalidateAggregationForAccountDate(c.to_account_id, c.occurred_on);
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
      `SELECT id, account_id, from_account_id, to_account_id, note
       FROM movements WHERE id = ?`
    )
    .get(transferMovementId) as
    | { id: number; account_id: number | null; from_account_id: number | null; to_account_id: number | null; note: string | null }
    | undefined;
  if (!row) throw new Error(`movement ${transferMovementId} not found`);
  if (row.account_id != null || row.from_account_id == null || row.to_account_id == null) {
    throw new Error(`movement ${transferMovementId} is not a transfer row`);
  }
  if (row.note == null || !isMirrorMergeNote(row.note)) {
    throw new Error(`movement ${transferMovementId} is not a mirror-merge conversion`);
  }
  const data = parseMirrorMergeNote(row.note);
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
  clearCheckingBalanceCache(fromId);
  clearCheckingBalanceCache(toId);
  invalidateAggregationForAccountDate(fromId, data.out.occurred_on);
  invalidateAggregationForAccountDate(toId, data.out.occurred_on);
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
