import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import {
  listCheckingCartolaXlsxFiles,
  movementNote,
  parseCheckingCartolaFile,
  type ParsedCheckingCartola,
} from "./checkingCartolaParse.js";
import {
  fileLogFromCartola,
  logCheckingCartolaImportRun,
  type CheckingCartolaFileImportLog,
  type CheckingCartolaImportRunLog,
} from "./checkingCartolaParseLog.js";
import {
  loadCheckingCartolasFromPdfJson,
  pdfEntryToParsedCartola,
  runParseCheckingCartolaPdfs,
} from "./checkingCartolaPdfImport.js";
import {
  clearCheckingAccountValuations,
  clearCheckingBalanceCache,
  ensureCheckingOpeningBalance,
} from "./checkingCartolaBalances.js";
import { loadParsedCheckingCartolasFromScreenshots } from "./checkingCartolaScreenshotImport.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";

export function checkingAccountId(dbHandle: Database = db): number {
  return cartolaCashAccountId("cuenta_corriente", dbHandle);
}

export function isCheckingCartolaMonthImported(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db
): boolean {
  const row = dbHandle
    .prepare(
      `SELECT 1 FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
    )
    .get(accountId, periodMonth);
  return row != null;
}

/** Remove all movements, valuations, and cartola import registry for checking account. */
export function wipeCheckingAccountData(accountId: number, dbHandle: Database = db): {
  movements: number;
  valuations: number;
  imports: number;
} {
  const delMov = dbHandle
    .prepare(
      `DELETE FROM movements WHERE account_id = ? AND note NOT LIKE 'import:checking-synthetic|%'`
    )
    .run(accountId);
  const delVal = dbHandle
    .prepare(`DELETE FROM valuations WHERE account_id = ?`)
    .run(accountId);
  let delImp = { changes: 0 };
  try {
    delImp = dbHandle
      .prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`)
      .run(accountId);
  } catch {
    /* migration 052 not applied yet */
  }
  return {
    movements: delMov.changes,
    valuations: delVal.changes,
    imports: delImp.changes,
  };
}

export function importCheckingCartola(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): { movementsInserted: number; movementsSkipped: number } {
  const insMov = dbHandle.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, NULL)`
  );
  const markImported = dbHandle.prepare(
    `INSERT INTO checking_cartola_imports (
       account_id, period_month, source_file, movement_count,
       saldo_final_clp, saldo_inicial_clp, period_from
     )
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, period_month) DO UPDATE SET
       source_file = excluded.source_file,
       movement_count = excluded.movement_count,
       saldo_final_clp = excluded.saldo_final_clp,
       saldo_inicial_clp = excluded.saldo_inicial_clp,
       period_from = excluded.period_from,
       imported_at = datetime('now')`
  );

  const noteExists = dbHandle.prepare(
    `SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ? LIMIT 1`
  );

  let movementsInserted = 0;
  let movementsSkipped = 0;
  const tx = dbHandle.transaction(() => {
    for (const mv of cartola.movements) {
      const note = movementNote(
        cartola.period_month,
        mv.branch,
        mv.description,
        mv.document_no
      );
      if (noteExists.get(accountId, note)) {
        movementsSkipped += 1;
        continue;
      }
      insMov.run(accountId, mv.amount_clp, mv.occurred_on, note);
      movementsInserted += 1;
    }
    markImported.run(
      accountId,
      cartola.period_month,
      cartola.source_file,
      movementsInserted,
      cartola.saldo_final_clp,
      cartola.saldo_inicial_clp,
      cartola.period_from
    );
  });
  tx();
  clearCheckingBalanceCache(accountId);
  return { movementsInserted, movementsSkipped };
}

export type ImportCheckingCartolasResult = {
  accountId: number;
  wiped: boolean;
  dryRun: boolean;
  log: CheckingCartolaImportRunLog;
  /** @deprecated use log.files */
  filesSkipped: string[];
  /** @deprecated use log.files */
  filesImported: { file: string; periodMonth: string; movements: number }[];
  /** @deprecated use log.files */
  errors: { file: string; error: string }[];
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function logParseError(file: string, e: unknown): CheckingCartolaFileImportLog {
  const msg = errorMessage(e);
  console.error(`  PARSE ERROR ${file}: ${msg}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  return {
    file,
    period_month: "",
    status: "parse_error",
    movements_parsed: 0,
    movements_imported: 0,
    skipped_rows: [],
    saldo_final_clp: null,
    saldo_inicial_clp: null,
    error: msg,
  };
}

export function importCartolaList(
  accountId: number,
  cartolas: { cartola: ParsedCheckingCartola; label: string }[],
  opts: { wipe?: boolean; dryRun?: boolean },
  fileLogs: CheckingCartolaFileImportLog[]
): void {
  for (const { cartola, label } of cartolas) {
    if (!opts.wipe && isCheckingCartolaMonthImported(accountId, cartola.period_month)) {
      fileLogs.push({
        file: label,
        period_month: cartola.period_month,
        status: "skipped_already_imported",
        movements_parsed: cartola.movements.length,
        movements_imported: 0,
        skipped_rows: cartola.skipped,
        saldo_final_clp: cartola.saldo_final_clp,
        saldo_inicial_clp: cartola.saldo_inicial_clp,
      });
      continue;
    }

    if (opts.dryRun) {
      fileLogs.push(
        fileLogFromCartola(label, cartola, {
          status: "dry_run",
          movements_imported: cartola.movements.length,
        })
      );
      continue;
    }

    try {
      const { movementsInserted } = importCheckingCartola(accountId, cartola);
      fileLogs.push(
        fileLogFromCartola(label, cartola, {
          status: "imported",
          movements_imported: movementsInserted,
        })
      );
    } catch (e) {
      fileLogs.push(logParseError(label, e));
    }
  }
}

export function finishCartolaImportRun(
  accountId: number,
  opts: { wipe?: boolean; dryRun?: boolean },
  fileLogs: CheckingCartolaFileImportLog[],
  accountLabel = "cuenta corriente"
): ImportCheckingCartolasResult {
  if (!opts.dryRun && fileLogs.some((f) => f.status === "imported")) {
    const cleared = clearCheckingAccountValuations(accountId);
    if (cleared > 0) {
      console.log(
        `Cleared ${cleared} persisted valuation row(s) for ${accountLabel} (balances computed at runtime).`
      );
    }
    const opening = ensureCheckingOpeningBalance(accountId);
    if (opening.inserted) {
      console.log(
        `Inserted opening balance ${opening.amount_clp} CLP on ${opening.occurred_on} (saldo inicial from earliest cartola).`
      );
    }
  }

  const runLog: CheckingCartolaImportRunLog = {
    account_id: accountId,
    dry_run: !!opts.dryRun,
    wiped: !!opts.wipe,
    files: fileLogs,
  };
  logCheckingCartolaImportRun(runLog);

  return {
    accountId,
    wiped: !!opts.wipe,
    dryRun: !!opts.dryRun,
    log: runLog,
    filesSkipped: fileLogs
      .filter((f) => f.status === "skipped_already_imported")
      .map((f) => f.file),
    filesImported: fileLogs
      .filter((f) => f.status === "imported" || f.status === "dry_run")
      .map((f) => ({
        file: f.file,
        periodMonth: f.period_month,
        movements: f.movements_imported,
      })),
    errors: fileLogs
      .filter((f) => f.status === "parse_error")
      .map((f) => ({ file: f.file, error: f.error ?? "unknown" })),
  };
}

export function importCheckingCartolasFromDir(opts: {
  dir?: string;
  accountId?: number;
  wipe?: boolean;
  dryRun?: boolean;
  pdf?: boolean;
  skipPdfParse?: boolean;
}): ImportCheckingCartolasResult {
  const dir = opts.dir ?? resolveCfraserCheckingCartolasDir();
  const accountId = opts.accountId ?? checkingAccountId();
  const fileLogs: CheckingCartolaFileImportLog[] = [];

  if (opts.wipe && !opts.dryRun) {
    const w = wipeCheckingAccountData(accountId);
    console.log(
      `Wiped cuenta corriente (account ${accountId}): ${w.movements} movement(s), ${w.valuations} valuation(s), ${w.imports} import record(s).`
    );
  } else if (opts.wipe && opts.dryRun) {
    console.log(`[dry-run] Would wipe movements/valuations/imports for account ${accountId}.`);
  }

  const files = listCheckingCartolaXlsxFiles(dir);
  const xlsxCartolas: { cartola: ParsedCheckingCartola; label: string }[] = [];
  for (const filePath of files) {
    const base = filePath.split(/[/\\]/).pop() ?? filePath;
    try {
      xlsxCartolas.push({ cartola: parseCheckingCartolaFile(filePath), label: base });
    } catch (e) {
      fileLogs.push(logParseError(base, e));
    }
  }
  importCartolaList(accountId, xlsxCartolas, opts, fileLogs);

  if (opts.pdf) {
    try {
      if (!opts.skipPdfParse) {
        runParseCheckingCartolaPdfs();
      }
      const pdfData = loadCheckingCartolasFromPdfJson();
      const pdfCartolas: { cartola: ParsedCheckingCartola; label: string }[] = [];
      for (const entry of pdfData.cartolas) {
        const label = `pdf:${entry.source_file}`;
        if (entry.parse_status !== "ok") {
          fileLogs.push({
            file: label,
            period_month: entry.period_month ?? "",
            status: "parse_error",
            movements_parsed: entry.movements?.length ?? 0,
            movements_imported: 0,
            skipped_rows: entry.skipped ?? [],
            saldo_final_clp: entry.saldo_final_clp,
            saldo_inicial_clp: entry.saldo_inicial_clp,
            error: entry.parse_error ?? `PDF ${entry.parse_status}`,
          });
          continue;
        }
        try {
          pdfCartolas.push({ cartola: pdfEntryToParsedCartola(entry), label });
        } catch (e) {
          fileLogs.push(logParseError(label, e));
        }
      }
      importCartolaList(accountId, pdfCartolas, opts, fileLogs);
    } catch (e) {
      fileLogs.push(logParseError("pdf", e));
    }
  }

  return finishCartolaImportRun(accountId, opts, fileLogs);
}

export function importCheckingCartolasFromScreenshots(opts?: {
  accountId?: number;
  wipe?: boolean;
  dryRun?: boolean;
  jsonPath?: string;
}): ImportCheckingCartolasResult {
  const accountId = opts?.accountId ?? checkingAccountId();
  const fileLogs: CheckingCartolaFileImportLog[] = [];

  if (opts?.wipe && !opts?.dryRun) {
    const w = wipeCheckingAccountData(accountId);
    console.log(
      `Wiped cuenta corriente (account ${accountId}): ${w.movements} movement(s), ${w.valuations} valuation(s), ${w.imports} import record(s).`
    );
  } else if (opts?.wipe && opts?.dryRun) {
    console.log(`[dry-run] Would wipe movements/valuations/imports for account ${accountId}.`);
  }

  try {
    const cartolas = loadParsedCheckingCartolasFromScreenshots(opts?.jsonPath);
    importCartolaList(
      accountId,
      cartolas.map((cartola) => ({
        cartola,
        label: cartola.source_file,
      })),
      { wipe: opts?.wipe, dryRun: opts?.dryRun },
      fileLogs
    );
  } catch (e) {
    fileLogs.push(logParseError("screenshots", e));
  }

  return finishCartolaImportRun(accountId, { wipe: opts?.wipe, dryRun: opts?.dryRun }, fileLogs);
}
