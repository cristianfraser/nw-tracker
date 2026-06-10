import { clearAggregationCache } from "./aggregationCache.js";
import { isCartolaDesdeBoundaryPhantomMonth, monthKeyFromYmd } from "./calendarMonth.js";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import {
  cartolaMovementDedupeKey,
  cartolaMovementMatchesImportedRow,
  listCheckingCartolaXlsxFiles,
  movementNote,
  parseCheckingCartolaFile,
  type ParsedCheckingCartola,
  type ParsedCheckingMovement,
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
  ensureCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { loadParsedCheckingCartolasFromScreenshots } from "./checkingCartolaScreenshotImport.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import {
  preserveCheckingGastosCategoriesForCartolaNotes,
} from "./checkingGastosCategoryPersist.js";
import {
  assertCheckingCartolaSaldoIdentity,
  validateCartolaSaldoChain,
} from "./checkingCartolaSaldoValidation.js";
import { cartolaPdfIndicatesSinMovimientos } from "./cartolaSinMovimientos.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentCoverage.js";
import { resolveCartolaFilePath } from "./importSyncDocumentFilePath.js";

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

function countExistingCartolaMovementsForMonth(
  accountId: number,
  periodMonth: string,
  dbHandle: Database
): number {
  const row = dbHandle
    .prepare(
      `SELECT COUNT(*) AS c FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .get(accountId, `import:cartola|${periodMonth}|%`) as { c: number };
  return Number(row.c) || 0;
}

/** Rewrite movement note prefixes after `checking_cartola_imports.period_month` is corrected. */
export function rewriteCartolaMovementNotesPeriodMonth(
  accountId: number,
  oldPeriodMonth: string,
  newPeriodMonth: string,
  dbHandle: Database = db
): number {
  if (oldPeriodMonth === newPeriodMonth) return 0;
  const fromPrefix = `import:cartola|${oldPeriodMonth}|`;
  const toPrefix = `import:cartola|${newPeriodMonth}|`;
  const rows = dbHandle
    .prepare(
      `SELECT id, note FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .all(accountId, `${fromPrefix}%`) as { id: number; note: string }[];
  const upd = dbHandle.prepare(`UPDATE movements SET note = ? WHERE id = ?`);
  let changed = 0;
  for (const r of rows) {
    if (!r.note.startsWith(fromPrefix)) continue;
    upd.run(toPrefix + r.note.slice(fromPrefix.length), r.id);
    changed += 1;
  }
  if (changed > 0) clearCheckingBalanceCache(accountId);
  return changed;
}

function cartolaSourceFileBasename(sourceFile: string): string {
  const t = String(sourceFile ?? "").trim().replace(/^pdf:/, "");
  if (!t) return "";
  return t.split(/[/\\]/).pop() ?? t;
}

/** Remove all registry rows + movements for every month imported from the same PDF. */
export function deleteCheckingCartolaImportsForSourceFile(
  accountId: number,
  sourceFile: string,
  dbHandle: Database = db
): { movements: number; imports: number } {
  const base = cartolaSourceFileBasename(sourceFile);
  if (!base) return { movements: 0, imports: 0 };
  const rows = dbHandle
    .prepare(
      `SELECT period_month, source_file FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as { period_month: string; source_file: string }[];
  let movements = 0;
  let imports = 0;
  for (const row of rows) {
    if (cartolaSourceFileBasename(row.source_file) !== base) continue;
    const r = deleteCheckingCartolaMonthImport(accountId, row.period_month, dbHandle);
    movements += r.movements;
    imports += r.imports;
  }
  return { movements, imports };
}

/** Remove imported cartola registry + movement rows for one period (re-import after parser fix). */
export function deleteCheckingCartolaMonthImport(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db
): { movements: number; imports: number } {
  preserveCheckingGastosCategoriesForCartolaNotes(
    accountId,
    `import:cartola|${periodMonth}|%`,
    dbHandle
  );
  const delMov = dbHandle
    .prepare(
      `DELETE FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .run(accountId, `import:cartola|${periodMonth}|%`);
  let delImp = { changes: 0 };
  try {
    delImp = dbHandle
      .prepare(
        `DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
      )
      .run(accountId, periodMonth);
  } catch {
    /* migration 052 not applied yet */
  }
  clearCheckingBalanceCache(accountId);
  return { movements: delMov.changes, imports: delImp.changes };
}

/** Import row for a boundary month wrongly created by old multi-month split (0 movements). */
export function isPhantomBoundaryMonthImport(row: {
  period_month: string;
  period_from: string | null;
  period_to: string | null;
  movement_count: number;
}): boolean {
  return isCartolaDesdeBoundaryPhantomMonth(row);
}

/** Parsed monthly slice that should not be imported (ledger anchor covers the gap). */
export function isPhantomBoundaryCartolaSlice(cartola: ParsedCheckingCartola): boolean {
  return isCartolaDesdeBoundaryPhantomMonth({
    period_month: cartola.period_month,
    period_from: cartola.period_from,
    period_to: cartola.period_to,
    movement_count: cartola.movements.length,
  });
}

/** Remove phantom boundary-month registry rows (no movements deleted). */
export function prunePhantomBoundaryMonthCartolaImports(
  accountId: number,
  dbHandle: Database = db
): { pruned: string[] } {
  const rows = dbHandle
    .prepare(
      `SELECT period_month, period_from, period_to, movement_count
       FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as {
    period_month: string;
    period_from: string | null;
    period_to: string | null;
    movement_count: number;
  }[];
  const pruned: string[] = [];
  for (const row of rows) {
    if (!isPhantomBoundaryMonthImport(row)) continue;
    const existingMoves = countExistingCartolaMovementsForMonth(
      accountId,
      row.period_month,
      dbHandle
    );
    if (existingMoves > 0) continue;
    deleteCheckingCartolaMonthImport(accountId, row.period_month, dbHandle);
    pruned.push(row.period_month);
    console.log(`  pruned phantom boundary month ${row.period_month} (0 movements)`);
  }
  return { pruned };
}

/** Remove import rows for months no longer covered by a parsed cartola (same source PDF). */
export function pruneStaleCartolaMonthImportsForSourceFile(
  accountId: number,
  sourceFile: string,
  validMonths: Iterable<string>,
  dbHandle: Database = db
): { pruned: string[]; movements: number } {
  const valid = new Set(validMonths);
  const base = cartolaSourceFileBasename(sourceFile);
  if (!base) return { pruned: [], movements: 0 };
  const rows = dbHandle
    .prepare(
      `SELECT period_month, source_file FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as { period_month: string; source_file: string }[];
  const pruned: string[] = [];
  let movements = 0;
  for (const row of rows) {
    if (cartolaSourceFileBasename(row.source_file) !== base) continue;
    if (valid.has(row.period_month)) continue;
    const r = deleteCheckingCartolaMonthImport(accountId, row.period_month, dbHandle);
    movements += r.movements;
    pruned.push(row.period_month);
    console.log(
      `  pruned stale cartola month ${row.period_month} from ${base} (${r.movements} movement(s))`
    );
  }
  return { pruned, movements };
}

/** Remove all movements, valuations, and cartola import registry for checking account. */
export function wipeCheckingAccountData(accountId: number, dbHandle: Database = db): {
  movements: number;
  valuations: number;
  imports: number;
} {
  const delMov = dbHandle.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
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
  assertCheckingCartolaSaldoIdentity(cartola);
  const chainErr = validateCartolaSaldoChain(accountId, cartola, dbHandle);
  if (chainErr) {
    throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${chainErr}`);
  }

  const insMov = dbHandle.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, NULL)`
  );
  const markImported = dbHandle.prepare(
    `INSERT INTO checking_cartola_imports (
       account_id, period_month, source_file, movement_count,
       saldo_final_clp, saldo_inicial_clp, period_from, period_to
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, period_month) DO UPDATE SET
       source_file = excluded.source_file,
       movement_count = excluded.movement_count,
       saldo_final_clp = excluded.saldo_final_clp,
       saldo_inicial_clp = excluded.saldo_inicial_clp,
       period_from = excluded.period_from,
       period_to = excluded.period_to,
       imported_at = datetime('now')`
  );

  const noteExists = dbHandle.prepare(
    `SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ? LIMIT 1`
  );

  function countMatchingInDb(mv: ParsedCheckingMovement, periodMonth: string): number {
    const rows = dbHandle
      .prepare(
        `SELECT note FROM movements
         WHERE account_id = ? AND occurred_on = ? AND amount_clp = ?
           AND note LIKE ?`
      )
      .all(accountId, mv.occurred_on, mv.amount_clp, `import:cartola|${periodMonth}|%`) as {
      note: string;
    }[];
    let n = 0;
    for (const r of rows) {
      if (cartolaMovementMatchesImportedRow(mv, r.note)) n += 1;
    }
    return n;
  }

  let movementsInserted = 0;
  let movementsSkipped = 0;
  const tx = dbHandle.transaction(() => {
    cartola.movements.forEach((mv, cartolaIndex) => {
      const note = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
        occurredOn: mv.occurred_on,
        amountClp: mv.amount_clp,
        cartolaIndex,
      });
      if (noteExists.get(accountId, note)) {
        movementsSkipped += 1;
        return;
      }
      const sameKeyIndex = cartola.movements
        .slice(0, cartolaIndex)
        .filter((prior) => cartolaMovementDedupeKey(prior) === cartolaMovementDedupeKey(mv)).length;
      if (countMatchingInDb(mv, cartola.period_month) >= sameKeyIndex + 1) {
        movementsSkipped += 1;
        return;
      }
      insMov.run(accountId, mv.amount_clp, mv.occurred_on, note);
      movementsInserted += 1;
    });
    if (cartola.movements.length > 0 && movementsInserted === 0) {
      const existing = countExistingCartolaMovementsForMonth(
        accountId,
        cartola.period_month,
        dbHandle
      );
      if (existing === 0) {
        throw new Error(
          `Cartola ${cartola.period_month} (${cartola.source_file}): parsed ${cartola.movements.length} movement(s) but inserted 0`
        );
      }
    }
    if (
      cartola.movements.length === 0 &&
      cartola.saldo_inicial_clp != null &&
      cartola.saldo_final_clp != null &&
      cartola.saldo_inicial_clp !== cartola.saldo_final_clp
    ) {
      const existing = countExistingCartolaMovementsForMonth(
        accountId,
        cartola.period_month,
        dbHandle
      );
      if (existing === 0) {
        throw new Error(
          `Cartola ${cartola.period_month} (${cartola.source_file}): no movements parsed but saldo changed (${cartola.saldo_inicial_clp} → ${cartola.saldo_final_clp})`
        );
      }
    }
    markImported.run(
      accountId,
      cartola.period_month,
      cartola.source_file,
      movementsInserted,
      cartola.saldo_final_clp,
      cartola.saldo_inicial_clp,
      cartola.period_from,
      cartola.period_to
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

function cartolaDocumentKindForAccount(accountId: number): ImportSyncDocumentAccount["document_kind"] {
  if (accountId === cartolaCashAccountId("cuenta_vista")) {
    return "cuenta_vista_cartola";
  }
  return "checking_cartola";
}

/** Replace a prior sin-movimientos / empty import when a new PDF has real movements. */
export function cartolaImportShouldReplaceExisting(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): boolean {
  if (!isCheckingCartolaMonthImported(accountId, cartola.period_month, dbHandle)) {
    return false;
  }
  const row = dbHandle
    .prepare(
      `SELECT movement_count, source_file FROM checking_cartola_imports
       WHERE account_id = ? AND period_month = ?`
    )
    .get(accountId, cartola.period_month) as
    | { movement_count: number; source_file: string }
    | undefined;
  if (!row) return false;

  const kind = cartolaDocumentKindForAccount(accountId);
  const newCount = cartola.movements.length;
  const oldCount = Number(row.movement_count) || 0;
  if (newCount > oldCount) return true;
  if (newCount > 0 && oldCount === 0) return true;

  const oldPath = resolveCartolaFilePath(kind, row.source_file);
  const newPath = resolveCartolaFilePath(kind, cartola.source_file);
  const oldSin = oldPath ? cartolaPdfIndicatesSinMovimientos(oldPath) : false;
  const newSin = newPath ? cartolaPdfIndicatesSinMovimientos(newPath) : false;
  if (oldSin && !newSin && newCount > 0) return true;
  if (oldSin && newCount > 0) return true;
  return false;
}

/** Update reference saldos on an already-imported month (movements unchanged). */
export function updateCheckingCartolaImportSaldos(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): void {
  assertCheckingCartolaSaldoIdentity(cartola);
  dbHandle
    .prepare(
      `UPDATE checking_cartola_imports SET
         saldo_final_clp = ?,
         saldo_inicial_clp = COALESCE(?, saldo_inicial_clp),
         imported_at = datetime('now')
       WHERE account_id = ? AND period_month = ?`
    )
    .run(
      cartola.saldo_final_clp,
      cartola.saldo_inicial_clp,
      accountId,
      cartola.period_month
    );
}

export function shouldBackfillCartolaSaldoRef(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db
): boolean {
  if (cartola.saldo_final_clp == null) return false;
  const row = dbHandle
    .prepare(
      `SELECT source_file, saldo_final_clp FROM checking_cartola_imports
       WHERE account_id = ? AND period_month = ?`
    )
    .get(accountId, cartola.period_month) as
    | { source_file: string; saldo_final_clp: number | null }
    | undefined;
  if (!row) return false;
  if (cartolaSourceFileBasename(row.source_file) !== cartolaSourceFileBasename(cartola.source_file)) {
    return false;
  }
  const existingMoves = countExistingCartolaMovementsForMonth(
    accountId,
    cartola.period_month,
    dbHandle
  );
  if (cartola.movements.length > 0 && existingMoves !== cartola.movements.length) {
    return false;
  }
  if (row.saldo_final_clp == null) return true;
  return row.saldo_final_clp !== cartola.saldo_final_clp;
}

export function importCartolaList(
  accountId: number,
  cartolas: { cartola: ParsedCheckingCartola; label: string }[],
  opts: { wipe?: boolean; dryRun?: boolean; forceReimport?: boolean },
  fileLogs: CheckingCartolaFileImportLog[]
): void {
  for (const { cartola, label } of cartolas) {
    if (isPhantomBoundaryCartolaSlice(cartola)) {
      console.log(
        `  skip phantom boundary month ${cartola.period_month} (${cartola.source_file}, 0 movements)`
      );
      continue;
    }
    if (
      opts.forceReimport &&
      !opts.dryRun &&
      isCheckingCartolaMonthImported(accountId, cartola.period_month)
    ) {
      deleteCheckingCartolaMonthImport(accountId, cartola.period_month);
    }
    if (
      !opts.wipe &&
      !opts.forceReimport &&
      isCheckingCartolaMonthImported(accountId, cartola.period_month)
    ) {
      if (!opts.dryRun && cartolaImportShouldReplaceExisting(accountId, cartola)) {
        const cleared = deleteCheckingCartolaMonthImport(accountId, cartola.period_month);
        console.log(
          `  replace empty/sin-movimientos cartola ${cartola.period_month}: cleared ${cleared.movements} movement(s)`
        );
      } else if (!cartolaImportShouldReplaceExisting(accountId, cartola)) {
        if (shouldBackfillCartolaSaldoRef(accountId, cartola)) {
          if (!opts.dryRun) {
            updateCheckingCartolaImportSaldos(accountId, cartola);
          }
          fileLogs.push(
            fileLogFromCartola(label, cartola, {
              status: "updated_saldo_ref",
              movements_imported: 0,
            })
          );
          continue;
        }
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
  if (!opts.dryRun && fileLogs.some((f) => f.status === "imported" || f.status === "updated_saldo_ref")) {
    const cleared = clearCheckingAccountValuations(accountId);
    if (cleared > 0) {
      console.log(
        `Cleared ${cleared} persisted valuation row(s) for ${accountLabel} (balances computed at runtime).`
      );
    }
    const { pruned } = prunePhantomBoundaryMonthCartolaImports(accountId);
    if (pruned.length > 0) {
      console.log(`  pruned phantom boundary month(s): ${pruned.join(", ")}`);
    }
    const anchor = ensureCheckingLedgerAnchor(accountId);
    if (anchor.inserted) {
      console.log(
        `Inserted ledger anchor ${anchor.amount_clp} CLP on ${anchor.occurred_on} (${anchor.anchor_period_month} saldo final).`
      );
    } else if (anchor.updated) {
      console.log(
        `Updated ledger anchor to ${anchor.amount_clp} CLP on ${anchor.occurred_on} (${anchor.anchor_period_month}).`
      );
    } else if (anchor.cleared) {
      console.log(`Cleared ledger anchor (no cartola saldo final).`);
    }
    clearAggregationCache();
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
  forceReimport?: boolean;
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

  if (!opts?.dryRun && !opts?.wipe) {
    prunePhantomBoundaryMonthCartolaImports(accountId);
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

/** Insert cartola movements missing from DB (same date/amount/description/doc), using new note keys. */
export function backfillMissingCheckingCartolaMovements(opts?: {
  accountId?: number;
  dir?: string;
  dryRun?: boolean;
}): {
  accountId: number;
  dryRun: boolean;
  inserted: number;
  skipped: number;
  byMonth: { period_month: string; inserted: number; missing_before: number }[];
} {
  const accountId = opts?.accountId ?? checkingAccountId();
  const dir = opts?.dir ?? resolveCfraserCheckingCartolasDir();
  const dryRun = !!opts?.dryRun;
  const files = listCheckingCartolaXlsxFiles(dir);
  let inserted = 0;
  let skipped = 0;
  const byMonth: { period_month: string; inserted: number; missing_before: number }[] = [];

  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, NULL)`
  );
  const updateImportCount = db.prepare(
    `UPDATE checking_cartola_imports
     SET movement_count = movement_count + ?, imported_at = datetime('now')
     WHERE account_id = ? AND period_month = ?`
  );

  const tx = db.transaction(() => {
    for (const filePath of files) {
      const cartola = parseCheckingCartolaFile(filePath);
      const pm = cartola.period_month;
      let missingBefore = 0;
      let monthInserted = 0;

      cartola.movements.forEach((mv, cartolaIndex) => {
        const note = movementNote(pm, mv.branch, mv.description, mv.document_no, {
          occurredOn: mv.occurred_on,
          amountClp: mv.amount_clp,
          cartolaIndex,
        });
        const existsExact = db
          .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`)
          .get(accountId, note);
        if (existsExact) {
          skipped += 1;
          return;
        }
        const sameKeyIndex = cartola.movements
          .slice(0, cartolaIndex)
          .filter((prior) => cartolaMovementDedupeKey(prior) === cartolaMovementDedupeKey(mv)).length;
        const rows = db
          .prepare(
            `SELECT note FROM movements
             WHERE account_id = ? AND occurred_on = ? AND amount_clp = ?
               AND note LIKE ?`
          )
          .all(accountId, mv.occurred_on, mv.amount_clp, `import:cartola|${pm}|%`) as {
          note: string;
        }[];
        let matchCount = 0;
        for (const r of rows) {
          if (cartolaMovementMatchesImportedRow(mv, r.note)) matchCount += 1;
        }
        if (matchCount >= sameKeyIndex + 1) {
          skipped += 1;
          return;
        }
        missingBefore += 1;
        if (!dryRun) {
          insMov.run(accountId, mv.amount_clp, mv.occurred_on, note);
          monthInserted += 1;
        }
        inserted += 1;
      });

      if (monthInserted > 0 && !dryRun) {
        updateImportCount.run(monthInserted, accountId, pm);
      }
      if (missingBefore > 0) {
        byMonth.push({
          period_month: pm,
          inserted: dryRun ? missingBefore : monthInserted,
          missing_before: missingBefore,
        });
      }
    }
  });
  tx();
  if (!dryRun && inserted > 0) {
    clearCheckingBalanceCache(accountId);
  }
  return { accountId, dryRun, inserted, skipped, byMonth };
}
