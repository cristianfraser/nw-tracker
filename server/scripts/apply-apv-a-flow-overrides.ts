/**
 * Writes `|flow_kind=…|` into APV-a Fintual certificate movement notes from
 * `cfraser/apv-a-fintual-flow-overrides.csv` (and medio/tipo rules).
 *
 * Usage: npm run apv:apply-flow-overrides -w nw-tracker-server
 */
import { db } from "../src/db.js";
import {
  depositFlowKindForApvAFintualRow,
  reloadApvAFintualFlowOverrides,
} from "../src/apvAFintualFlowOverrides.js";
import { clearApvAStateBonusInferenceCache } from "../src/apvAStateBonusInference.js";

const APV_A_NOTE = "import:excel|key=apv_a";

const account = db
  .prepare(`SELECT id FROM accounts WHERE notes = ?`)
  .get(APV_A_NOTE) as { id: number } | undefined;

if (!account) {
  console.log("No APV-a account found.");
  process.exit(0);
}

reloadApvAFintualFlowOverrides();

const rows = db
  .prepare(
    `SELECT id, occurred_on, amount_clp, note FROM movements
     WHERE account_id = ? AND note LIKE '%fintual-certificado%'`
  )
  .all(account.id) as { id: number; occurred_on: string; amount_clp: number; note: string | null }[];

const upd = db.prepare(`UPDATE movements SET note = ? WHERE id = ?`);
let updated = 0;

for (const r of rows) {
  const medio = r.note?.match(/\|medio=([^|]+)/)?.[1] ?? "";
  const kind = depositFlowKindForApvAFintualRow(r.occurred_on, r.amount_clp, medio, r.note);
  let note = (r.note ?? "").replace(
    /\|flow_kind=(?:deposit_clp|aporte_estatal_clp|traspaso_bonificacion_clp)/,
    ""
  );
  if (note.includes("|day=")) {
    note = note.replace(/(\|day=\d{4}-\d{2}-\d{2})/, `$1|flow_kind=${kind}`);
  } else {
    note = `${note}|flow_kind=${kind}`;
  }
  if (note !== r.note) {
    upd.run(note, r.id);
    updated += 1;
  }
}

clearApvAStateBonusInferenceCache();
console.log(`apv:apply-flow-overrides: updated ${updated} movement note(s) on account ${account.id}`);
