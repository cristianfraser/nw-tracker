/**
 * Upsert installment purchases + payments from `cfraser/cc-statements-parsed-all.csv` into SQLite.
 *
 * Usage (from repo root or server/):
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts [--csv=/abs/path.csv] [--dry-run]
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts --santander [--csv=...] [--dry-run]
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts --account-id=NN [--csv=...] [--dry-run]
 *
 * By default, master accounts are inferred from each row's `card_last4` or `source_pdf`
 * (e.g. `… tarjeta <last4>.pdf`). No account id is required when the CSV only contains known cards.
 *
 * Default: **merge** — upsert statements/lines and installment ledger without wiping existing months.
 * **Incremental by default**: a statement whose parsed rows are unchanged since its last import
 * is skipped entirely — no re-import, no re-reconcile (`ccStatementFingerprint.ts`). Pass
 * `--full` to force every statement through again, which is the periodic from-scratch
 * reconciliation and is worth running deliberately after any parser change.
 *
 * Pass `--wipe` to delete all statements and reload the installment ledger for the account(s).
 * Pass `--replace-ledger` to refresh installment purchases/payments only (statements kept).
 *
 * Requires migration `020_cc_installment_ledger.sql` applied (`npm run migrate`).
 *
 * With `--wipe`, replaces all `cc_installment_*` rows for the given account (full reload from CSV),
 * after merging duplicate PDF contracts that shared different `canonical_row_id` (same tarjeta,
 * misma fecha de compra, mismo comercio, mismo nº de cuotas; el monto del contrato se toma como el máximo entre
 * `amount_clp`, `monto_origen_operacion_clp` y `monto_total_a_pagar_clp` para alinear filas resumen «03 CUOTAS COMERC» con cuotas sueltas).
 *
 * After a successful load, upserts month-end `valuations` for this account from the same PDF-derived
 * balances (so Liabilities / patrimonio charts read `valuations`, not a separate runtime series).
 */
import path from "node:path";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { applyParsedCcStatements } from "../src/ccParsedStatementsApply.js";
import { importCcStatementsFromCsvRecords } from "../src/ccStatementsImport.js";
import {
  groupInstallmentLoanChains,
  mergeInstallmentLedgerFromParsedRows,
} from "../src/ccInstallmentLedgerMerge.js";
import { relinkCcTraspasoDeudaLinksForAccount } from "../src/ccTraspasoDeudaLinks.js";
import {
  assertCcPaymentEvidenceKept,
  ccPaymentPairingIdsWithEvidence,
} from "../src/ccPaymentMirrorEvidence.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { cardLast4FromParsedRow, resolveImportAccountIds } from "../src/ccParsedImportAccounts.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import {
  buildCcStatementImportAccountLog,
  logCcStatementImportRun,
  type CcStatementImportAccountLog,
} from "../src/ccStatementImportLog.js";


function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return undefined;
  return hit.slice(p.length);
}

function partitionRecordsByAccount(
  records: Record<string, string>[],
  accountIds: number[]
): Map<number, Record<string, string>[]> {
  const allowed = new Set(accountIds);
  const byAcc = new Map<number, Record<string, string>[]>();
  for (const id of accountIds) byAcc.set(id, []);

  for (const row of records) {
    const l4 = cardLast4FromParsedRow(row);
    const accId = resolveMasterAccountIdForImportCardLast4(l4);
    if (accId == null || !allowed.has(accId)) continue;
    byAcc.get(accId)!.push(row);
  }
  return byAcc;
}

function logAccountRouting(
  discovery: ReturnType<typeof resolveImportAccountIds>["discovery"],
  accountIds: number[],
  records: Record<string, string>[],
  dry: boolean
): void {
  const notes = accountIds.map((id) => {
    const row = db
      .prepare(`SELECT name, notes FROM accounts WHERE id = ?`)
      .get(id) as { name: string; notes: string | null } | undefined;
    const m = /credit_card_master\|[^|]+\|(\d{4})/.exec(String(row?.notes ?? ""));
    const l4 = m?.[1] ?? "?";
    return `${id} (${l4} ${row?.name ?? ""})`.trim();
  });
  console.log(`# import targets (${accountIds.length}): ${notes.join("; ")}`);
  if (discovery.unknownLast4.length > 0) {
    console.warn(
      `# CSV rows skipped — no master account for last4: ${discovery.unknownLast4.join(", ")}`
    );
    const skippedRows = records.filter((row) => {
      const l4 = cardLast4FromParsedRow(row);
      return l4 && discovery.unknownLast4.includes(l4);
    }).length;
    if (skippedRows > 0 && !dry) {
      console.error(
        `# FAIL: ${skippedRows} CSV row(s) skipped for unknown last4 — add ccConsolidatedCards redirect or master account, then re-run.`
      );
      process.exit(1);
    }
  }
  if (discovery.rowsWithoutCard > 0) {
    console.warn(`# CSV rows skipped — missing card_last4 / source_pdf last4: ${discovery.rowsWithoutCard}`);
  }
}

function accountLabelForId(accountId: number): string {
  const row = db
    .prepare(`SELECT name, notes FROM accounts WHERE id = ?`)
    .get(accountId) as { name: string; notes: string | null } | undefined;
  const m = /credit_card_master\|[^|]+\|(\d{4})/.exec(String(row?.notes ?? ""));
  const l4 = m?.[1] ?? "?";
  return `${l4} ${row?.name ?? ""}`.trim();
}

function main() {
  const santander = process.argv.includes("--santander");
  const accountIdArg = Number(arg("account-id"));
  const dry = process.argv.includes("--dry-run");
  const wipe = process.argv.includes("--wipe");
  /** Re-import and re-reconcile every statement, ignoring fingerprints (periodic sanity check). */
  const fullReimport = process.argv.includes("--full");
  const replaceLedgerOnly = process.argv.includes("--replace-ledger");
  if (process.argv.includes("--merge")) {
    console.warn("# --merge is the default since 2026-05; flag is optional.");
  }
  if (wipe && replaceLedgerOnly) {
    console.error("Use either --wipe or --replace-ledger, not both.");
    process.exit(1);
  }
  const replaceAccount = wipe;
  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

  const records = readCommaCsvRecords(csvPath);
  if (records.length === 0) {
    console.error(`No rows read from ${csvPath}`);
    process.exit(1);
  }

  const accountIdFilter =
    Number.isFinite(accountIdArg) && accountIdArg > 0 ? accountIdArg : undefined;

  // The merge (default) is the same apply the nightly reaches through ingest
  // (`card.parsed_statements`); this script keeps it for manual runs and the two reload modes.
  if (!wipe && !replaceLedgerOnly) {
    const details = applyParsedCcStatements(records, {
      dryRun: dry,
      full: fullReimport,
      accountId: accountIdFilter,
      groupSlug: santander ? "santander" : undefined,
    });
    for (const line of details.report) console.log(line);
    for (const problem of details.problems) console.error(`# FAIL: ${problem}`);
    process.exit(details.problems.length > 0 ? 1 : 0);
  }

  const { accountIds, discovery } = resolveImportAccountIds({
    records,
    accountId: accountIdFilter,
    groupSlug: santander ? "santander" : undefined,
  });

  if (accountIds.length === 0) {
    console.error(
      "No master accounts to import. CSV rows need card_last4 or a last4 in source_pdf, matching a configured card."
    );
    if (discovery.unknownLast4.length > 0) {
      console.error(`Unknown last4 in CSV: ${discovery.unknownLast4.join(", ")}`);
    }
    process.exit(1);
  }

  for (const id of accountIds) {
    const acc = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(id) as { id: number } | undefined;
    if (!acc) {
      console.error(`Account ${id} not found.`);
      process.exit(1);
    }
  }

  if (!dry) {
    console.log(
      `# import-cc-parsed mode: ${wipe ? "wipe (full account reload)" : replaceLedgerOnly ? "replace-ledger (installment ledger only)" : "merge (default)"}`
    );
    logAccountRouting(discovery, accountIds, records, dry);
  }

  const byAccountRecords = partitionRecordsByAccount(records, accountIds);

  let totalPurchases = 0;
  let totalPayments = 0;
  let totalStatements = 0;
  let totalLines = 0;
  let totalGap = 0;
  let totalVal = 0;
  let totalBilling = 0;
  let totalCategoriesRestored = 0;
  const importRunAccounts: CcStatementImportAccountLog[] = [];

  for (const accountId of accountIds) {
    const accountRecords = byAccountRecords.get(accountId) ?? [];
    if (accountRecords.length === 0 && !dry) {
      console.warn(`# skip account ${accountId}: no CSV rows for this card`);
      continue;
    }

    let purchaseUpserts = 0;
    let paymentUpserts = 0;
    let gapFilled = 0;
    let valuationMonthsSynced = 0;
    let statementCount = 0;
    let statementLineCount = 0;
    let categoriesRestored = 0;
    let billingSnapshots = 0;
    let linesSkippedDuplicate = 0;
    let linesSkippedInstallmentOverlap = 0;

    if (!dry) {
      if (replaceAccount) {
        // One transaction, so a reload that drops a converted payment's evidence (new statement
        // and line ids are fine — the pairing finds its payment by card, date and amount) rolls
        // back instead of leaving the account wiped.
        const st = db.transaction(() => {
          const pairedWithEvidence = ccPaymentPairingIdsWithEvidence(accountId);
          const reloaded = importCcStatementsFromCsvRecords(accountId, accountRecords);
          relinkCcTraspasoDeudaLinksForAccount(accountId);
          assertCcPaymentEvidenceKept(accountId, pairedWithEvidence, "the --wipe reload");
          return reloaded;
        })();
        statementCount = st.statementCount;
        statementLineCount = st.linesInserted;
        linesSkippedDuplicate = st.linesSkippedDuplicate;
        linesSkippedInstallmentOverlap = st.linesSkippedInstallmentOverlap;
        categoriesRestored += st.categoriesRestored;
        const ledger = mergeInstallmentLedgerFromParsedRows(accountId, accountRecords, {
          replaceLedger: true,
        });
        purchaseUpserts = ledger.purchaseUpserts;
        paymentUpserts = ledger.paymentUpserts;
        gapFilled = ledger.gapFilled;
        valuationMonthsSynced = ledger.valuationMonthsSynced;
        billingSnapshots = ledger.billingSnapshots;
      } else if (replaceLedgerOnly) {
        const ledger = mergeInstallmentLedgerFromParsedRows(accountId, accountRecords, {
          replaceLedger: true,
        });
        purchaseUpserts = ledger.purchaseUpserts;
        paymentUpserts = ledger.paymentUpserts;
        gapFilled = ledger.gapFilled;
        valuationMonthsSynced = ledger.valuationMonthsSynced;
        billingSnapshots = ledger.billingSnapshots;
      }
    } else {
      const chains = groupInstallmentLoanChains(accountRecords);
      purchaseUpserts = chains.size;
      for (const chain of chains.values()) {
        paymentUpserts += new Set(chain.rows.map((r) => `${r.source_pdf}\t${r.statement_date}`)).size;
      }
    }

    importRunAccounts.push(
      buildCcStatementImportAccountLog(accountId, accountLabelForId(accountId), accountRecords, {
        statements_merged: statementCount,
        lines_inserted: statementLineCount,
        lines_skipped_duplicate: linesSkippedDuplicate,
        lines_skipped_installment_overlap: linesSkippedInstallmentOverlap,
        purchase_upserts: purchaseUpserts,
        payment_upserts: paymentUpserts,
      })
    );

    console.log(
      dry
        ? `[dry-run] account ${accountId}: ~${purchaseUpserts} purchases, ~${paymentUpserts} payments, ${accountRecords.length} csv rows`
        : `Account ${accountId}: ${purchaseUpserts} purchases, ${paymentUpserts} payments, statements ${statementCount} (${statementLineCount} lines), categories restored ${categoriesRestored}, gap-fill ${gapFilled}, valuations ${valuationMonthsSynced}, billing ${billingSnapshots}.`
    );

    totalPurchases += purchaseUpserts;
    totalPayments += paymentUpserts;
    totalStatements += statementCount;
    totalLines += statementLineCount;
    totalGap += gapFilled;
    totalVal += valuationMonthsSynced;
    totalBilling += billingSnapshots;
    totalCategoriesRestored += categoriesRestored;
  }

  if (importRunAccounts.length > 0) {
    logCcStatementImportRun({ dry_run: dry, accounts: importRunAccounts });
  }

  if (accountIds.length > 1) {
    console.log(
      dry
        ? `[dry-run] total: ~${totalPurchases} purchases, ~${totalPayments} payments from ${csvPath}`
        : `Import done (${accountIds.length} cards): ${totalPurchases} purchases, ${totalPayments} payments, ${totalStatements} statements (${totalLines} lines), categories restored ${totalCategoriesRestored}, gap-fill ${totalGap}, valuations ${totalVal}, billing ${totalBilling}.`
    );
  }
}

main();
