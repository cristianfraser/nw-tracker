import { clearAggregationCache } from "./aggregationCache.js";
import { isCartolaDesdeBoundaryPhantomMonth } from "./calendarMonth.js";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { reconcileCartolaPartialImports } from "./checkingCartolaPartialReconcile.js";
import {
  cartolaMovementDedupeKey,
  cartolaMovementMatchesImportedRow,
  movementNote,
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
  clearCheckingAccountValuations,
  clearCheckingBalanceCache,
  ensureCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { preserveCheckingGastosCategoriesForCartolaNotes } from "./checkingGastosCategoryPersist.js";
import { assertCheckingCartolaSaldoIdentity, validateCartolaSaldoChain } from "./checkingCartolaSaldoValidation.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import { claimTransferLegForBankRow, findMatchingInternalTransferLegId } from "./checkingTransferLegReconcile.js";
import { confirmSyntheticRetiroForTransferLeg } from "./fintualSyntheticRetiros.js";
import { confirmTransferNoticeMovement, findTransferNoticeMovementForBankRow } from "./transferNoticeMovements.js";
import { confirmSyntheticCcPaymentForTransferLeg } from "./santanderSyntheticCcPayments.js";
import type { ImportFlowItem, SkippedImportFlowItem } from "./checkingPartialMovementsImport.js";
import { checkingMovementFlowKind } from "./checkingBankCharges.js";

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
): {
  movementsInserted: number;
  movementsSkipped: number;
  partialsRemoved: number;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
} {
  assertCheckingCartolaSaldoIdentity(cartola);
  const chainErr = validateCartolaSaldoChain(accountId, cartola, dbHandle);
  if (chainErr) {
    throw new Error(`Cartola ${cartola.period_month} (${cartola.source_file}): ${chainErr}`);
  }

  const insMov = dbHandle.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
     VALUES (?, ?, 'clp', ?, ?, NULL, ?)`
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
        `SELECT m.note FROM movements m ${BANK_POSTING_JOIN_SQL}
         WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?
           AND m.note LIKE ?`
      )
      .all(accountId, accountId, mv.occurred_on, mv.amount_clp, `import:cartola|${periodMonth}|%`) as {
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
  let movementsSupersededByTransfer = 0;
  let partialsRemoved = 0;
  const inserted_flows: ImportFlowItem[] = [];
  const skipped_flows: SkippedImportFlowItem[] = [];
  const flowOf = (mv: ParsedCheckingMovement): ImportFlowItem => ({
    occurred_on: mv.occurred_on,
    description: mv.description,
    amount_clp: mv.amount_clp,
  });
  const consumedTransferLegs = new Set<number>();
  const consumedMailMovements = new Set<number>();
  const tx = dbHandle.transaction(() => {
    cartola.movements.forEach((mv, cartolaIndex) => {
      const note = movementNote(cartola.period_month, mv.branch, mv.description, mv.document_no, {
        occurredOn: mv.occurred_on,
        amountClp: mv.amount_clp,
        cartolaIndex,
      });
      if (noteExists.get(accountId, note)) {
        movementsSkipped += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "duplicate" });
        return;
      }
      const sameKeyIndex = cartola.movements
        .slice(0, cartolaIndex)
        .filter((prior) => cartolaMovementDedupeKey(prior) === cartolaMovementDedupeKey(mv)).length;
      if (countMatchingInDb(mv, cartola.period_month) >= sameKeyIndex + 1) {
        movementsSkipped += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "already_present" });
        return;
      }
      // Already represented by a manual internal transfer leg (from/to touching this account)?
      // Keep the single transfer row instead of inserting a duplicate bank line.
      const transferLegId = findMatchingInternalTransferLegId(
        accountId,
        mv.occurred_on,
        mv.amount_clp,
        consumedTransferLegs,
        dbHandle
      );
      if (transferLegId != null) {
        consumedTransferLegs.add(transferLegId);
        claimTransferLegForBankRow(transferLegId, accountId, mv.occurred_on, dbHandle);
        // The bank listed the money a synthesized retiro / card-payment transfer promised —
        // stamp it confirmed (no-op for ordinary manual transfer legs).
        confirmSyntheticRetiroForTransferLeg(transferLegId, mv.occurred_on, "cartola", dbHandle);
        confirmSyntheticCcPaymentForTransferLeg(transferLegId, mv.occurred_on, "cartola", dbHandle);
        movementsSkipped += 1;
        movementsSupersededByTransfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_transfer" });
        return;
      }
      // Already written from the transfer's mail (and likely confirmed by the daily feed already).
      const mailMovementId = findTransferNoticeMovementForBankRow(
        accountId,
        mv.occurred_on,
        mv.amount_clp,
        consumedMailMovements,
        dbHandle
      );
      if (mailMovementId != null) {
        consumedMailMovements.add(mailMovementId);
        confirmTransferNoticeMovement(mailMovementId, accountId, mv.occurred_on, "cartola", mv.description, dbHandle);
        movementsSkipped += 1;
        movementsSupersededByTransfer += 1;
        skipped_flows.push({ ...flowOf(mv), reason: "superseded_by_mail" });
        return;
      }
      insMov.run(
        accountId,
        mv.amount_clp,
        mv.occurred_on,
        note,
        checkingMovementFlowKind(mv.description, mv.amount_clp)
      );
      movementsInserted += 1;
      inserted_flows.push(flowOf(mv));
    });
    if (cartola.movements.length > 0 && movementsInserted === 0 && movementsSupersededByTransfer === 0) {
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
    const reconcile = reconcileCartolaPartialImports(accountId, cartola.movements, dbHandle);
    partialsRemoved = reconcile.removed;
    markImported.run(
      accountId,
      cartola.period_month,
      cartola.source_file,
      cartola.movements.length,
      cartola.saldo_final_clp,
      cartola.saldo_inicial_clp,
      cartola.period_from,
      cartola.period_to
    );
  });
  tx();
  clearCheckingBalanceCache(accountId);
  return { movementsInserted, movementsSkipped, partialsRemoved, inserted_flows, skipped_flows };
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
        if (!opts.dryRun && cartola.movements.length > 0) {
          const { removed } = reconcileCartolaPartialImports(accountId, cartola.movements);
          if (removed > 0) {
            console.log(
              `  reconciled ${removed} partial movement(s) superseded by cartola ${cartola.period_month}`
            );
          }
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
