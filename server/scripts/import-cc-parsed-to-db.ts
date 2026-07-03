/**
 * Upsert installment purchases + payments from `cfraser/cc-statements-parsed-all.csv` into SQLite.
 *
 * Usage (from repo root or server/):
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts [--csv=/abs/path.csv] [--dry-run]
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts --santander [--csv=...] [--dry-run]
 *   npx tsx server/scripts/import-cc-parsed-to-db.ts --account-id=NN [--csv=...] [--dry-run]
 *
 * By default, master accounts are inferred from each row's `card_last4` or `source_pdf`
 * (e.g. `… tarjeta 4141.pdf`). No account id is required when the CSV only contains known cards.
 *
 * Default: **merge** — upsert statements/lines and installment ledger without wiping existing months.
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
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { importCcStatementsFromCsvRecords } from "../src/ccStatementsImport.js";
import {
  mergeCcAccountFromParsedRows,
  mergeInstallmentLedgerFromParsedRows,
  replaceStatementKeysFromRecords,
} from "../src/ccInstallmentLedgerMerge.js";
import { isInstallmentContractSummaryMerchant } from "../src/ccInstallmentLineDedupe.js";
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

function parseInt10(s: string): number | null {
  const n = Number(String(s ?? "").replace(/\s+/g, "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** Full contract principal (cuota única vs total operación en filas resumen del PDF). */
function installmentContractAmountClp(row: Record<string, string>): number {
  const a = parseInt10(String(row.amount_clp ?? "")) ?? 0;
  const b = parseInt10(String(row.monto_origen_operacion_clp ?? "")) ?? 0;
  const c = parseInt10(String(row.monto_total_a_pagar_clp ?? "")) ?? 0;
  return Math.max(a, b, c);
}

type Agg = {
  card_group: string;
  canonical_row_id: string;
  rows: Record<string, string>[];
};

/** One physical installment contract (Visa/Master may emit different canonical_row_id per statement). */
function makeLoanKey(row: Record<string, string>): string | null {
  const cg = String(row.card_group ?? "A").trim() || "A";
  const iso = txDateIso(row);
  const amt = installmentContractAmountClp(row);
  const nt = parseInt10(String(row.nro_cuota_total ?? ""));
  if (!iso || amt <= 0 || nt == null || nt <= 0) return null;
  const merch =
    String(row.merchant ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 96) ||
    String(row.description_merged ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 96);
  if (!merch) return null;
  return `${cg}\t${iso}\t${amt}\t${nt}\t${merch}`;
}

function pickCanonicalForLoan(rows: Record<string, string>[]): string {
  const ids = [
    ...new Set(
      rows
        .map((r) => String(r.canonical_row_id ?? "").trim())
        .filter(Boolean)
    ),
  ].sort();
  return ids[0] ?? "unknown";
}

function stmtSortKey(statementDate: string): number {
  const iso = parseDdMmYyToIso(statementDate);
  if (!iso) return 0;
  return Number(iso.replace(/-/g, ""));
}

function txDateIso(row: Record<string, string>): string | null {
  const raw = String(row.transaction_date ?? row.posting_date ?? "").trim();
  return parseDdMmYyToIso(raw);
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
        const st = importCcStatementsFromCsvRecords(accountId, accountRecords);
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
      } else {
        const merged = mergeCcAccountFromParsedRows(accountId, accountRecords, {
          replaceLedger: false,
          replaceStatementKeys: replaceStatementKeysFromRecords(accountRecords),
        });
        statementCount = merged.statements.statementCount;
        statementLineCount = merged.statements.linesInserted;
        linesSkippedDuplicate = merged.statements.linesSkippedDuplicate;
        linesSkippedInstallmentOverlap = merged.statements.linesSkippedInstallmentOverlap;
        categoriesRestored += merged.statements.categoriesRestored;
        gapFilled = merged.ledger.gapFilled;
        valuationMonthsSynced = merged.ledger.valuationMonthsSynced;
        billingSnapshots = merged.ledger.billingSnapshots;
        purchaseUpserts = merged.ledger.purchaseUpserts;
        paymentUpserts = merged.ledger.paymentUpserts;
      }
    } else {
      const byLoan = new Map<string, Agg>();
      for (const row of accountRecords) {
        const inst = String(row.installment_flag ?? "").toLowerCase() === "true";
        if (!inst) continue;
        if (isInstallmentContractSummaryMerchant(String(row.merchant ?? ""))) continue;
        if (installmentContractAmountClp(row) <= 0) continue;
        const loanKey = makeLoanKey(row);
        if (!loanKey) continue;
        const cg = String(row.card_group ?? "A").trim() || "A";
        const g = byLoan.get(loanKey) ?? { card_group: cg, canonical_row_id: "", rows: [] };
        g.rows.push(row);
        g.canonical_row_id = pickCanonicalForLoan(g.rows);
        byLoan.set(loanKey, g);
      }
      purchaseUpserts = byLoan.size;
      for (const agg of byLoan.values()) {
        const sorted = [...agg.rows].sort(
          (a, b) => stmtSortKey(a.statement_date ?? "") - stmtSortKey(b.statement_date ?? "")
        );
        const payGroups = new Map<string, Record<string, string>[]>();
        for (const r of sorted) {
          const pk = `${r.source_pdf}\t${r.statement_date}`;
          const list = payGroups.get(pk) ?? [];
          list.push(r);
          payGroups.set(pk, list);
        }
        paymentUpserts += payGroups.size;
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
