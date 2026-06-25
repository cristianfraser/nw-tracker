import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { partialMovementSupersededByCartola } from "./checkingCartolaPartialReconcile.js";
import type { UltimosMovimientoRow } from "./checkingUltimosMovimientosParse.js";

export function partialMovementNote(mv: UltimosMovimientoRow): string {
  const desc = mv.description.replace(/\|/g, "/").slice(0, 120);
  const doc = mv.document_no ? `|doc:${mv.document_no}` : "";
  return `import:cartola-partial|${mv.occurred_on}|${mv.amount_clp}|${desc}${doc}`;
}

const noteExists = db.prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ? LIMIT 1`);

export type PartialMovementsImportResult = {
  inserted: number;
  skipped_duplicate: number;
  skipped_superseded_by_cartola: number;
};

export function importCheckingPartialMovements(
  accountId: number,
  movements: UltimosMovimientoRow[]
): PartialMovementsImportResult {
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, NULL)`
  );

  let inserted = 0;
  let skipped_duplicate = 0;
  let skipped_superseded_by_cartola = 0;

  const tx = db.transaction(() => {
    for (const mv of movements) {
      const note = partialMovementNote(mv);
      if (noteExists.get(accountId, note)) {
        skipped_duplicate += 1;
        continue;
      }
      if (partialMovementSupersededByCartola(accountId, mv)) {
        skipped_superseded_by_cartola += 1;
        continue;
      }
      ins.run(accountId, mv.amount_clp, mv.occurred_on, note);
      inserted += 1;
    }
  });
  tx();
  clearCheckingBalanceCache(accountId);
  if (inserted > 0 && movements.length > 0) {
    let minOn = movements[0]!.occurred_on;
    for (const mv of movements) {
      if (mv.occurred_on < minOn) minOn = mv.occurred_on;
    }
    invalidateAggregationForAccountDate(accountId, minOn);
  }
  return { inserted, skipped_duplicate, skipped_superseded_by_cartola };
}
