/**
 * Backfill `|flow_kind=aporte_estatal_clp|` on existing Fintual certificate movements whose
 * `|medio=` is a state-bonus label (e.g. Deposito CL). Safe to re-run.
 *
 * Usage: npm run retag:fintual-state-contributions -w nw-tracker-server
 */
import { db } from "../src/db.js";
import {
  DEPOSIT_FLOW_KIND_STATE,
  depositFlowKindFromMovementNote,
  isFintualStateBonusMedio,
} from "../src/depositFlowKind.js";

const rows = db
  .prepare(
    `SELECT id, note FROM movements
     WHERE note LIKE '%import:excel|fintual-certificado%'
       AND note NOT LIKE '%|flow_kind=aporte_estatal_clp|%'
       AND note NOT LIKE '%|flow_kind=deposit_clp|%'`
  )
  .all() as { id: number; note: string }[];

let updated = 0;
const upd = db.prepare(`UPDATE movements SET note = ? WHERE id = ?`);

for (const r of rows) {
  const medioPart = r.note.match(/\|medio=([^|]+)/)?.[1];
  if (!medioPart) continue;
  const medios = medioPart.split(";").map((s) => s.trim()).filter(Boolean);
  if (!medios.some(isFintualStateBonusMedio)) continue;
  if (depositFlowKindFromMovementNote(r.note) !== DEPOSIT_FLOW_KIND_STATE) continue;

  const note = r.note.includes("|flow_kind=")
    ? r.note
    : r.note.replace(
        /(\|day=\d{4}-\d{2}-\d{2})/,
        `$1|flow_kind=${DEPOSIT_FLOW_KIND_STATE}`
      );
  if (note === r.note) continue;
  upd.run(note, r.id);
  updated += 1;
}

console.log(`retag-fintual-state-contributions: updated ${updated} movement(s)`);
