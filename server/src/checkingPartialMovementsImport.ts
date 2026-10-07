import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { partialMovementSupersededByCartola } from "./checkingCartolaPartialReconcile.js";
import { claimTransferLegForBankRow, findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";
import {
  confirmTransferNoticeMovement,
  confirmTransferNoticeMovementForTransferLeg,
  findTransferNoticeMovementForBankRow,
} from "./transferNoticeMovements.js";

/**
 * One row of a bank account's recent-movements listing, as the import stores it: the posting date,
 * the bank's description, the signed peso amount, the document number ("" when the row prints none).
 */
export type PartialBankMovement = {
  occurred_on: string;
  description: string;
  amount_clp: number;
  document_no: string;
};

export function partialMovementNote(mv: PartialBankMovement): string {
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
  /** A credit already written from the transfer's mail (`transfer_notice_movements`). */
  | "superseded_by_mail"
  | "already_present";

export type SkippedImportFlowItem = ImportFlowItem & { reason: SkippedImportFlowReason };

export type PartialMovementsImportResult = {
  inserted: number;
  skipped_duplicate: number;
  skipped_superseded_by_cartola: number;
  skipped_superseded_by_transfer: number;
  skipped_superseded_by_mail: number;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
};

export function importCheckingPartialMovements(
  accountId: number,
  movements: PartialBankMovement[]
): PartialMovementsImportResult {
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
     VALUES (?, ?, 'clp', ?, ?, NULL, ?)`
  );

  let inserted = 0;
  let skipped_duplicate = 0;
  let skipped_superseded_by_cartola = 0;
  let skipped_superseded_by_transfer = 0;
  let skipped_superseded_by_mail = 0;
  const inserted_flows: ImportFlowItem[] = [];
  const skipped_flows: SkippedImportFlowItem[] = [];
  const consumedTransferLegs = new Set<number>();
  const consumedMailMovements = new Set<number>();
  const flowOf = (mv: PartialBankMovement): ImportFlowItem => ({
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
        claimTransferLegForBankRow(transferLegId, accountId, mv.occurred_on);
        // The bank listed the money a synthesized retiro / card-payment / transfer-mail transfer promised —
        // stamp it confirmed (no-op for ordinary manual transfer legs).
        confirmSyntheticRetiroForTransferLeg(transferLegId, mv.occurred_on, "ultimos_xlsx");
        confirmSyntheticCcPaymentForTransferLeg(transferLegId, mv.occurred_on, "ultimos_xlsx");
        confirmTransferNoticeMovementForTransferLeg(transferLegId, mv.occurred_on, "ultimos_xlsx", mv.description);
        skipped_superseded_by_transfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_transfer" });
        continue;
      }
      // Already written from the transfer's mail during the day: keep that row (the mail's day is
      // when the money arrived) and record the bank's day as its posting day.
      const mailMovementId = findTransferNoticeMovementForBankRow(accountId, mv.occurred_on, mv.amount_clp, consumedMailMovements);
      if (mailMovementId != null) {
        consumedMailMovements.add(mailMovementId);
        confirmTransferNoticeMovement(mailMovementId, accountId, mv.occurred_on, "ultimos_xlsx", mv.description);
        skipped_superseded_by_mail += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_mail" });
        continue;
      }
      ins.run(
        accountId,
        mv.amount_clp,
        mv.occurred_on,
        note,
        checkingMovementFlowKind(mv.description, mv.amount_clp)
      );
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
    skipped_superseded_by_mail,
    inserted_flows,
    skipped_flows,
  };
}
