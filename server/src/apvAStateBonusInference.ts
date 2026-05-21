import { db } from "./db.js";
import {
  depositFlowKindForApvAFintualRow,
  isApvAAccountNote,
} from "./apvAFintualFlowOverrides.js";
import {
  DEPOSIT_FLOW_KIND_STATE,
  depositFlowKindFromMovementNote,
  movementIsStateContribution,
} from "./depositFlowKind.js";

type MovRow = { id: number; occurred_on: string; amount_clp: number; note: string | null };

const classificationCache = new Map<number, Map<number, boolean>>();

function isApvAAccountId(accountId: number): boolean {
  const row = db.prepare(`SELECT notes FROM accounts WHERE id = ?`).get(accountId) as
    | { notes: string | null }
    | undefined;
  return isApvAAccountNote(row?.notes);
}

function movementIsStateBonus(accountId: number, row: MovRow): boolean {
  const note = row.note ?? "";
  if (movementIsStateContribution(note)) return true;

  if (isApvAAccountId(accountId)) {
    const medio = note.match(/\|medio=([^|]+)/)?.[1] ?? "";
    return depositFlowKindForApvAFintualRow(row.occurred_on, row.amount_clp, medio, note) === DEPOSIT_FLOW_KIND_STATE;
  }

  return depositFlowKindFromMovementNote(note) === DEPOSIT_FLOW_KIND_STATE;
}

function cacheForAccount(accountId: number): Map<number, boolean> {
  let m = classificationCache.get(accountId);
  if (m) return m;

  m = new Map();
  const rows = db
    .prepare(
      `SELECT id, occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
       ORDER BY occurred_on, id`
    )
    .all(accountId) as MovRow[];

  for (const r of rows) {
    m.set(r.id, movementIsStateBonus(accountId, r));
  }
  classificationCache.set(accountId, m);
  return m;
}

export function movementIsApvAStateBonus(accountId: number, movementId: number, _note: string | null): boolean {
  return cacheForAccount(accountId).get(movementId) ?? false;
}

export function clearApvAStateBonusInferenceCache(): void {
  classificationCache.clear();
}

export function getApvAInferredStateBonusIds(accountId: number): Set<number> {
  const ids = new Set<number>();
  for (const [id, isState] of cacheForAccount(accountId)) {
    if (isState) ids.add(id);
  }
  return ids;
}
