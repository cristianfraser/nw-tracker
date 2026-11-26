/**
 * A cartola month imported as a plan applied (`checkingCartolaPlan.ts`): the import's gates and
 * month record run as they always have (the saldo identity, the saldo chain, «parsed N but wrote
 * none», the `checking_cartola_imports` row), and the rows follow the plan — a row the app already
 * has is restated by the cartola, never deleted and written again:
 *
 *  - `keep`: a cartola row on file stays as it is (restated by its movement when the month is
 *    imported again, `replace_month`); a daily-listing row is restated as the movement's cartola row
 *    in place (`restateMovementFromCartola`), keeping its id, flow, stamp and a receipt-corrected day;
 *  - `confirm`: the transfer leg or mail-written row is claimed and confirmed;
 *  - `insert`: the cartola row is written (`insertBankPesoMovement`, which takes a retired flow of its
 *    document back; several retired flows for one document are left alone and reported);
 *  - `fold`: the row folds into the kept row (`foldMovementInto`);
 *  - `remove`: a daily row a transfer leg or a mail row already represents, or a cartola row of a
 *    replaced month the new cartola no longer lists.
 *
 * Several daily rows of one movement fold into the earliest seen. The caller (`importCartolaList`)
 * applies a plan only to a month written for the first time or replaced; a restate or record that
 * already states the cartola writes nothing.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { checkingCartolaPurchaseKeyOf, movementNote, type ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { assertCartolaMonthWrote, recordCartolaMonthImport } from "./checkingCartolaMonthRecord.js";
import { assertCheckingCartolaSaldoIdentity, validateCartolaSaldoChain } from "./checkingCartolaSaldoValidation.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";
import { claimTransferLegForBankRow } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import { confirmTransferNoticeMovement, confirmTransferNoticeMovementForTransferLeg } from "./transferNoticeMovements.js";
import { deleteMovements, insertBankPesoMovement } from "./movementWrites.js";
import { cartolaListingFacts } from "./movementListingFacts.js";
import { foldMovementInto, restateMovementFromCartola } from "./checkingCartolaRestate.js";
import type { RetiredMovementAdoption } from "./flows/flowAdoption.js";
import type { CheckingCartolaPlan } from "./checkingCartolaPlan.js";

export type CheckingCartolaPlanApplyResult = {
  /** Rows the cartola restated (a daily row becoming its cartola row, a replaced month's row). */
  restated: number[];
  inserted: number[];
  folded: number[];
  removed: number[];
  /** Transfer legs and mail rows the cartola confirmed. */
  confirmed: number[];
  /** Written rows that took a retired flow back, or found several (left alone). */
  flow_adoptions: NonNullable<RetiredMovementAdoption>[];
};

/** Applies `plan` (planned for `cartola` on `accountId`, see the module doc), in one transaction. */
export function applyCheckingCartolaPlan(
  accountId: number,
  cartola: ParsedCheckingCartola,
  plan: CheckingCartolaPlan,
  dbHandle: Database = db,
  opts?: { replaceMonth?: boolean }
): CheckingCartolaPlanApplyResult {
  assertCheckingCartolaSaldoIdentity(cartola);
  const chainErr = validateCartolaSaldoChain(accountId, cartola, dbHandle);
  if (chainErr) throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${chainErr}`);
  const out: CheckingCartolaPlanApplyResult = { restated: [], inserted: [], folded: [], removed: [], confirmed: [], flow_adoptions: [] };
  const kindOf = dbHandle.prepare(`SELECT source_kind FROM flow_evidence WHERE source_table = 'movements' AND source_row_id = ?`);
  dbHandle.transaction(() => {
    let wrote = 0;
    // Folds first: a cartola row on file that folds into an earlier-seen daily row goes before that
    // row takes its note.
    for (const f of plan.fold) {
      const listed = cartola.movements[f.movement]!;
      const key = checkingCartolaPurchaseKeyOf(accountId, {
        periodMonth: cartola.period_month,
        occurredOn: listed.occurred_on,
        amountClp: listed.amount_clp,
        cartolaIndex: f.movement,
      });
      foldMovementInto(f.row_id, f.into_row_id, accountId, dbHandle, key);
      out.folded.push(f.row_id);
    }
    cartola.movements.forEach((mv, index) => {
      const note = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
        occurredOn: mv.occurred_on,
        amountClp: mv.amount_clp,
        cartolaIndex: index,
      });
      const listed = cartolaListingFacts(cartola.period_month, mv, index);
      const flowKind = checkingMovementFlowKind(mv.description, mv.amount_clp);
      const keep = plan.keep.find((k) => k.movement === index);
      if (keep) {
        const kind = (kindOf.get(keep.row_id) as { source_kind: string } | undefined)?.source_kind;
        if (kind == null) throw new Error(`keep-rows apply: movement ${index} keeps row ${keep.row_id}, which is gone`);
        if (kind === "daily_listing" || (kind === "cartola" && opts?.replaceMonth)) {
          if (restateMovementFromCartola({ movementId: keep.row_id, accountId, note, amount: mv.amount_clp, flowKind, listed, cartolaIndex: index }, dbHandle)) {
            out.restated.push(keep.row_id);
          }
          wrote += 1;
        } else if (kind !== "cartola") {
          throw new Error(`keep-rows apply: movement ${index} keeps row ${keep.row_id}, a ${kind ?? "kind-less"} row`);
        }
        return;
      }
      const confirm = plan.confirm.find((c) => c.movement === index);
      if (confirm?.why === "transfer_leg") {
        claimTransferLegForBankRow(confirm.row_id, accountId, mv.occurred_on, dbHandle);
        confirmSyntheticRetiroForTransferLeg(confirm.row_id, mv.occurred_on, "cartola", dbHandle);
        confirmSyntheticCcPaymentForTransferLeg(confirm.row_id, mv.occurred_on, "cartola", dbHandle);
        confirmTransferNoticeMovementForTransferLeg(confirm.row_id, mv.occurred_on, "cartola", mv.description, dbHandle);
        out.confirmed.push(confirm.row_id);
        wrote += 1;
        return;
      }
      if (confirm?.why === "mail_notice") {
        confirmTransferNoticeMovement(confirm.row_id, accountId, mv.occurred_on, "cartola", mv.description, dbHandle);
        out.confirmed.push(confirm.row_id);
        wrote += 1;
        return;
      }
      if (!plan.insert.some((i) => i.movement === index)) throw new Error(`keep-rows apply: movement ${index} is in no outcome`);
      out.inserted.push(
        insertBankPesoMovement({ accountId, amount: mv.amount_clp, occurredOn: mv.occurred_on, note, flowKind, listed }, dbHandle, out.flow_adoptions)
      );
      wrote += 1;
    });
    // Removed last (a written row never takes a removed row's id).
    for (const r of plan.remove) {
      deleteMovements([r.row_id], dbHandle);
      out.removed.push(r.row_id);
    }
    assertCartolaMonthWrote(accountId, cartola, wrote, dbHandle);
    recordCartolaMonthImport(accountId, cartola, dbHandle);
  })();
  return out;
}
