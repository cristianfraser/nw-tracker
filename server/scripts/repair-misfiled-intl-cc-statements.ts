/**
 * Move international CC PDFs out of `clp/` folders, re-parse, reconcile, and re-import.
 *
 *   npx tsx server/scripts/repair-misfiled-intl-cc-statements.ts
 *   npx tsx server/scripts/repair-misfiled-intl-cc-statements.ts --dry-run
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import {
  mergeInstallmentLedgerFromParsedRows,
  replaceStatementKeysFromRecords,
} from "../src/ccInstallmentLedgerMerge.js";
import { currencyFromRow, importCcStatementsMerge } from "../src/ccStatementsImport.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { resolveCfraserPdfsDir } from "../src/cfraserPaths.js";
import { db } from "../src/db.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PARSE_SCRIPT = path.join(REPO_ROOT, "server", "scripts", "parse-cc-statement-pdfs.py");

const REPAIRS: { relFrom: string; usdBasename: string }[] = [
  {
    relFrom: "4141/clp/2021-02-22 estado de cuenta tarjeta 4141.pdf",
    usdBasename: "2021-02-22 estado de cuenta tarjeta usd 4141.pdf",
  },
  {
    relFrom: "4141/clp/2025-05-22 estado de cuenta tarjeta 4141.pdf",
    usdBasename: "2025-05-22 estado de cuenta tarjeta usd 4141.pdf",
  },
  {
    relFrom: "4113/clp/2018-01-24 estado de cuenta tarjeta 4113.pdf",
    usdBasename: "2018-01-24 estado de cuenta tarjeta usd 4113.pdf",
  },
  {
    relFrom: "4112/clp/2025-08-25 estado de cuenta tarjeta 4112.pdf",
    usdBasename: "2025-08-25 estado de cuenta tarjeta usd 4112.pdf",
  },
];

/** Legacy `legacy/clp` imports often lack `card_last4` but share dedupe keys with the real USD PDF. */
function deleteLegacyUsdDuplicatesForClose(
  accountId: number,
  periodTo: string,
  cardLast4: string
): number {
  const rows = db
    .prepare(
      `SELECT id FROM cc_statements
       WHERE account_id = ? AND currency = 'usd' AND period_to = ?
         AND COALESCE(card_last4, '') != ?`
    )
    .all(accountId, periodTo, cardLast4) as { id: number }[];
  if (rows.length === 0) return 0;
  const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`);
  const delStmt = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const { id } of rows) {
      delLines.run(id);
      delStmt.run(id);
    }
  });
  tx();
  recomputeCcBillingMonthBalances(accountId);
  return rows.length;
}

function deleteStatementsBySourcePdf(sourcePdf: string): number {
  const ids = db
    .prepare(`SELECT id, account_id FROM cc_statements WHERE source_pdf = ?`)
    .all(sourcePdf) as { id: number; account_id: number }[];
  if (ids.length === 0) return 0;
  const delLines = db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`);
  const delStmt = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);
  const touched = new Set<number>();
  const tx = db.transaction(() => {
    for (const { id, account_id } of ids) {
      delLines.run(id);
      delStmt.run(id);
      touched.add(account_id);
    }
  });
  tx();
  for (const accountId of touched) {
    recomputeCcBillingMonthBalances(accountId);
  }
  return ids.length;
}

function runParseInDir(pdfDir: string, outCsv: string): void {
  const r = spawnSync("python3", [PARSE_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CFRASER_PDFS_DIR: pdfDir,
      CC_PARSE_OUTPUT_CSV: outCsv,
    },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(r.stderr?.trim() || r.stdout?.trim() || `parse exit ${r.status}`);
  }
  if (!fs.existsSync(outCsv)) {
    throw new Error("parse produced no CSV");
  }
}

function assertParseReconcileOk(outCsv: string, pdfDir: string): void {
  const r = spawnSync(
    "python3",
    [path.join(REPO_ROOT, "server", "scripts", "check-cc-statement-parse.py")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CFRASER_PDFS_DIR: pdfDir,
        CC_PARSE_OUTPUT_CSV: outCsv,
      },
      encoding: "utf8",
    }
  );
  if (r.status !== 0) {
    throw new Error(
      `parse reconcile check failed:\n${r.stderr?.trim() || r.stdout?.trim() || ""}`
    );
  }
}

function main(): void {
  loadRootDotenv();
  const dryRun = process.argv.includes("--dry-run");
  const ccRoot = resolveCfraserPdfsDir();

  for (const { relFrom, usdBasename } of REPAIRS) {
    const card = relFrom.split("/")[0]!;
    const dest = path.join(ccRoot, card, "usd", usdBasename);
    const clpName = path.basename(relFrom);
    const src = path.join(ccRoot, relFrom);
    const pdfPath = fs.existsSync(src) ? src : fs.existsSync(dest) ? dest : null;
    if (!pdfPath) {
      console.warn(`skip (missing): ${relFrom}`);
      continue;
    }
    const oldUsdName = usdBasename;

    console.log(`\n=== ${clpName} ===`);
    if (dryRun) {
      console.log(`  would move -> ${path.relative(ccRoot, dest)}`);
      console.log(`  would delete/reimport statements for: ${clpName}`);
      continue;
    }

    for (const name of [clpName, oldUsdName, usdBasename]) {
      const n = deleteStatementsBySourcePdf(name);
      if (n > 0) console.log(`  deleted ${n} statement row(s) for source_pdf=${name}`);
    }

    if (pdfPath !== dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(pdfPath, dest);
      console.log(`  moved -> ${card}/usd/${usdBasename}`);
    } else {
      console.log(`  already at ${card}/usd/${usdBasename}`);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nw-intl-cc-"));
    const outCsv = path.join(tmp, "parsed.csv");
    try {
      fs.copyFileSync(dest, path.join(tmp, usdBasename));
      runParseInDir(tmp, outCsv);
      assertParseReconcileOk(outCsv, tmp);

      const records = readCommaCsvRecords(outCsv).filter(
        (row) => currencyFromRow(row) === "usd"
      );
      if (records.length === 0) {
        throw new Error("no USD rows in parse output");
      }
      const last4 = String(records[0]!.card_last4 ?? "").trim();
      const accountId = resolveMasterAccountIdForImportCardLast4(last4);
      if (accountId == null) {
        throw new Error(`no master account for card_last4=${last4}`);
      }
      for (const row of records) {
        row.source_pdf = usdBasename;
      }
      const periodTo = String(records[0]?.period_to ?? "").trim();
      const cardLast4 = String(records[0]?.card_last4 ?? "").trim();
      if (periodTo && cardLast4) {
        const dup = deleteLegacyUsdDuplicatesForClose(accountId, periodTo, cardLast4);
        if (dup > 0) {
          console.log(`  removed ${dup} legacy USD duplicate(s) for period_to=${periodTo}`);
        }
      }

      const replaceKeys = replaceStatementKeysFromRecords(records);
      const statements = importCcStatementsMerge(accountId, records, {
        replaceStatementKeys: replaceKeys,
        skipGlobalDedupeKeys: true,
      });
      const ledger = mergeInstallmentLedgerFromParsedRows(accountId, records, {
        replaceLedger: false,
      });
      recomputeCcBillingMonthBalances(accountId);
      console.log(
        `  imported account ${accountId}: ${statements.statementCount} stmt, ` +
          `${statements.linesInserted} lines (ledger purchases ${ledger.purchaseUpserts})`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(dryRun ? "\n(dry-run, no changes)" : "\nDone.");
}

main();
