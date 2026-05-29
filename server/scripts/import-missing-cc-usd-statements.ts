/**
 * Parse CC PDFs (incremental) and merge-import **only** USD statements missing from SQLite.
 * Does not wipe accounts or replace existing CLP statements.
 *
 *   npm run db:snapshot -w nw-tracker-server -- --label=before-cc-usd-import
 *   npm run repair:cc-usd-statements -w nw-tracker-server
 *   npm run repair:cc-usd-statements -w nw-tracker-server -- --dry-run
 *   npm run repair:cc-usd-statements -w nw-tracker-server -- --skip-parse
 *
 * Root cause this fixes: parser skipped `… (2).pdf` USD files; import merged USD into CLP rows
 * via `findStmtByClose` without matching `currency` (fixed in ccStatementsImport.ts).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import {
  cardLast4FromParsedRow,
  resolveImportAccountIds,
} from "../src/ccParsedImportAccounts.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import {
  currencyFromRow,
  importCcStatementsMerge,
  statementKeyFromRow,
  type CcStatementCsvRecord,
} from "../src/ccStatementsImport.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

function isUsdStatementRow(row: CcStatementCsvRecord): boolean {
  return currencyFromRow(row) === "usd";
}

const findStmtByPdf = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?
     AND currency = 'usd'`
);

const findStmtByCloseUsd = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND statement_date = ?
     AND COALESCE(card_last4, '') = COALESCE(?, '')
     AND currency = 'usd'`
);

function usdStatementExistsOnAccount(accountId: number, first: CcStatementCsvRecord): boolean {
  const cardGroup = String(first.card_group ?? "A").trim() || "A";
  const sourcePdf = String(first.source_pdf ?? "").trim();
  const statementDate = String(first.statement_date ?? "").trim();
  const cardLast4 = String(first.card_last4 ?? "").trim() || null;
  if (
    findStmtByPdf.get(accountId, cardGroup, sourcePdf, statementDate) as { id: number } | undefined
  ) {
    return true;
  }
  return Boolean(
    findStmtByCloseUsd.get(accountId, cardGroup, statementDate, cardLast4) as
      | { id: number }
      | undefined
  );
}

function runParseCcPdfs(): void {
  console.log("\n=== parse:cc-pdfs (incremental) ===");
  const r = spawnSync("npm", ["run", "parse:cc-pdfs"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`parse:cc-pdfs failed (exit ${r.status ?? "unknown"})`);
  }
}

function resolveAccountIdForUsdRows(
  rows: CcStatementCsvRecord[],
  fallbackLast4: string | undefined
): number | null {
  for (const row of rows) {
    const l4 = cardLast4FromParsedRow(row);
    if (!l4) continue;
    const id = resolveMasterAccountIdForImportCardLast4(l4);
    if (id != null) return id;
  }
  if (fallbackLast4) {
    return resolveMasterAccountIdForImportCardLast4(fallbackLast4);
  }
  return null;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const skipParse = process.argv.includes("--skip-parse");
  const fallbackLast4 = arg("fallback-last4");

  if (!skipParse && !dryRun) {
    runParseCcPdfs();
  } else if (!skipParse && dryRun) {
    console.log("[dry-run] Would run parse:cc-pdfs");
  }

  const csvPath = arg("csv") ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");
  const allRecords = readCommaCsvRecords(csvPath);
  const usdRecords = allRecords.filter(isUsdStatementRow);
  if (usdRecords.length === 0) {
    console.log("No USD rows in parsed CSV.");
    return;
  }

  const byStmtKey = new Map<string, CcStatementCsvRecord[]>();
  for (const row of usdRecords) {
    const k = statementKeyFromRow(row);
    const list = byStmtKey.get(k) ?? [];
    list.push(row);
    byStmtKey.set(k, list);
  }

  const { accountIds } = resolveImportAccountIds({ records: usdRecords });
  const allowedAccounts = new Set(accountIds);

  let statementsToImport = 0;
  let rowsToImport = 0;
  const pending: CcStatementCsvRecord[] = [];
  const skippedNoAccount: string[] = [];

  for (const [, rows] of byStmtKey) {
    const first = rows[0]!;
    const accountId = resolveAccountIdForUsdRows(rows, fallbackLast4);
    if (accountId == null || !allowedAccounts.has(accountId)) {
      skippedNoAccount.push(String(first.source_pdf ?? first.statement_date));
      continue;
    }
    if (usdStatementExistsOnAccount(accountId, first)) continue;
    statementsToImport += 1;
    rowsToImport += rows.length;
    pending.push(...rows);
  }

  console.log(
    `# USD statements in CSV: ${byStmtKey.size}; missing in DB: ${statementsToImport} (${rowsToImport} lines)`
  );
  if (skippedNoAccount.length > 0) {
    console.warn(
      `# Skipped (no account / last4): ${skippedNoAccount.length} — use --fallback-last4=4242 for legacy PDFs`
    );
    for (const s of skippedNoAccount.slice(0, 8)) {
      console.warn(`  ${s}`);
    }
  }

  if (statementsToImport === 0) {
    console.log("Nothing to import.");
    return;
  }

  if (dryRun) {
    console.log("[dry-run] Would import missing USD statements only (merge, no wipe).");
    return;
  }

  const byAccount = new Map<number, CcStatementCsvRecord[]>();
  for (const row of pending) {
    const accountId = resolveAccountIdForUsdRows([row], fallbackLast4);
    if (accountId == null) continue;
    const list = byAccount.get(accountId) ?? [];
    list.push(row);
    byAccount.set(accountId, list);
  }

  let totalInserted = 0;
  const touchedAccounts = new Set<number>();

  for (const [accountId, records] of byAccount) {
    const r = importCcStatementsMerge(accountId, records, {
      replaceAll: false,
      skipGlobalDedupeKeys: true,
    });
    totalInserted += r.linesInserted;
    touchedAccounts.add(accountId);
    console.log(
      `Account ${accountId}: +${r.linesInserted} line(s), ${r.statementCount} statement batch(es), dup skip ${r.linesSkippedDuplicate}`
    );
  }

  for (const accountId of touchedAccounts) {
    recomputeCcBillingMonthBalances(accountId);
  }

  const usdCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM cc_statements WHERE currency = 'usd'`).get() as {
      c: number;
    }
  ).c;
  console.log(`Done. Inserted ${totalInserted} line(s). USD statements in DB: ${usdCount}.`);
}

main();
