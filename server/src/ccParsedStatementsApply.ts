import type { CardParsedStatementsApplyDetails } from "nw-tracker-contracts";
import { groupInstallmentLoanChains, mergeCcAccountFromParsedRows, replaceStatementKeysFromRecords } from "./ccInstallmentLedgerMerge.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { cardLast4FromParsedRow, resolveImportAccountIds } from "./ccParsedImportAccounts.js";
import { filterUnchangedStatementRecords, groupRecordsByStatement } from "./ccStatementFingerprint.js";
import { buildCcStatementImportAccountLog, logCcStatementImportRun, type CcStatementImportAccountLog } from "./ccStatementImportLog.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { db } from "./db.js";

/**
 * Parsed card statements (`card.parsed_statements`, or the parsed CSV a maintenance run reads) →
 * the ledger, merging: each line goes to its card account by `card_last4` (through the card
 * registry's consolidation redirects), and per account only the statements whose rows changed
 * since their last import are re-imported (`ccStatementFingerprint.ts`) — `full` re-imports
 * every one, which is the periodic from-scratch reconcile. Each account's changed statements go
 * through `mergeCcAccountFromParsedRows` together (one call), as they always have: reconcile
 * gates, installment ledger, web-paste supersede, traspaso links and valuation re-sync included.
 *
 * Lines no card account takes are a problem and nothing is written. A gate that refuses a
 * statement throws, as before (the caller's step fails).
 */

export type ApplyParsedCcStatementsOptions = {
  dryRun: boolean;
  full: boolean;
  /** Restrict to one card account (maintenance runs). */
  accountId?: number;
  /** Restrict to the cards of one credit-card group (maintenance runs). */
  groupSlug?: string;
};

function accountLabelForId(accountId: number): string {
  const row = db.prepare(`SELECT name, import_key FROM accounts WHERE id = ?`).get(accountId) as
    | { name: string; import_key: string | null }
    | undefined;
  const m = /credit_card_master\|[^|]+\|(\d{4})/.exec(String(row?.import_key ?? ""));
  return `${m?.[1] ?? "?"} ${row?.name ?? ""}`.trim();
}

export function partitionParsedRecordsByAccount(
  records: readonly CcStatementCsvRecord[],
  accountIds: readonly number[]
): Map<number, CcStatementCsvRecord[]> {
  const allowed = new Set(accountIds);
  const byAccount = new Map<number, CcStatementCsvRecord[]>(accountIds.map((id) => [id, []]));
  for (const row of records) {
    const accountId = resolveMasterAccountIdForImportCardLast4(cardLast4FromParsedRow(row));
    if (accountId == null || !allowed.has(accountId)) continue;
    byAccount.get(accountId)!.push(row);
  }
  return byAccount;
}

export function applyParsedCcStatements(
  records: readonly CcStatementCsvRecord[],
  opts: ApplyParsedCcStatementsOptions
): CardParsedStatementsApplyDetails {
  const report: string[] = [];
  const problems: string[] = [];
  const { accountIds, discovery } = resolveImportAccountIds({
    records: [...records],
    accountId: opts.accountId,
    groupSlug: opts.groupSlug,
  });
  if (accountIds.length === 0) {
    problems.push(
      "no card account takes any line: lines need a card_last4 (or a last4 in source_pdf) a card account carries" +
        (discovery.unknownLast4.length > 0 ? ` (unknown: ${discovery.unknownLast4.join(", ")})` : "")
    );
    return { applied: false, accounts: [], report, problems };
  }
  for (const id of accountIds) {
    if (!db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(id)) throw new Error(`Account ${id} not found.`);
  }
  report.push(`# import targets (${accountIds.length}): ${accountIds.map((id) => `${id} (${accountLabelForId(id)})`).join("; ")}`);
  if (discovery.unknownLast4.length > 0) {
    const skipped = records.filter((row) => discovery.unknownLast4.includes(cardLast4FromParsedRow(row))).length;
    problems.push(
      `${skipped} line(s) carry a card no account takes (last4 ${discovery.unknownLast4.join(", ")}) — add a consolidation redirect or the card's account`
    );
  }
  if (discovery.rowsWithoutCard > 0) report.push(`# lines without a card_last4 / source_pdf last4: ${discovery.rowsWithoutCard}`);
  const write = !opts.dryRun && problems.length === 0;

  const byAccount = partitionParsedRecordsByAccount(records, accountIds);
  const accounts: CardParsedStatementsApplyDetails["accounts"] = [];
  const runLog: CcStatementImportAccountLog[] = [];
  for (const accountId of accountIds) {
    const accountRecords = byAccount.get(accountId) ?? [];
    if (accountRecords.length === 0) {
      report.push(`# skip account ${accountId}: no lines for this card`);
      continue;
    }
    const row = {
      account_id: accountId,
      label: accountLabelForId(accountId),
      statements_unchanged: 0,
      statements_imported: 0,
      lines_inserted: 0,
      lines_skipped_duplicate: 0,
      lines_skipped_installment_overlap: 0,
      purchase_upserts: 0,
      payment_upserts: 0,
    };
    const filtered = opts.full
      ? { changed: accountRecords, skippedKeys: [] as string[] }
      : filterUnchangedStatementRecords(accountId, accountRecords);
    row.statements_unchanged = filtered.skippedKeys.length;
    if (filtered.changed.length === 0) {
      report.push(`# account ${accountId}: all ${row.statements_unchanged} statement(s) unchanged — skipped`);
      accounts.push(row);
      continue;
    }
    row.statements_imported = groupRecordsByStatement(filtered.changed as never).size;
    if (row.statements_unchanged > 0) {
      report.push(`# account ${accountId}: ${row.statements_unchanged} statement(s) unchanged, importing ${row.statements_imported}`);
    }

    let statementsMerged = 0;
    if (write) {
      const merged = mergeCcAccountFromParsedRows(accountId, filtered.changed, {
        replaceLedger: false,
        replaceStatementKeys: replaceStatementKeysFromRecords(filtered.changed),
      });
      statementsMerged = merged.statements.statementCount;
      row.lines_inserted = merged.statements.linesInserted;
      row.lines_skipped_duplicate = merged.statements.linesSkippedDuplicate;
      row.lines_skipped_installment_overlap = merged.statements.linesSkippedInstallmentOverlap;
      row.purchase_upserts = merged.ledger.purchaseUpserts;
      row.payment_upserts = merged.ledger.paymentUpserts;
      const rk = merged.expense_line_rekey;
      const rkMoved = Object.values(rk.moved).reduce((a, b) => a + b, 0);
      if (rkMoved + rk.duplicates_removed + rk.conflicts.length + rk.unpaired.length > 0) {
        report.push(
          `# account ${accountId}: expense assignments carried to re-imported lines: ` +
            `${JSON.stringify(rk.moved)}, duplicates removed ${rk.duplicates_removed}, ` +
            `conflicts ${rk.conflicts.length}, unpaired ${rk.unpaired.length}`
        );
        for (const c of rk.conflicts) report.push(`#   conflict ${c.table} ${c.from} → ${c.to}: stored ${String(c.stored)} vs ${String(c.current)}`);
        for (const u of rk.unpaired) report.push(`#   unpaired (${u.reason}) line ${u.lineId} ${u.parserRowId ?? ""}`);
      }
      report.push(
        `Account ${accountId}: ${row.purchase_upserts} purchases, ${row.payment_upserts} payments, statements ${merged.statements.statementCount} ` +
          `(${row.lines_inserted} lines), categories restored ${merged.statements.categoriesRestored}, gap-fill ${merged.ledger.gapFilled}, ` +
          `valuations ${merged.ledger.valuationMonthsSynced}, billing ${merged.ledger.billingSnapshots}.`
      );
    } else {
      const chains = groupInstallmentLoanChains(filtered.changed);
      row.purchase_upserts = chains.size;
      for (const chain of chains.values()) {
        row.payment_upserts += new Set(chain.rows.map((r) => `${r.source_pdf}\t${r.statement_date}`)).size;
      }
      report.push(`[dry-run] account ${accountId}: ~${row.purchase_upserts} purchases, ~${row.payment_upserts} payments, ${filtered.changed.length} line(s) to import`);
    }
    runLog.push(
      buildCcStatementImportAccountLog(accountId, row.label, accountRecords, {
        statements_merged: statementsMerged,
        lines_inserted: row.lines_inserted,
        lines_skipped_duplicate: row.lines_skipped_duplicate,
        lines_skipped_installment_overlap: row.lines_skipped_installment_overlap,
        purchase_upserts: row.purchase_upserts,
        payment_upserts: row.payment_upserts,
      })
    );
    accounts.push(row);
  }
  if (runLog.length > 0 && write) logCcStatementImportRun({ dry_run: false, accounts: runLog });
  return { applied: write, accounts, report, problems };
}
