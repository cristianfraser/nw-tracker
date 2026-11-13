
import { insertBankPesoMovement, movementWrite } from "./movementWrites.js";
import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import { recordBankPosting } from "./movementBankPostings.js";

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
 * One row of a bank account's recent-movements listing, as the bank lists it: the bank's posting
 * date, the bank's description, the signed peso amount, the document number ("" when the row
 * prints none). The posting date is the row's identity (note key, cartola and transfer matching);
 * the stored `occurred_on` may be earlier (see {@link importCheckingPartialMovements}).
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

/** When the listing was read: the feeder's download time, or the moment the user pasted/uploaded it. */
export type PartialListingFetch = { fetchedAt: Date };

/**
 * The day a listed row's money moved, as far as the listing can tell: its posting date, except
 * that Santander's bank day ends at 14:00 and a movement after the cutoff is listed under the
 * NEXT workday — a row dated after the day the listing was read happened on or before that day,
 * and the read is usually the same evening (the nightly fetch at 22:00), so it takes the fetch
 * day. Rows dated on or before the fetch day keep their date.
 */
export function partialRowOccurredOn(bankDate: string, fetchDay: string): string {
  return bankDate > fetchDay ? fetchDay : bankDate;
}

/** The Chile calendar day of the instant a listing was read. */
export function listingFetchDay(fetch: PartialListingFetch): string {
  if (!(fetch.fetchedAt instanceof Date) || !Number.isFinite(fetch.fetchedAt.getTime())) {
    throw new Error(`A listing's fetch instant must be a valid date, got ${String(fetch.fetchedAt)}`);
  }
  return chileWallClockAt(fetch.fetchedAt).ymd;
}

/**
 * Insert the rows of a recent-movements listing the ledger does not hold yet. A row the bank
 * dated after the fetch day ({@link partialRowOccurredOn}) is stored on the fetch day with its
 * bank date as its posting day on the account (`movement_bank_postings`), which every
 * reconciliation against a bank document reads; everything that identifies the row (the note
 * key, the cartola and transfer-leg matching, the mail supersede) keeps the bank date.
 */
export function importCheckingPartialMovements(
  accountId: number,
  movements: PartialBankMovement[],
  fetch: PartialListingFetch
): PartialMovementsImportResult {
  const fetchDay = listingFetchDay(fetch);
  // One movement write: the expense deposit links re-sync once, when the listing is in.
  return movementWrite(() => importPartialMovements(accountId, movements, fetchDay));
}

function importPartialMovements(
  accountId: number,
  movements: PartialBankMovement[],
  fetchDay: string
): PartialMovementsImportResult {
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
      const occurredOn = partialRowOccurredOn(mv.occurred_on, fetchDay);
      const id = insertBankPesoMovement({
        accountId,
        amount: mv.amount_clp,
        occurredOn,
        note,
        flowKind: checkingMovementFlowKind(mv.description, mv.amount_clp),
      });
      if (occurredOn !== mv.occurred_on) recordBankPosting(id, accountId, mv.occurred_on, db, "fetch");
      inserted += 1;
      inserted_flows.push(flowOf(mv));
    }
  });
  tx();
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
