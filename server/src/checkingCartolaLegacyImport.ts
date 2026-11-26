/**
 * The cartola import the plan replaced (keep-rows phase 3): insert every cartola movement, then
 * delete the daily rows it lists and hand their flows over (`reconcileCartolaPartialImports`).
 * Production imports a cartola as a plan applied (`importCheckingCartola`); this stays only as the
 * reference the plan is compared with (`checkingCartolaPlanCompare.ts`, the equivalence tests,
 * `scripts/report-keep-rows-plan.ts`) and goes with the old path in phase 4.
 */
import type { Database } from "better-sqlite3";
import type { RetiredMovementAdoption } from "./flows/flowAdoption.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { db } from "./db.js";
import { reconcileCartolaPartialImports } from "./checkingCartolaPartialReconcile.js";
import {
  cartolaMovementDedupeKey,
  cartolaMovementMatchesImportedRow,
  movementNote,
  type ParsedCheckingCartola,
  type ParsedCheckingMovement,
} from "./checkingCartolaParse.js";
import { assertCheckingCartolaSaldoIdentity, validateCartolaSaldoChain } from "./checkingCartolaSaldoValidation.js";
import { assertCartolaMonthWrote, recordCartolaMonthImport } from "./checkingCartolaMonthRecord.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { cartolaListingFacts } from "./movementListingFacts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import { claimTransferLegForBankRow, findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import {
  confirmTransferNoticeMovement,
  confirmTransferNoticeMovementForTransferLeg,
  findTransferNoticeMovementForBankRow,
} from "./transferNoticeMovements.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import type { ImportFlowItem, SkippedImportFlowItem } from "./checkingPartialMovementsImport.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";

export function importCheckingCartolaInsertThenPrune(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): {
  movementsInserted: number;
  movementsSkipped: number;
  partialsRemoved: number;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
  /** Rows that took a retired flow back (a re-imported month), or found several (left alone). */
  flow_adoptions: NonNullable<RetiredMovementAdoption>[];
} {
  assertCheckingCartolaSaldoIdentity(cartola);
  const flow_adoptions: NonNullable<RetiredMovementAdoption>[] = [];
  const chainErr = validateCartolaSaldoChain(accountId, cartola, dbHandle);
  if (chainErr) {
    throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${chainErr}`);
  }

  const noteExists = dbHandle.prepare(
    `SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ? LIMIT 1`
  );

  function countMatchingInDb(mv: ParsedCheckingMovement, periodMonth: string): number {
    const rows = dbHandle
      .prepare(
        `SELECT m.note FROM movements m ${BANK_POSTING_JOIN_SQL}
         WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?
           AND m.note LIKE ?`
      )
      .all(accountId, accountId, mv.occurred_on, mv.amount_clp, `import:cartola|${periodMonth}|%`) as {
      note: string;
    }[];
    let n = 0;
    for (const r of rows) {
      if (cartolaMovementMatchesImportedRow(mv, r.note)) n += 1;
    }
    return n;
  }

  let movementsInserted = 0;
  let movementsSkipped = 0;
  let movementsSupersededByTransfer = 0;
  let partialsRemoved = 0;
  const inserted_flows: ImportFlowItem[] = [];
  const skipped_flows: SkippedImportFlowItem[] = [];
  const flowOf = (mv: ParsedCheckingMovement): ImportFlowItem => ({
    occurred_on: mv.occurred_on,
    description: mv.description,
    amount_clp: mv.amount_clp,
  });
  const consumedTransferLegs = new Set<number>();
  const consumedMailMovements = new Set<number>();
  const tx = dbHandle.transaction(() => {
    cartola.movements.forEach((mv, cartolaIndex) => {
      const note = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
        occurredOn: mv.occurred_on,
        amountClp: mv.amount_clp,
        cartolaIndex,
      });
      if (noteExists.get(accountId, note)) {
        movementsSkipped += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "duplicate" });
        return;
      }
      const sameKeyIndex = cartola.movements
        .slice(0, cartolaIndex)
        .filter((prior) => cartolaMovementDedupeKey(prior) === cartolaMovementDedupeKey(mv)).length;
      if (countMatchingInDb(mv, cartola.period_month) >= sameKeyIndex + 1) {
        movementsSkipped += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "already_present" });
        return;
      }
      // Already represented by a manual internal transfer leg (from/to touching this account)?
      // Keep the single transfer row instead of inserting a duplicate bank line.
      const transferLegId = findMatchingInternalTransferLegId(
        accountId,
        mv.occurred_on,
        mv.amount_clp,
        consumedTransferLegs,
        dbHandle
      );
      if (transferLegId != null) {
        consumedTransferLegs.add(transferLegId);
        claimTransferLegForBankRow(transferLegId, accountId, mv.occurred_on, dbHandle);
        // The bank listed the money a synthesized retiro / card-payment / transfer-mail transfer promised —
        // stamp it confirmed (no-op for ordinary manual transfer legs).
        confirmSyntheticRetiroForTransferLeg(transferLegId, mv.occurred_on, "cartola", dbHandle);
        confirmSyntheticCcPaymentForTransferLeg(transferLegId, mv.occurred_on, "cartola", dbHandle);
        confirmTransferNoticeMovementForTransferLeg(transferLegId, mv.occurred_on, "cartola", mv.description, dbHandle);
        movementsSkipped += 1;
        movementsSupersededByTransfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_transfer" });
        return;
      }
      // Already written from the transfer's mail (and likely confirmed by the daily feed already).
      const mailMovementId = findTransferNoticeMovementForBankRow(
        accountId,
        mv.occurred_on,
        mv.amount_clp,
        consumedMailMovements,
        dbHandle
      );
      if (mailMovementId != null) {
        consumedMailMovements.add(mailMovementId);
        confirmTransferNoticeMovement(mailMovementId, accountId, mv.occurred_on, "cartola", mv.description, dbHandle);
        movementsSkipped += 1;
        movementsSupersededByTransfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_mail" });
        return;
      }
      insertBankPesoMovement(
        {
          accountId,
          amount: mv.amount_clp,
          occurredOn: mv.occurred_on,
          note,
          flowKind: checkingMovementFlowKind(mv.description, mv.amount_clp),
          listed: cartolaListingFacts(cartola.period_month, mv),
        },
        dbHandle,
        flow_adoptions
      );
      movementsInserted += 1;
      inserted_flows.push(flowOf(mv));
    });
    assertCartolaMonthWrote(accountId, cartola, movementsInserted + movementsSupersededByTransfer, dbHandle);
    const reconcile = reconcileCartolaPartialImports(accountId, cartola.movements, dbHandle);
    partialsRemoved = reconcile.removed;
    recordCartolaMonthImport(accountId, cartola, dbHandle);
  });
  tx();
  return { movementsInserted, movementsSkipped, partialsRemoved, inserted_flows, skipped_flows, flow_adoptions };
}

