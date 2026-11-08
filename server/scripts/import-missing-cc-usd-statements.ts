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
import { readCommaCsvRecords } from "./lib/ccParsedCommaCsv.js";
import { canonicalStatementsFromParsedRecords, type CardCanonicalStatement } from "nw-tracker-contracts";
import { cardAccountForStatement } from "../src/cards/documentAccount.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import { importCcStatementsMerge } from "../src/ccStatementsImport.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
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

function usdStatementExistsOnAccount(accountId: number, statement: CardCanonicalStatement): boolean {
  const cardGroup = statement.card_group.trim() || "A";
  const sourcePdf = statement.document;
  const statementDate = statement.close;
  const cardLast4 = statement.card_last4;
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

function resolveAccountIdForUsdStatement(statement: CardCanonicalStatement, fallbackLast4: string | undefined): number | null {
  const id = cardAccountForStatement(statement);
  if (id != null) return id;
  return fallbackLast4 ? resolveMasterAccountIdForImportCardLast4(fallbackLast4) : null;
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
  const usdStatements = canonicalStatementsFromParsedRecords(readCommaCsvRecords(csvPath)).filter(
    (st) => st.currency === "usd"
  );
  if (usdStatements.length === 0) {
    console.log("No USD rows in parsed CSV.");
    return;
  }

  let statementsToImport = 0;
  let rowsToImport = 0;
  const byAccount = new Map<number, CardCanonicalStatement[]>();
  const skippedNoAccount: string[] = [];

  for (const statement of usdStatements) {
    const accountId = resolveAccountIdForUsdStatement(statement, fallbackLast4);
    if (accountId == null) {
      skippedNoAccount.push(statement.document || statement.close);
      continue;
    }
    if (usdStatementExistsOnAccount(accountId, statement)) continue;
    statementsToImport += 1;
    rowsToImport += statement.lines.length;
    const list = byAccount.get(accountId) ?? [];
    list.push(statement);
    byAccount.set(accountId, list);
  }

  console.log(
    `# USD statements in CSV: ${usdStatements.length}; missing in DB: ${statementsToImport} (${rowsToImport} lines)`
  );
  if (skippedNoAccount.length > 0) {
    console.warn(
      `# Skipped (no account / last4): ${skippedNoAccount.length} — use --fallback-last4=<master last4> for legacy PDFs`
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
