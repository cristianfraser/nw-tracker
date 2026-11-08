import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The purchases module (`cards/purchases.ts`) is the one reader of card lines and plans. A file
 * outside `server/src/cards/` that selects from `cc_statement_lines` or `cc_installment_purchases`
 * must be listed here with why: the audit's raw-table readers (writers, identity and re-key
 * machinery, the plan ↔ line join) stay; the rest wait for their view of the module and leave the
 * list when they move. An entry that no longer reads the tables fails too, so the list only
 * shrinks.
 */
const RAW_TABLE_READERS: Record<string, string> = {
  // Writers and migrations: they own the rows.
  "ccStatementsImport.ts": "raw: the line importer (writes lines, owns dedupe keys and fingerprints)",
  "cardLineKind276.ts": "raw: migration 276 hook (fills the stored kind)",
  "expenseKeyLegacyRewrite273.ts": "raw: migration 273 hook (frozen)",
  "ccInstallmentLedgerMerge.ts": "raw: plan writer (canonical_row_id, twin_index)",
  "ccInstallmentManual.ts": "raw: manual plan CRUD and line → plan conversion",
  "ccInstallmentPaymentBackfill.ts": "raw: plan payment repair (F11)",
  "ccWebPasteInstallmentNudge.ts": "raw: first_due_month writer",
  "ccFeedCuotaPurchases.ts": "raw: plan creation from the feed, line tagging",
  "ccStatementPdfUpload.ts": "raw: renames a plan's source on upload",
  "ccStatementLineDelete.ts": "raw: deletes a bucket line by id",
  "ccPlantedPayments.ts": "raw: replaces planted payment lines by id",
  // Identity between arriving evidence and stored lines (F9 step 4 / F17).
  "ccExpenseLineDedupe.ts": "raw: import dedupe (exact and fuzzy twins)",
  "ccCrossImportDedupe.ts": "raw: import-time fuzzy line lookup and the superseded-line remover",
  "ccTruncatedMerchantDedupe.ts": "raw: pending vs settled bucket lines",
  "ccRecurringPendingLines.ts": "raw: pending listing under another name",
  "ccManualInstallmentStatementReconcile.ts": "raw: manual plan replaced by its statement twin",
  "cardStatementCrossCheck.ts": "raw: JSON vs ledger cross-check",
  "santanderStatementImport.ts": "raw: stale-echo and plan lookups by canonical_row_id",
  "ccExpenseCategoryPersist.ts": "raw: re-key mover (goes with F9 step 5)",
  "ccExpenseLineRekey.ts": "raw: re-key mover (goes with F9 step 5)",
  "ccExpenseCategories.ts": "raw: purchase key → line ids through parser_row_id (key resolvers)",
  "expenseDepositLinks.ts": "raw: mortgage-link category writer by line id",
  "ccExpenseGenericTransferBackfill.ts": "raw: category backfill",
  // The plan ↔ line join on parser_row_id, and the link tables keyed by line id.
  "ccInstallmentLedgerDb.ts": "raw: the plan ↔ payment ↔ line join (plans view still built here)",
  "ccInstallmentInterest.ts": "raw: the parser_row_id join for printed principal and rate",
  "ccTraspasoDeudaLinks.ts": "raw: persists traspaso pairs by line id (statement lines only)",
  "ccPaymentMirrorEvidence.ts": "raw: payment evidence by statement id (view 5 pending)",
  "ccStatementsDb.ts": "raw: a statement's own lines for the statement payload",
  // Not migrated yet: each waits for its view of the purchases module.
  "ccBillingBalances.ts": "pending view 1 (debt events) and view 2 (billed lines)",
  "ccBillingViews.ts": "pending view 2 (open-cycle lines, pending cuota purchases)",
  "ccCuotaRetirement.ts": "pending view 5 (payment evidence)",
  "ccOwedByCurrency.ts": "pending view 1 (owed per currency)",
  "ccInvestmentProxy.ts": "pending view 6 (proxy inputs)",
  "ccUsdStatementBilled.ts": "pending view 2 (a statement's billed dollars)",
  "ccFacturacionUsdRate.ts": "pending view 5 (traspaso legs)",
  "ccFacturadoFinancingAuto.ts": "pending views 2/5 (tagged lines, payments on file)",
  "ccInstallmentPaymentGastosLines.ts": "pending view 3 (expense lines, Por cuota)",
  "ccInstallmentPlanGastosLines.ts": "pending view 3 (expense lines, plan breakdown)",
  "ccInstallmentPurchaseTotalLines.ts": "pending view 3 (expense lines, Total)",
  "ccPurchaseExpenseLinks.ts": "pending view 4 (plan ↔ expense line link)",
  "flowsExpenses.ts": "pending view 3 (buildCcExpenseLines)",
  "ccAdditionalCardExpenseMatch.ts": "pending view 7 (latest statement's origin plastics)",
  "mortgagePaymentCardMatch.ts": "pending view 7 (findLines by merchant)",
  "mortgageUfReminder.ts": "pending view 7 (findLines by merchant)",
  "merchantExpenseNotes.ts": "pending view 7 (findLines by merchant)",
  "storeReceiptApply.ts": "pending view 7 (findLines by amount)",
  "groceryBranchLearning.ts": "pending view 7 (findLines on a card)",
  "liderCardLines.ts": "pending view 7 (same-day same-amount guard)",
  "f22Settlements.ts": "pending view 7 (a line by account, day and pesos)",
  // Not runtime.
  "markInputTriggers.ts": "trigger DDL names the tables",
  "demoData/invariants.ts": "demo build check",
  "test/vitestDbSeed.ts": "test seed",
};

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const READS = /(FROM|JOIN)\s+cc_(statement_lines|installment_purchases)\b/;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield p;
  }
}

describe("card lines and plans are read through the purchases module", () => {
  const readers = [...walk(SRC)]
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .filter((rel) => !rel.startsWith("cards/"))
    .filter((rel) => READS.test(fs.readFileSync(path.join(SRC, rel), "utf8")))
    .sort();

  it("no reader outside cards/ selects from the raw tables unless listed", () => {
    expect(readers.filter((r) => !(r in RAW_TABLE_READERS))).toEqual([]);
  });

  it("every listed reader still reads them (the list only shrinks)", () => {
    expect(Object.keys(RAW_TABLE_READERS).filter((r) => !readers.includes(r)).sort()).toEqual([]);
  });
});
