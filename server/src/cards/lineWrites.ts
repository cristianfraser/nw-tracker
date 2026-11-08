/**
 * The card-line write funnel (docs/untangle-plan.md F11): every write that inserts, deletes or
 * replaces a card's statement lines — a listing import (paste, feed, planted payment, receipt
 * line), a statement import (PDF, JSON, parsed CSV), a line deleted from the page, a dedupe or a
 * reconcile — runs as one card-line write (`lineWriteSession.ts`):
 *
 * 1. one transaction, framed by the payment-evidence guard (a converted card payment must still
 *    find its evidence when the write ends, whichever step removed a line);
 * 2. every line removed goes through `applyCardLinePlan` (`ccCrossImportDedupe.ts`): its evidence
 *    date read BEFORE the delete, its expense assignments carried onto the line that replaces it;
 * 3. after the transaction, ONCE: the billing balances recomputed, then the valuations re-synced
 *    with the earliest evidence date the write touched (the contradicted daily stamps go with it);
 * 4. the follow-ups the write asked for (the facturado-financing links), and the expense deposit
 *    links re-synced from the lines the write left (`expenseAssignmentWrites.ts`).
 *
 * Nothing invalidates a cache by hand: the write-log triggers see the tables (docs/cache-registry.md).
 * Planners (dedupe, mirror, planted, recurring, reconcile) only plan; the funnel applies their plans.
 */
import { db } from "../db.js";
import { recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import { upsertCreditCardValuationsFromLedger } from "../ccCreditCardValuations.js";
import { keepingCcPaymentEvidence } from "../ccPaymentMirrorEvidence.js";
import { applyCardLinePlan } from "../ccCrossImportDedupe.js";
import { applyFacturadoFinancingLinks } from "../ccFacturadoFinancingAuto.js";
import { requestExpenseLinkSync } from "../expenseLinkSync.js";
// Registers the expense-link sync the finish asks for.
import "../expenseAssignmentWrites.js";
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import { mergeCardStatements, type CcAccountImportMergeResult } from "../ccInstallmentLedgerMerge.js";
import type { CcStatementsMergeOpts } from "../ccStatementsImport.js";
import type { CcImportFlowItem, SkippedCcImportFlowItem } from "../ccStatementsImport.js";
import {
  creditCardMasterMetaForAccount,
  listingStatements,
  newWebPasteBatchId,
  type CcListingParseResult,
  type CcListingStatementsOpts,
} from "../ccWebPasteParse.js";
import { applyWebPasteInstallmentFirstDueNudges, type CcInstallmentFirstDueNudge } from "../ccWebPasteInstallmentNudge.js";
import type { RecurringPendingResult } from "../ccRecurringPendingLines.js";
import { createImportBatch, type ImportBatchKind } from "../importBatches.js";
import type { GroceryBranchLearningResult } from "../groceryBranchLearning.js";
import type { PlantedPaymentMatchResult } from "../ccPlantedPayments.js";
import { accountProfileOptional } from "../accountProfile.js";
import {
  registerCardLineWriteFrame,
  withCardLineSession,
  type CardLinePlan,
  type CardLineWriteFrame,
} from "./lineWriteSession.js";

/** The funnel's frame (registered below; exported for the sequence test). */
export const CARD_LINE_WRITE_FRAME: CardLineWriteFrame = {
  transaction: (accountId, what, body) =>
    db.transaction(() => keepingCcPaymentEvidence(accountId, what, body))(),
  finish(accountId, evidenceFromYmd, followUps) {
    // The balance snapshot first: the valuation points are read from the billing detail, which
    // takes its months from that snapshot.
    recomputeCcBillingMonthBalances(accountId);
    upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: evidenceFromYmd });
    // A plan or a statement just landed may be the cuota purchase that paid another card's
    // facturado (or the facturado's close): link them, and plant the paid card's PAGO when no feed
    // of its own will show it.
    if (followUps.financingLinks) applyFacturadoFinancingLinks(plantFinancingPayment);
    requestExpenseLinkSync();
  },
};
registerCardLineWriteFrame(CARD_LINE_WRITE_FRAME);

function plantFinancingPayment(accountId: number, parsed: CcListingParseResult): void {
  insertLines(accountId, parsed, "cc_financing_payment");
}

/** Runs `body` as one card-line write on the account (plan writers, repairs, scripts). */
export function cardLineWrite<T>(accountId: number, what: string, body: () => T): T {
  return withCardLineSession(accountId, what, body);
}

/** Applies a planner's plan as one card-line write; returns the lines deleted. */
export function applyLinePlan(accountId: number, what: string, plan: CardLinePlan): number {
  if (plan.deleteLineIds.length === 0 && plan.carry.length === 0) return 0;
  return withCardLineSession(accountId, what, () => applyCardLinePlan(accountId, plan));
}

/** Deletes card lines (the page's delete, a repair): read-before-delete, guarded, re-synced. */
export function deleteLines(
  accountId: number,
  lineIds: readonly number[],
  opts: { what: string; carry?: CardLinePlan["carry"] }
): number {
  return applyLinePlan(accountId, opts.what, { deleteLineIds: lineIds, carry: opts.carry ?? [] });
}

/**
 * Canonical statements (PDF, JSON, the parsed corpus): they replace the stored copies of the same
 * statements (`replaceStatementKeys`), the plans and the bucket follow.
 */
export function replaceStatementLines(
  accountId: number,
  statements: readonly CardCanonicalStatement[],
  opts: { replaceStatementKeys: Set<string>; replaceLedger?: boolean; statements?: CcStatementsMergeOpts }
): CcAccountImportMergeResult {
  return withCardLineSession(accountId, "this statement import", () =>
    mergeCardStatements(accountId, statements, {
      replaceLedger: opts.replaceLedger ?? false,
      replaceStatementKeys: opts.replaceStatementKeys,
      statements: opts.statements,
    })
  );
}

function assertCreditCardAccount(accountId: number): void {
  if (accountProfileOptional(accountId)?.kind !== "credit_card") throw new Error("Account is not a credit card");
}

/**
 * A card's listing lines — the manual paste, the Santander feed, a planted payment, a receipt's
 * line — into its open buckets. Every listing source produces `CcListingLine[]` (debt-positive), and
 * every behaviour that matters downstream (dedupe keys, installment overlap, first-due nudges, the
 * batch log) lives here so the entry points cannot drift apart.
 *
 * @param batchKind `import_batches` kind, so a fetched import is distinguishable from a pasted one.
 */
export function insertLines(
  accountId: number,
  parsed: CcListingParseResult,
  batchKind: ImportBatchKind = "cc_web_paste",
  opts?: CcListingStatementsOpts
) {
  assertCreditCardAccount(accountId);
  const meta = creditCardMasterMetaForAccount(accountId);

  if (parsed.lines.length === 0) {
    return {
      batch_id: null,
      lines_parsed: 0,
      inserted: 0,
      skipped_duplicate: 0,
      skipped_cuota_billing: 0,
      skipped_saldo_inicial: 0,
      inserted_flows: [] as CcImportFlowItem[],
      skipped_flows: [] as SkippedCcImportFlowItem[],
      grocery_branch_learning: { learned: [], ambiguous: [] } as GroceryBranchLearningResult,
      planted_payments: { replaced: [], confirmed_in_place: [], ambiguous: [], removed_from_date: null } as PlantedPaymentMatchResult,
      installment_first_due_nudges: [] as CcInstallmentFirstDueNudge[],
      truncated_merchant_dedupe: [] as string[],
      recurring_pending: { replaced: [], ambiguous: [], removed_from_date: null } as RecurringPendingResult,
      parse_errors: parsed.errors,
    };
  }

  return withCardLineSession(accountId, `listing import (${batchKind})`, () => {
    const batchId = newWebPasteBatchId();
    const { statements, skipped_cuota_billing, skipped_saldo_inicial } = listingStatements(
      accountId,
      meta.cardGroup,
      meta.cardLast4,
      parsed.lines,
      opts
    );
    const merged = mergeCardStatements(accountId, statements, { replaceLedger: false, listingBatchKind: batchKind });

    // A pasted line that re-lists a manual plan's upcoming cuota is import-skipped as an overlap,
    // but it is evidence of the plan's real first-cuota month. Pin it (write-once) so the open
    // facturación and the projected months bill the cuota in the right cycle.
    const firstDueNudges = applyWebPasteInstallmentFirstDueNudges(accountId, parsed.lines);

    // Per-line arrays stay out of the batch log — counters only.
    const { inserted_flows, skipped_flows, ...statementCounters } = merged.statements;
    const batch_id = createImportBatch(batchKind, `web-paste|${batchId}`, {
      account_id: accountId,
      lines_parsed: parsed.lines.length,
      ...statementCounters,
      skipped_cuota_billing: skipped_cuota_billing.length,
      skipped_saldo_inicial: skipped_saldo_inicial.length,
      ledger: merged.ledger,
      installment_first_due_nudges: firstDueNudges,
      truncated_merchant_dedupe: merged.bucket.truncated_merchant_dedupe,
      planted_payments: merged.bucket.planted_payments,
      recurring_pending: merged.bucket.recurring_pending,
      grocery_branch_learning: merged.grocery_branch_learning,
      parse_errors: parsed.errors,
    });

    return {
      batch_id,
      lines_parsed: parsed.lines.length,
      inserted: merged.statements.linesInserted,
      skipped_duplicate: merged.statements.linesSkippedDuplicate,
      skipped_fuzzy_duplicate: merged.statements.linesSkippedFuzzyDuplicate,
      skipped_installment_overlap: merged.statements.linesSkippedInstallmentOverlap,
      skipped_cuota_billing: skipped_cuota_billing.length,
      skipped_saldo_inicial: skipped_saldo_inicial.length,
      overlap_removed: merged.overlap_removed ?? 0,
      installment_first_due_nudges: firstDueNudges,
      truncated_merchant_dedupe: merged.bucket.truncated_merchant_dedupe,
      planted_payments: merged.bucket.planted_payments,
      recurring_pending: merged.bucket.recurring_pending,
      grocery_branch_learning: merged.grocery_branch_learning,
      inserted_flows,
      skipped_flows: [
        ...skipped_flows,
        ...skipped_cuota_billing.map((f) => ({ ...f, reason: "cuota_billing" as const })),
        ...skipped_saldo_inicial.map((f) => ({ ...f, reason: "saldo_inicial" as const })),
      ],
      parse_errors: parsed.errors,
    };
  });
}

/** The facturado-financing pass on its own (the card feed's last step, after every card's write). */
export function runFinancingLinks(): void {
  applyFacturadoFinancingLinks(plantFinancingPayment);
}
