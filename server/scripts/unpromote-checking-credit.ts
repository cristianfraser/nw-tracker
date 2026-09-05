/**
 * Undo a wrong in-place promotion: turn a Fintual-goal → checking transfer back into the plain
 * single-leg checking credit it was before `promoteCheckingCreditToTransfer` rewrote it.
 *
 *   npx tsx scripts/unpromote-checking-credit.ts --movement-id=NN --note='<original note>'
 *   npx tsx scripts/unpromote-checking-credit.ts --movement-id=NN --note='…' --apply
 *
 * Why this exists: until 2026-09-05 the retiro pairing window was symmetric (±5 days), so a
 * «Pagamos tu retiro» mail whose real bank leg was not imported yet could claim an unrelated
 * same-amount credit dated BEFORE the payment day and rewrite that row in place — the credit's
 * identity (its `import:cartola-partial|…` note, the xlsx dedupe key) was overwritten with the
 * retiro's, its date kept, and the goal's cuotas were sold days early. The window is one-sided
 * now (`fintualWithdrawalPairing.ts`); this restores the row the old window hijacked.
 *
 * `--note` must be the credit's ORIGINAL note, byte-exact: for a daily-xlsx row that is the
 * `partialMovementNote` key (`import:cartola-partial|<ymd>|<signed amount>|<desc>|doc:<n>` —
 * copy the pattern from a sibling row of the same feed). It is what stops the next xlsx import
 * from re-inserting the credit as a second row. Personal values stay on the command line.
 *
 * Report-only by default; `--apply` writes. Refuses when the row is not a goal → checking
 * transfer, when it is a synthesized retiro (those are deleted, not unpromoted — a different
 * repair), or when another checking row already carries the target note.
 */
import { db } from "../src/db.js";
import { checkingAccountId } from "../src/checkingCartolaImport.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

const apply = process.argv.includes("--apply");
const movementId = Number(arg("movement-id"));
const note = arg("note");
if (!Number.isInteger(movementId) || movementId <= 0) throw new Error("--movement-id=NN is required");
if (!note) throw new Error("--note='<original note>' is required");

type Row = {
  id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  units_delta: number | null;
  flow_kind: string | null;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  note: string;
};

const checkingId = checkingAccountId();
const row = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(movementId) as Row | undefined;
if (!row) throw new Error(`movement ${movementId} does not exist`);

if (row.account_id != null || row.from_account_id == null || row.to_account_id !== checkingId) {
  throw new Error(
    `movement ${movementId} is not a → checking transfer (account_id=${row.account_id}, ` +
      `from=${row.from_account_id}, to=${row.to_account_id}); nothing to unpromote`
  );
}
if (row.currency !== "clp") throw new Error(`movement ${movementId} is ${row.currency}, expected clp`);

const goal = db
  .prepare(`SELECT id, name, import_key FROM accounts WHERE id = ?`)
  .get(row.from_account_id) as { id: number; name: string; import_key: string | null } | undefined;
if (!goal?.import_key?.startsWith("import:fintual|cert|")) {
  throw new Error(
    `movement ${movementId} comes from account ${row.from_account_id} (${goal?.import_key ?? "?"}), ` +
      "not a Fintual goal — refusing"
  );
}

const synthesized = db
  .prepare(`SELECT message_id FROM fintual_synthetic_retiro_transfers WHERE movement_id = ?`)
  .get(movementId) as { message_id: string } | undefined;
if (synthesized) {
  throw new Error(
    `movement ${movementId} was SYNTHESIZED from mail ${synthesized.message_id}; it never was a ` +
      "checking credit — delete it instead of unpromoting"
  );
}

const collision = db
  .prepare(`SELECT id FROM movements WHERE account_id = ? AND note = ? AND id != ?`)
  .get(checkingId, note, movementId) as { id: number } | undefined;
if (collision) {
  throw new Error(`movement ${collision.id} already carries that note — the credit exists twice?`);
}

console.log(`movement ${row.id} (${row.occurred_on}, ${row.amount} ${row.currency})`);
console.log(`  now:   ${goal.name} (${goal.id}) → checking (${checkingId}), units ${row.units_delta}, note "${row.note}"`);
console.log(`  after: single-leg credit on checking (${checkingId}), units null, note "${note}"`);
console.log(`  goal cuotas restored: +${row.units_delta}`);

if (!apply) {
  console.log("\nReport only — re-run with --apply to write.");
  process.exit(0);
}

const changed = db
  .prepare(
    `UPDATE movements
     SET account_id = ?, from_account_id = NULL, to_account_id = NULL,
         units_delta = NULL, flow_kind = NULL, note = ?
     WHERE id = ? AND from_account_id = ? AND to_account_id = ?`
  )
  .run(checkingId, note, movementId, row.from_account_id, checkingId).changes;
if (changed !== 1) throw new Error(`expected to rewrite exactly one row, changed ${changed}`);

invalidateAggregationForAccountDate(checkingId, row.occurred_on);
invalidateAggregationForAccountDate(goal.id, row.occurred_on);

const after = db.prepare(`SELECT * FROM movements WHERE id = ?`).get(movementId) as Row;
console.log(
  `\nDone. movement ${after.id}: account_id=${after.account_id} from=${after.from_account_id} ` +
    `to=${after.to_account_id} units=${after.units_delta} note="${after.note}"`
);
