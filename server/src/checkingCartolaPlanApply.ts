/**
 * Applies a cartola plan (`checkingCartolaPlan.ts`) to the checking account: the import's gates and
 * month record run as `importCheckingCartola` runs them (the saldo identity, the saldo chain, «parsed
 * N but wrote none», the `checking_cartola_imports` row), and the rows follow the plan instead of
 * «insert every movement, then delete the daily rows and hand their flows over»:
 *
 *  - `keep`: a cartola row on file stays as it is; a daily-listing row is restated as the movement's
 *    cartola row in place (`restateMovementFromCartola`);
 *  - `confirm`: the transfer leg or mail-written row is claimed and confirmed, as today;
 *  - `insert`: the cartola row is written (`insertBankPesoMovement`, which takes a retired flow of its
 *    document back);
 *  - `fold`: the row folds into the kept row (`foldMovementInto`);
 *  - `remove`: the daily row goes.
 *
 * A plan with an ambiguous daily row (more identical daily rows than movements) is refused.
 * Called by nobody in production yet (keep-rows phase 2); the equivalence tests run it beside
 * today's import.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { movementNote, type ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { assertCartolaMonthWrote, recordCartolaMonthImport } from "./checkingCartolaImport.js";
import { assertCheckingCartolaSaldoIdentity, validateCartolaSaldoChain } from "./checkingCartolaSaldoValidation.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";
import { claimTransferLegForBankRow } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import { confirmTransferNoticeMovement, confirmTransferNoticeMovementForTransferLeg } from "./transferNoticeMovements.js";
import { deleteMovements, insertBankPesoMovement } from "./movementWrites.js";
import { cartolaListingFacts } from "./movementListingFacts.js";
import { foldMovementInto, restateMovementFromCartola } from "./checkingCartolaRestate.js";
import type { CheckingCartolaPlan } from "./checkingCartolaPlan.js";

export type CheckingCartolaPlanApplyResult = { restated: number[]; inserted: number[]; folded: number[]; removed: number[] };

/** Applies `plan` (planned for `cartola` on `accountId`, see the module doc), in one transaction. */
export function applyCheckingCartolaPlan(
  accountId: number,
  cartola: ParsedCheckingCartola,
  plan: CheckingCartolaPlan,
  dbHandle: Database = db
): CheckingCartolaPlanApplyResult {
  const unpaired = plan.ambiguous.filter((a) => a.movement < 0);
  if (unpaired.length > 0) throw new Error(`keep-rows apply: ${unpaired.map((a) => a.what).join("; ")}`);
  assertCheckingCartolaSaldoIdentity(cartola);
  const chainErr = validateCartolaSaldoChain(accountId, cartola, dbHandle);
  if (chainErr) throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${chainErr}`);
  const out: CheckingCartolaPlanApplyResult = { restated: [], inserted: [], folded: [], removed: [] };
  const kindOf = dbHandle.prepare(`SELECT source_kind FROM flow_evidence WHERE source_table = 'movements' AND source_row_id = ?`);
  dbHandle.transaction(() => {
    let wrote = 0;
    // Folds first: a cartola row on file that folds into an earlier-seen daily row goes before that
    // row takes its note.
    for (const f of plan.fold) {
      if (f.into_row_id == null) throw new Error(`keep-rows apply: daily row ${f.row_id} folds into no row`);
      foldMovementInto(f.row_id, f.into_row_id, accountId, dbHandle);
      out.folded.push(f.row_id);
    }
    cartola.movements.forEach((mv, index) => {
      const note = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
        occurredOn: mv.occurred_on,
        amountClp: mv.amount_clp,
        cartolaIndex: index,
      });
      const listed = cartolaListingFacts(cartola.period_month, mv);
      const flowKind = checkingMovementFlowKind(mv.description, mv.amount_clp);
      const keep = plan.keep.find((k) => k.movement === index);
      if (keep) {
        const kind = (kindOf.get(keep.row_id) as { source_kind: string } | undefined)?.source_kind;
        if (kind == null) throw new Error(`keep-rows apply: movement ${index} keeps row ${keep.row_id}, which is gone`);
        if (kind === "daily_listing") {
          if (restateMovementFromCartola({ movementId: keep.row_id, accountId, note, amount: mv.amount_clp, flowKind, listed }, dbHandle)) {
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
        wrote += 1;
        return;
      }
      if (confirm?.why === "mail_notice") {
        confirmTransferNoticeMovement(confirm.row_id, accountId, mv.occurred_on, "cartola", mv.description, dbHandle);
        wrote += 1;
        return;
      }
      if (!plan.insert.some((i) => i.movement === index)) throw new Error(`keep-rows apply: movement ${index} is in no outcome`);
      out.inserted.push(insertBankPesoMovement({ accountId, amount: mv.amount_clp, occurredOn: mv.occurred_on, note, flowKind, listed }, dbHandle));
      wrote += 1;
    });
    for (const r of plan.remove) {
      deleteMovements([r.row_id], dbHandle);
      out.removed.push(r.row_id);
    }
    assertCartolaMonthWrote(accountId, cartola, wrote, dbHandle);
    recordCartolaMonthImport(accountId, cartola, dbHandle);
  })();
  return out;
}
