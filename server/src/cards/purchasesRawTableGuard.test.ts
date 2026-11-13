import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The purchases module (`cards/purchases.ts`) is the one reader of card lines and plans. A file
 * outside `server/src/cards/` that selects from `cc_statement_lines` or `cc_installment_purchases`
 * must be listed here with why: the audit's raw-table readers (writers, identity and re-key
 * machinery, the link tables keyed by line id) stay; every other reader goes through a view, and an
 * entry that no longer reads the tables fails, so the list only
 * shrinks.
 */
const RAW_TABLE_READERS: Record<string, string> = {
  // Writers and migrations: they own the rows.
  "ccStatementsImport.ts": "raw: the line importer (writes lines, owns dedupe keys and fingerprints)",
  "cardLineKind276.ts": "raw: migration 276 hook (fills the stored kind)",
  "flows/flowEvidenceEstimate295.ts": "raw: migration 295 hook (re-kinds the estimate statements' lines' evidence)",
  "expenseKeyLegacyRewrite273.ts": "raw: migration 273 hook (frozen)",
  "vendorCatalogChange.ts": "raw: every line's merchant + id, read on the migration's own handle (migration 325 hook, load-vendor-catalog)",
  "ccInstallmentLedgerMerge.ts": "raw: plan writer (canonical_row_id, twin_index)",
  "ccInstallmentManual.ts": "raw: manual plan CRUD and line → plan conversion",
  "ccInstallmentPaymentBackfill.ts": "raw: plan payment repair (F11)",
  "ccWebPasteInstallmentNudge.ts": "raw: first_due_month writer",
  "ccFeedCuotaPurchases.ts": "raw: plan creation from the feed, line tagging",
  "ccStatementPdfUpload.ts": "raw: renames a plan's source on upload",
  "ccStatementLineDelete.ts": "raw: deletes a bucket line by id",
  "ccPlantedPayments.ts": "raw: replaces planted payment lines by id",
  "ccPlantedCharges.ts": "raw: the planted charge lines a listing line may be the later listing of",
  "ccPlantedCharges328.ts": "raw: migration 328 registers the planted charge lines already on file",
  // Identity between arriving evidence and stored lines (F9 step 4 / F17).
  "ccExpenseLineDedupe.ts": "raw: import dedupe (exact and fuzzy twins)",
  "ccCrossImportDedupe.ts": "raw: import-time fuzzy line lookup and the superseded-line remover",
  "ccTruncatedMerchantDedupe.ts": "raw: pending vs settled bucket lines",
  "flows/cardLineAdoption.ts": "raw: adoption on arrival — the line recogniser (parser_row_id, identity) and line categories",
  "ccRecurringPendingLines.ts": "raw: pending listing under another name",
  "ccManualInstallmentStatementReconcile.ts": "raw: manual plan replaced by its statement twin",
  "cardStatementCrossCheck.ts": "raw: JSON vs ledger cross-check",
  "santanderStatementImport.ts": "raw: stale-echo and plan lookups by canonical_row_id",
  "ccExpenseCategories.ts": "raw: purchase key → line ids through parser_row_id (key resolvers)",
  "expenseDepositLinks.ts": "raw: mortgage-link category writer by line id",
  "ccExpenseGenericTransferBackfill.ts": "raw: category backfill",
  // The flow identity (F9 step 3): which rows a key names, the flows seeded from them.
  "flows/flowKeyResolve.ts": "raw: expense key → the rows it names (flows' evidence)",
  "flows/flowTables279.ts": "raw: migration 279 hook (seeds a flow per row)",
  "flows/flowFirstSeen.ts": "raw: a card line's flow → its first-seen day (writer and line-id readers)",
  "flows/flowParts.ts": "raw: a line's pieces through its flow (the line id the pieces readers speak)",
  // The link tables keyed by line id.
  "ccTraspasoDeudaLinks.ts": "raw: persists traspaso pairs by line id (statement lines only)",
  "ccStatementsDb.ts": "raw: a statement's own lines for the statement payload",
  // Not runtime.
  "markInputTriggers.ts": "trigger DDL names the tables",
  "demoData/invariants.ts": "demo build check",
  "test/vitestDbSeed.ts": "test seed",
  "test/flowFixtures.ts": "test fixture lines",
  "test/tempCardMaster.ts": "test fixture card cleanup",
  "vitest.setup.ts": "per-file check that the person's card lines are unchanged",
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
