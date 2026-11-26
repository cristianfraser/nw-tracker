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
 * Pass `--replace-ledger` to refresh installment purchases/payments only (statements kept): it
 * replaces the account's `cc_installment_*` rows from the CSV, after merging duplicate PDF
 * contracts that shared different `canonical_row_id` (same card, purchase day, merchant and cuota
 * count; the contract amount is the largest of `amount_clp`, `monto_origen_operacion_clp` and
 * `monto_total_a_pagar_clp`, so a «03 CUOTAS COMERC» summary row lines up with its single cuotas).
 *
 * There is no statement wipe: a statement import restates the rows on file (`--full` re-plans every
 * statement); deleting the account's statements and importing them again would give every line a
 * new row and flow.
 */
import path from "node:path";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "./lib/ccParsedCommaCsv.js";
import { canonicalStatementsFromParsedRecords, type CardCanonicalStatement } from "nw-tracker-contracts";
import { applyCanonicalCardStatements } from "../src/ccParsedStatementsApply.js";
import {
  groupInstallmentLoanChains,
  mergeInstallmentLedgerFromStatements,
} from "../src/ccInstallmentLedgerMerge.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { cardAccountsForStatements, type CardStatementAccounts } from "../src/cards/documentAccount.js";
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

function logAccountRouting(discovery: CardStatementAccounts, accountIds: number[], dry: boolean): void {
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
    console.warn(`# CSV rows skipped — no master account for last4: ${discovery.unknownLast4.join(", ")}`);
    if (discovery.linesUnknownCard > 0 && !dry) {
      console.error(
        `# FAIL: ${discovery.linesUnknownCard} CSV row(s) skipped for unknown last4 — add ccConsolidatedCards redirect or master account, then re-run.`
      );
      process.exit(1);
    }
  }
  if (discovery.linesWithoutCard > 0) {
    console.warn(`# CSV rows skipped — missing card_last4 / source_pdf last4: ${discovery.linesWithoutCard}`);
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
  /** Re-import and re-reconcile every statement, ignoring fingerprints (periodic sanity check). */
  const fullReimport = process.argv.includes("--full");
  const replaceLedgerOnly = process.argv.includes("--replace-ledger");
  if (process.argv.includes("--merge")) {
    console.warn("# --merge is the default since 2026-05; flag is optional.");
  }
  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

  const records = readCommaCsvRecords(csvPath);
  const statements: CardCanonicalStatement[] = canonicalStatementsFromParsedRecords(records);
  if (records.length === 0) {
    console.error(`No rows read from ${csvPath}`);
    process.exit(1);
  }

  const accountIdFilter =
    Number.isFinite(accountIdArg) && accountIdArg > 0 ? accountIdArg : undefined;

  // The merge (default) is the same apply the nightly reaches through ingest
  // (`card.parsed_statements`); this script keeps it for manual runs and the ledger reload.
  if (!replaceLedgerOnly) {
    const details = applyCanonicalCardStatements(statements, {
      dryRun: dry,
      full: fullReimport,
      accountId: accountIdFilter,
      issuer: santander ? "santander" : undefined,
    });
    for (const line of details.report) console.log(line);
    for (const problem of details.problems) console.error(`# FAIL: ${problem}`);
    process.exit(details.problems.length > 0 ? 1 : 0);
  }

  const discovery = cardAccountsForStatements(statements, {
    accountId: accountIdFilter,
    issuer: santander ? "santander" : undefined,
  });
  const accountIds = discovery.accountIds;

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
      `# import-cc-parsed mode: replace-ledger (installment ledger only)`
    );
    logAccountRouting(discovery, accountIds, dry);
  }


  let totalPurchases = 0;
  let totalPayments = 0;
  let totalGap = 0;
  const importRunAccounts: CcStatementImportAccountLog[] = [];

  for (const accountId of accountIds) {
    const accountRecords = discovery.byAccount.get(accountId) ?? [];
    const accountLineCount = accountRecords.reduce((n, st) => n + st.lines.length, 0);
    if (accountLineCount === 0 && !dry) {
      console.warn(`# skip account ${accountId}: no CSV rows for this card`);
      continue;
    }

    let purchaseUpserts = 0;
    let paymentUpserts = 0;
    let gapFilled = 0;

    if (!dry) {
      const ledger = mergeInstallmentLedgerFromStatements(accountId, accountRecords, {
        replaceLedger: true,
      });
      purchaseUpserts = ledger.purchaseUpserts;
      paymentUpserts = ledger.paymentUpserts;
      gapFilled = ledger.gapFilled;
    } else {
      const chains = groupInstallmentLoanChains(accountRecords);
      purchaseUpserts = chains.size;
      for (const chain of chains.values()) {
        paymentUpserts += new Set(chain.rows.map((r) => `${r.statement.document}\t${r.statement.close}`)).size;
      }
    }

    importRunAccounts.push(
      buildCcStatementImportAccountLog(accountId, accountLabelForId(accountId), accountRecords, {
        statements_merged: 0,
        lines_inserted: 0,
        lines_restated: 0,
        lines_skipped_duplicate: 0,
        lines_skipped_installment_overlap: 0,
        purchase_upserts: purchaseUpserts,
        payment_upserts: paymentUpserts,
      })
    );

    console.log(
      dry
        ? `[dry-run] account ${accountId}: ~${purchaseUpserts} purchases, ~${paymentUpserts} payments, ${accountLineCount} csv rows`
        : `Account ${accountId}: ${purchaseUpserts} purchases, ${paymentUpserts} payments, gap-fill ${gapFilled}.`
    );

    totalPurchases += purchaseUpserts;
    totalPayments += paymentUpserts;
    totalGap += gapFilled;
  }

  if (importRunAccounts.length > 0) {
    logCcStatementImportRun({ dry_run: dry, accounts: importRunAccounts });
  }

  if (accountIds.length > 1) {
    console.log(
      dry
        ? `[dry-run] total: ~${totalPurchases} purchases, ~${totalPayments} payments from ${csvPath}`
        : `Import done (${accountIds.length} cards): ${totalPurchases} purchases, ${totalPayments} payments, gap-fill ${totalGap}.`
    );
  }
}

main();
