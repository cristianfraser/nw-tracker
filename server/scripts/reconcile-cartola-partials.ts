/**
 * Prune `import:cartola-partial|…` movements that a later full-cartola import superseded but the
 * (previously too-strict) matcher failed to dedupe. Matches DB-resident partial rows against
 * DB-resident `import:cartola|…` rows on the same account/date/amount with the tolerant
 * description compare (case / truncation / marker / mojibake differences between the últimos web
 * view and the cartola). Transfers any user category from the partial row to the cartola note
 * before deleting.
 *
 *   npm run reconcile:cartola-partials -w nw-tracker-server              # apply
 *   npm run reconcile:cartola-partials -w nw-tracker-server -- --dry-run
 */
import { clearAggregationCache } from "../src/aggregationCache.js";
import { clearCheckingBalanceCache } from "../src/checkingCartolaBalances.js";
import { cartolaNoteContent } from "../src/checkingCartolaParse.js";
import {
  PARTIAL_NOTE_PREFIX,
  parsePartialMovementNote,
  partialDescriptionsMatch,
} from "../src/checkingCartolaPartialReconcile.js";
import { transferCheckingGastosCategoryFromMovementToNote } from "../src/checkingGastosCategoryPersist.js";
import { db } from "../src/db.js";
import { listMovementBalanceCashAccountIds } from "../src/movementBalanceCashAccounts.js";

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const del = db.prepare(`DELETE FROM movements WHERE id = ?`);
  let removed = 0;
  let kept = 0;

  for (const accountId of listMovementBalanceCashAccountIds()) {
    const partials = db
      .prepare(
        `SELECT id, occurred_on, amount_clp, note FROM movements
         WHERE account_id = ? AND note LIKE ?`
      )
      .all(accountId, `${PARTIAL_NOTE_PREFIX}%`) as {
      id: number;
      occurred_on: string;
      amount_clp: number;
      note: string;
    }[];

    for (const p of partials) {
      const parsed = parsePartialMovementNote(p.note);
      if (!parsed) continue;
      const cartolaRows = db
        .prepare(
          `SELECT note FROM movements
           WHERE account_id = ? AND occurred_on = ? AND amount_clp = ?
             AND note LIKE 'import:cartola|%' AND note NOT LIKE 'import:cartola|anchor|%'`
        )
        .all(accountId, p.occurred_on, p.amount_clp) as { note: string }[];
      const match = cartolaRows.find((c) => {
        const content = cartolaNoteContent(c.note);
        return content != null && partialDescriptionsMatch(parsed.description, content.description);
      });
      if (!match) {
        kept += 1;
        console.log(
          `  keep  mov ${p.id} ${p.occurred_on} ${p.amount_clp} "${parsed.description.slice(0, 50)}" — no cartola twin`
        );
        continue;
      }
      console.log(
        `  ${dryRun ? "would remove" : "remove"} mov ${p.id} ${p.occurred_on} ${p.amount_clp} "${parsed.description.slice(0, 50)}"`
      );
      if (!dryRun) {
        transferCheckingGastosCategoryFromMovementToNote(accountId, p.id, match.note, db);
        del.run(p.id);
      }
      removed += 1;
    }
    if (!dryRun) clearCheckingBalanceCache(accountId);
  }

  if (!dryRun && removed > 0) clearAggregationCache();
  console.log(
    `reconcile:cartola-partials${dryRun ? " (dry run)" : ""}: ${removed} superseded partial(s) ${dryRun ? "matched" : "removed"}, ${kept} kept (no cartola twin).`
  );
}

main();
