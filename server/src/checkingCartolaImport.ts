import { isCartolaDesdeBoundaryPhantomMonth } from "./calendarMonth.js";
import type { RetiredMovementAdoption } from "./flows/flowAdoption.js";
import { deleteAccountMovements, deleteMovements } from "./movementWrites.js";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { planCheckingCartola } from "./checkingCartolaPlan.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { applyCheckingCartolaPlan } from "./checkingCartolaPlanApply.js";
import type { ListedRowFold } from "./checkingCartolaRestate.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import {
  fileLogFromCartola,
  logCheckingCartolaImportRun,
  type CheckingCartolaFileImportLog,
  type CheckingCartolaImportRunLog,
} from "./checkingCartolaParseLog.js";
import {
  clearCheckingAccountValuations,
  ensureCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { assertCheckingCartolaSaldoIdentity } from "./checkingCartolaSaldoValidation.js";
import { assertCartolaMonthWrote, countExistingCartolaMovementsForMonth, recordCartolaMonthImport } from "./checkingCartolaMonthRecord.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import type { ImportFlowItem, SkippedImportFlowItem } from "./checkingPartialMovementsImport.js";

export { assertCartolaMonthWrote, recordCartolaMonthImport };

export function checkingAccountId(): number {
  return cartolaCashAccountId("cuenta_corriente");
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

function cartolaSourceFileBasename(sourceFile: string): string {
  const t = String(sourceFile ?? "").trim().replace(/^pdf:/, "");
  if (!t) return "";
  return t.split(/[/\\]/).pop() ?? t;
}

/** Remove imported cartola registry + movement rows for one period (re-import after parser fix). */
export function deleteCheckingCartolaMonthImport(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db
): { movements: number; imports: number } {
  // The month's rows (its cartola rows by their listing facts) go; a flow something hangs off is
  // retired with its document (migration 290), and the re-imported row with the same identity takes
  // it back (`insertBankPesoMovement`).
  const ids = (
    dbHandle
      .prepare(
        `SELECT m.id FROM movements m JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
         WHERE m.account_id = ? AND e.source_kind = 'cartola' AND e.stated_period = ?`
      )
      .all(accountId, periodMonth) as { id: number }[]
  ).map((r) => r.id);
  const movements = deleteMovements(ids, dbHandle);
  const delImp = dbHandle
    .prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .run(accountId, periodMonth);
  return { movements, imports: delImp.changes };
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
  const movements = deleteAccountMovements(accountId, dbHandle);
  const delVal = dbHandle
    .prepare(`DELETE FROM valuations WHERE account_id = ?`)
    .run(accountId);
  const delImp = dbHandle
    .prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`)
    .run(accountId);
  return {
    movements,
    valuations: delVal.changes,
    imports: delImp.changes,
  };
}

export type CheckingCartolaImportResult = {
  movementsInserted: number;
  /** Movements whose row was on file and stays as it is (the same cartola again, a leg, a mail row). */
  movementsSkipped: number;
  /** Daily-listing rows the cartola restated in place (they became its rows). */
  partialsRestated: number;
  /** Daily rows folded into the kept row of their movement (several rows of one movement). */
  partialsFolded: number;
  /** Daily rows removed: a transfer leg or a mail row already represents their movement. */
  partialsRemoved: number;
  /** A replaced month's cartola rows the new cartola no longer lists, removed. */
  cartolaRowsRemoved: number;
  /** Whether the import wrote anything (a cartola on file as it states writes nothing). */
  wrote: boolean;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
  /** Rows that took a retired flow back (a re-imported month), or found several (left alone). */
  flow_adoptions: NonNullable<RetiredMovementAdoption>[];
  /** Daily rows removed for a transfer leg or a mail row: folded into that row, or refused (reported). */
  listed_row_folds: ListedRowFold[];
};

/**
 * One cartola month into the checking account, as a plan applied (`checkingCartolaPlan.ts` →
 * `checkingCartolaPlanApply.ts`): rows on file — the cartola's own from an earlier import, the daily
 * listing's — are restated, not deleted and written again; the gates (saldo identity, saldo chain,
 * «wrote none») throw before anything is written. `replaceMonth`: the month is imported again from a
 * corrected or fuller cartola (its rows the new one no longer lists go, the others are restated).
 */
export function importCheckingCartola(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db,
  opts?: { replaceMonth?: boolean }
): CheckingCartolaImportResult {
  const plan = planCheckingCartola({ ...loadCheckingCartolaPlanInput(accountId, cartola, dbHandle), replace_month: opts?.replaceMonth === true });
  const changesBefore = totalChanges(dbHandle);
  const applied = applyCheckingCartolaPlan(accountId, cartola, plan, dbHandle, { replaceMonth: opts?.replaceMonth === true });
  const flowOf = (index: number): ImportFlowItem => {
    const mv = cartola.movements[index]!;
    return { occurred_on: mv.occurred_on, description: mv.description, amount_clp: mv.amount_clp };
  };
  const inserted_flows = plan.insert.map((i) => flowOf(i.movement));
  const skipped_flows: SkippedImportFlowItem[] = [];
  for (const k of plan.keep) {
    skipped_flows.push({ ...flowOf(k.movement), reason: k.why === "daily_listing" ? "restated" : k.why === "document_key" ? "duplicate" : "already_present" });
  }
  for (const c of plan.confirm) {
    skipped_flows.push({ ...flowOf(c.movement), reason: c.why === "transfer_leg" ? "superseded_by_transfer" : "superseded_by_mail" });
  }
  const dailyRemoved = plan.remove.filter((r) => r.why !== "replaced_cartola_row").length;
  return {
    movementsInserted: applied.inserted.length,
    movementsSkipped: plan.keep.filter((k) => k.why !== "daily_listing").length + plan.confirm.length,
    partialsRestated: plan.keep.filter((k) => k.why === "daily_listing").length,
    partialsFolded: plan.fold.length,
    partialsRemoved: dailyRemoved,
    cartolaRowsRemoved: plan.remove.length - dailyRemoved,
    wrote: totalChanges(dbHandle) !== changesBefore,
    inserted_flows,
    skipped_flows,
    flow_adoptions: applied.flow_adoptions,
    listed_row_folds: applied.listed_row_folds,
  };
}

function totalChanges(dbHandle: Database): number {
  return (dbHandle.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
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

function logParseError(file: string, e: unknown, periodMonth = ""): CheckingCartolaFileImportLog {
  const msg = errorMessage(e);
  console.error(`  PARSE ERROR ${file}: ${msg}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  return {
    file,
    period_month: periodMonth,
    status: "parse_error",
    movements_parsed: 0,
    movements_imported: 0,
    skipped_rows: [],
    saldo_final_clp: null,
    saldo_inicial_clp: null,
    error: msg,
  };
}

/**
 * Replace a prior import of a month when the new cartola carries more movements, or any where the
 * stored one had none (a «sin movimientos» cartola, or an empty slice). Decided from the counts
 * alone: the stored document's own text was read here until 2026-10-02, and an annual cartola
 * that prints «sin movimientos» for some of its months re-imported all of them on every run.
 */
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

  const newCount = cartola.movements.length;
  const oldCount = Number(row.movement_count) || 0;
  return newCount > oldCount || (newCount > 0 && oldCount === 0);
}

/** Update reference saldos on an already-imported month (movements unchanged). */
/** Whether the month's record names the cartola's own document (by basename). */
export function cartolaMonthRecordNamesFile(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): boolean {
  const row = dbHandle
    .prepare(`SELECT source_file FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .get(accountId, cartola.period_month) as { source_file: string } | undefined;
  return row != null && cartolaSourceFileBasename(row.source_file) === cartolaSourceFileBasename(cartola.source_file);
}

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
  opts: { wipe?: boolean; dryRun?: boolean; forceReimport?: boolean; forceSameFileOnly?: boolean },
  fileLogs: CheckingCartolaFileImportLog[],
  /** Collects each imported cartola's rows, for an upload's result view. */
  flows?: { inserted: ImportFlowItem[]; skipped: SkippedImportFlowItem[] }
): void {
  for (const { cartola, label } of cartolas) {
    if (isPhantomBoundaryCartolaSlice(cartola)) {
      console.log(
        `  skip phantom boundary month ${cartola.period_month} (${cartola.source_file}, 0 movements)`
      );
      continue;
    }
    // A month on file is written again only when the file replaces it: forced (`forceReimport`;
    // with `forceSameFileOnly`, only a month whose record names this document), or fuller
    // (`cartolaImportShouldReplaceExisting`). Then it is a diff against the month's rows (restate,
    // insert, remove what the new file no longer lists); any other rendering of the month — the
    // same file again, the other format, a slice of the next document — writes nothing (its printed
    // saldo only refreshes the record of the same file), decided before the account is read.
    const onFile = !opts.wipe && isCheckingCartolaMonthImported(accountId, cartola.period_month);
    const forced = opts.forceReimport === true && (!opts.forceSameFileOnly || cartolaMonthRecordNamesFile(accountId, cartola));
    const replaceMonth = onFile && (forced || cartolaImportShouldReplaceExisting(accountId, cartola));
    if (onFile && !replaceMonth) {
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
      const r = importCheckingCartola(accountId, cartola, db, { replaceMonth });
      const ambiguous = r.flow_adoptions.filter((a) => a.status === "ambiguous");
      if (r.flow_adoptions.length > 0) {
        console.log(
          `  cartola ${cartola.period_month}: ${r.flow_adoptions.length - ambiguous.length} row(s) took their flow back` +
            (ambiguous.length > 0 ? `; AMBIGUOUS (left alone): movements ${ambiguous.map((a) => a.movement_id).join(", ")}` : "")
        );
      }
      const refused = r.listed_row_folds.filter((f) => f.status === "refused");
      if (refused.length > 0) {
        console.log(
          `  cartola ${cartola.period_month}: REMOVED WITHOUT FOLDING (what was filed on them is not on the kept row): ` +
            refused.map((f) => `daily row ${f.row_id} → ${f.kept_row_id} (${f.reason})`).join("; ")
        );
      }
      const dropped = r.listed_row_folds.filter((f) => f.records_dropped.length > 0);
      if (dropped.length > 0) {
        console.log(
          `  cartola ${cartola.period_month}: records that named a removed daily row went with it: ` +
            dropped.map((f) => `${f.row_id} (${f.records_dropped.join(", ")})`).join("; ")
        );
      }
      if (replaceMonth) {
        console.log(
          `  cartola ${cartola.period_month} imported again in place: ${r.movementsSkipped} kept, ${r.movementsInserted} written, ` +
            `${r.cartolaRowsRemoved} no longer listed removed`
        );
      }
      flows?.inserted.push(...r.inserted_flows);
      flows?.skipped.push(...r.skipped_flows);
      fileLogs.push(
        fileLogFromCartola(label, cartola, {
          status: "imported",
          movements_imported: r.movementsInserted,
        })
      );
    } catch (e) {
      fileLogs.push(logParseError(label, e, cartola.period_month));
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
