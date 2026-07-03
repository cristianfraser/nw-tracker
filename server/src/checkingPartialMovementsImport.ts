import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { partialMovementSupersededByCartola } from "./checkingCartolaPartialReconcile.js";
import { findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import type { UltimosMovimientoRow } from "./checkingUltimosMovimientosParse.js";

export function partialMovementNote(mv: UltimosMovimientoRow): string {
  const desc = mv.description.replace(/\|/g, "/").slice(0, 120);
  const doc = mv.document_no ? `|doc:${mv.document_no}` : "";
  return `import:cartola-partial|${mv.occurred_on}|${mv.amount_clp}|${desc}${doc}`;
}

const noteExists = db.prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ? LIMIT 1`);

/** One imported/skipped flow, surfaced to the UI so the import result lists the actual movements. */
export type ImportFlowItem = {
  occurred_on: string;
  description: string;
  amount_clp: number;
};

export type SkippedImportFlowReason =
  | "duplicate"
  | "superseded_by_cartola"
  | "superseded_by_transfer"
  | "already_present";

export type SkippedImportFlowItem = ImportFlowItem & { reason: SkippedImportFlowReason };

export type PartialMovementsImportResult = {
  inserted: number;
  skipped_duplicate: number;
  skipped_superseded_by_cartola: number;
  skipped_superseded_by_transfer: number;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
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
  let skipped_superseded_by_transfer = 0;
  const inserted_flows: ImportFlowItem[] = [];
  const skipped_flows: SkippedImportFlowItem[] = [];
  const consumedTransferLegs = new Set<number>();
  const flowOf = (mv: UltimosMovimientoRow): ImportFlowItem => ({
    occurred_on: mv.occurred_on,
    description: mv.description,
    amount_clp: mv.amount_clp,
  });

  const tx = db.transaction(() => {
    for (const mv of movements) {
      const note = partialMovementNote(mv);
      if (noteExists.get(accountId, note)) {
        skipped_duplicate += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "duplicate" });
        continue;
      }
      if (partialMovementSupersededByCartola(accountId, mv)) {
        skipped_superseded_by_cartola += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_cartola" });
        continue;
      }
      const transferLegId = findMatchingInternalTransferLegId(
        accountId,
        mv.occurred_on,
        mv.amount_clp,
        consumedTransferLegs
      );
      if (transferLegId != null) {
        consumedTransferLegs.add(transferLegId);
        skipped_superseded_by_transfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_transfer" });
        continue;
      }
      ins.run(accountId, mv.amount_clp, mv.occurred_on, note);
      inserted += 1;
      inserted_flows.push(flowOf(mv));
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
  return {
    inserted,
    skipped_duplicate,
    skipped_superseded_by_cartola,
    skipped_superseded_by_transfer,
    inserted_flows,
    skipped_flows,
  };
}
