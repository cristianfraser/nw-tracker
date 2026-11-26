
import { insertBankPesoMovement, movementWrite, restateBankRowDocument } from "./movementWrites.js";
import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import { recordBankPosting } from "./movementBankPostings.js";
import { dailyListingFacts, recordBankListingFacts } from "./movementListingFacts.js";
import { normalizeForPartialMatch, partialDescriptionsMatch, partialMovementSupersededByCartola } from "./checkingCartolaPartialReconcile.js";
import { claimTransferLegForBankRow, findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";
import { maxFirstSeenSeq, orderListingStamps } from "./flows/flowFirstSeen.js";
import { DEFAULT_LISTING_ORDER, type ListingOrder } from "nw-tracker-contracts";
import {
  confirmTransferNoticeMovement,
  confirmTransferNoticeMovementForTransferLeg,
  findTransferNoticeMovementForBankRow,
} from "./transferNoticeMovements.js";

import type { PartialBankMovement } from "./partialBankMovement.js";

export type { PartialBankMovement } from "./partialBankMovement.js";

export function partialMovementNote(mv: PartialBankMovement): string {
  const desc = mv.description.replace(/\|/g, "/").slice(0, 120);
  const doc = mv.document_no ? `|doc:${mv.document_no}` : "";
  return `import:cartola-partial|${mv.occurred_on}|${mv.amount_clp}|${desc}${doc}`;
}

const noteRows = db.prepare(`SELECT id FROM movements WHERE account_id = ? AND note = ? ORDER BY id`);

/**
 * The daily-listing row on file that `mv` lists again under other text, unless this listing already
 * accounts for it: of the rows it matches, the one whose text is closest (the longest), and whether
 * the listing's text is longer (more informative: only then is the row restated).
 */
function relistedDailyRow(accountId: number, mv: PartialBankMovement, claimed: ReadonlySet<number>): { id: number; longer: boolean } | null {
  const rows = db
    .prepare(
      `SELECT m.id, e.stated_description AS description, e.stated_document_no AS document_no FROM movements m
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id AND e.source_kind = 'daily_listing'
       WHERE m.account_id = ? AND e.stated_on = ? AND m.amount = ? AND m.currency = 'clp' -- convention-ok: the daily checking listing is in pesos
       ORDER BY m.id`
    )
    .all(accountId, mv.occurred_on, mv.amount_clp) as { id: number; description: string | null; document_no: string | null }[];
  const doc = String(mv.document_no ?? "").trim();
  const len = (d: string) => normalizeForPartialMatch(d).length;
  const hit = rows
    .filter((r) => !claimed.has(r.id) && (r.document_no ?? "") === doc && r.description != null && partialDescriptionsMatch(r.description, mv.description))
    .sort((a, b) => len(b.description!) - len(a.description!) || a.id - b.id)[0];
  return hit ? { id: hit.id, longer: len(mv.description) > len(hit.description!) } : null;
}

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
  | "already_present"
  /** A row on file the cartola restated in place (the daily listing's row of the movement). */
  | "restated";

export type SkippedImportFlowItem = ImportFlowItem & { reason: SkippedImportFlowReason };

export type PartialMovementsImportResult = {
  inserted: number;
  /** Rows on file the listing printed again under other text (a pending row settled), restated in place. */
  restated: number;
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
  fetch: PartialListingFetch,
  /** The order `movements` are listed in (`listingOrder.ts`); its new rows are stamped oldest first. */
  listingOrder: ListingOrder = DEFAULT_LISTING_ORDER
): PartialMovementsImportResult {
  const fetchDay = listingFetchDay(fetch);
  // One movement write: the expense deposit links re-sync once, when the listing is in.
  return movementWrite(() => importPartialMovements(accountId, movements, fetchDay, listingOrder));
}

function importPartialMovements(
  accountId: number,
  movements: PartialBankMovement[],
  fetchDay: string,
  listingOrder: ListingOrder
): PartialMovementsImportResult {
  let inserted = 0;
  let restated = 0;
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

  const insertedIds: number[] = [];
  /** Rows on file this listing already accounts for: N identical rows in one listing are N movements. */
  const claimedRows = new Set<number>();
  const tx = db.transaction(() => {
    const stampsSince = maxFirstSeenSeq();
    // First the rows this listing prints exactly as on file: they claim their rows before any other
    // row of the listing is matched loosely against them.
    const exactOnFile = movements.map((mv) => {
      const sameNote = noteRows.all(accountId, partialMovementNote(mv)) as { id: number }[];
      if (sameNote.length === 0) return false;
      claimedRows.add((sameNote.find((r) => !claimedRows.has(r.id)) ?? sameNote[0]!).id);
      return true;
    });
    for (const [i, mv] of movements.entries()) {
      const note = partialMovementNote(mv);
      if (exactOnFile[i]) {
        skipped_duplicate += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "duplicate" });
        continue;
      }
      if (partialMovementSupersededByCartola(accountId, mv)) {
        skipped_superseded_by_cartola += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_cartola" });
        continue;
      }
      // A row on file the bank lists again under other text (a pending movement settled: the same
      // bank day, pesos and document, a description one is a prefix of — `partialDescriptionsMatch`)
      // is that row, never a second one: a longer rendering restates it in place.
      // A shorter or equal rendering is the same movement too: it writes nothing (no flip-flop).
      const relisted = relistedDailyRow(accountId, mv, claimedRows);
      if (relisted != null && !relisted.longer) {
        claimedRows.add(relisted.id);
        skipped_duplicate += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "duplicate" });
        continue;
      }
      if (relisted != null) {
        claimedRows.add(relisted.id);
        restateBankRowDocument(relisted.id, { note, flowKind: checkingMovementFlowKind(mv.description, mv.amount_clp) });
        recordBankListingFacts(relisted.id, dailyListingFacts(mv), db);
        db.prepare(`UPDATE flows SET description = ? WHERE id = (SELECT flow_id FROM movements WHERE id = ?)`).run(note, relisted.id);
        restated += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "restated" });
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
        listed: dailyListingFacts(mv),
      });
      if (occurredOn !== mv.occurred_on) recordBankPosting(id, accountId, mv.occurred_on, db, "fetch");
      inserted += 1;
      claimedRows.add(id);
      insertedIds.push(id);
      inserted_flows.push(flowOf(mv));
    }
    // Written in printed order; stamped in the listing's time order.
    const flowIdOf = db.prepare(`SELECT flow_id FROM movements WHERE id = ?`);
    const flowIds = insertedIds
      .map((id) => (flowIdOf.get(id) as { flow_id: number | null } | undefined)?.flow_id)
      .filter((f): f is number => f != null);
    orderListingStamps(flowIds, listingOrder, stampsSince);
  });
  tx();
  return {
    inserted,
    restated,
    skipped_duplicate,
    skipped_superseded_by_cartola,
    skipped_superseded_by_transfer,
    skipped_superseded_by_mail,
    inserted_flows,
    skipped_flows,
  };
}
