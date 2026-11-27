import { isCartolaDesdeBoundaryPhantomMonth, ymCompare } from "./calendarMonth.js";
import { addCalendarMonths } from "nw-tracker-contracts";
import type { RetiredMovementAdoption } from "./flows/flowAdoption.js";
import { deleteAccountMovements, deleteMovements, TaxSettlementRepointError } from "./movementWrites.js";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { planCheckingCartola, type CheckingCartolaPlan } from "./checkingCartolaPlan.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { applyCheckingCartolaPlan, checkingFoldConflictReport, type CheckingRowFoldConflict } from "./checkingCartolaPlanApply.js";
import type { ListedRowFold } from "./checkingCartolaRestate.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import {
  fileLogFromCartola,
  logCheckingCartolaImportRun,
  type CheckingCartolaFileImportLog,
  type CheckingCartolaImportRunLog,
} from "./checkingCartolaParseLog.js";
import {
  CheckingLedgerAnchorPinnedError,
  clearCheckingAccountValuations,
  ensureCheckingLedgerAnchor,
  storedCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { assertCheckingCartolaSaldoIdentity } from "./checkingCartolaSaldoValidation.js";
import { cartolaCoversWholeMonth, type CartolaMonthPeriod } from "./checkingCartolaMonthBounds.js";
import { compareCartolaWithMonthOnFile, describeCartolaMonthDifference, recordCartolaMonthConfirmed } from "./checkingCartolaCrossCheck.js";
import {
  assertCartolaLedgerAfterApply,
  assertCartolaOpeningAgrees,
  assertCartolaSaldoRefreshAgrees,
  assertNoLedgerDrift,
  CartolaImportRefusal,
  cartolaLedgerFrame,
  checkingLedgerMonthsOffTheirCartolas,
  type CartolaLedgerFrame,
  type CheckingLedgerAnchorAt,
} from "./checkingCartolaLedgerGuard.js";
import { assertCartolaMonthWrote, countExistingCartolaMovementsForMonth, recordCartolaMonthImport } from "./checkingCartolaMonthRecord.js";
import { cartolaCashAccountId } from "./movementBalanceCashAccounts.js";
import type { ImportFlowItem, SkippedImportFlowItem } from "./checkingPartialMovementsImport.js";
import { bankRowText } from "./bankRowFacts.js";
import { describeRestatementCarry, restatementCarryIsEmpty, restatementIdentityHook, type RestatementCarry } from "./checkingRestatementHook.js";

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
  /** The rebuild's replaced cartola rows folded into the kept row of their bank day and pesos. */
  cartolaRowsFolded: number;
  /** Folds whose rows held different assignments (notes joined, a category or big group dropped). */
  fold_conflicts: CheckingRowFoldConflict[];
  /** Whether the import wrote anything (a cartola on file as it states writes nothing). */
  wrote: boolean;
  inserted_flows: ImportFlowItem[];
  skipped_flows: SkippedImportFlowItem[];
  /** Rows that took a retired flow back (a re-imported month), or found several (left alone). */
  flow_adoptions: NonNullable<RetiredMovementAdoption>[];
  /** Daily rows removed for a transfer leg or a mail row: folded into that row, or refused (reported). */
  listed_row_folds: ListedRowFold[];
  /** Rows the cartola would remove or fold away that a tax settlement or payslip names: left as they are. */
  left_alone: CheckingCartolaPlan["left_alone"];
  /**
   * A replaced month whose rows the new cartola prints in other text: what the carry kept
   * (`checkingRestatementCarry.ts`); null when no kept row's text changed.
   */
  restatement_carry: RestatementCarry | null;
  /**
   * The anchor this cartola derived (it starts the account's history, or no anchor was on file):
   * not written here — the run carries it to its next cartolas and writes it at its end
   * (`finishCartolaImportRun`). Null when the anchor on file stood.
   */
  anchor_derived: CheckingLedgerAnchorAt | null;
};

/**
 * One cartola month into the checking account, as a plan applied (`checkingCartolaPlan.ts` →
 * `checkingCartolaPlanApply.ts`): rows on file — the cartola's own from an earlier import, the daily
 * listing's — are restated, not deleted and written again; the gates (saldo identity, saldo chain,
 * «wrote none») throw before anything is written, and the ledger guard refuses a cartola the
 * ledger does not agree with (`checkingCartolaLedgerGuard.ts`: its opening before, its closing
 * after, inside the apply's transaction). `replaceMonth`: the month is imported again from a
 * corrected or fuller cartola (its rows the new one no longer lists go, the others are restated).
 */
export function importCheckingCartola(
  accountId: number,
  cartola: ParsedCheckingCartola,
  dbHandle: Database = db,
  /**
   * `runAnchor`: the anchor an earlier cartola of the run derived (`CheckingCartolaImportResult.anchor_derived`).
   * `rebuild`: the repair run's frame (`rebuildCheckingLedgerFromCartolas`): no check of its own.
   */
  opts?: { replaceMonth?: boolean; runAnchor?: CheckingLedgerAnchorAt | null; rebuild?: boolean }
): CheckingCartolaImportResult {
  // The ledger must agree with the cartola's printed opening before anything is written, and with
  // its closing once applied (inside the apply's transaction): `checkingCartolaLedgerGuard.ts`.
  // The document's own consistency first (its printed balances against its movements).
  assertCheckingCartolaSaldoIdentity(cartola);
  const frame: CartolaLedgerFrame = opts?.rebuild ? { kind: "rebuild" } : cartolaLedgerFrame(accountId, cartola.period_month, dbHandle, opts?.runAnchor ?? null);
  assertNoLedgerDrift(accountId, cartola, frame, opts?.runAnchor != null, dbHandle);
  assertCartolaOpeningAgrees(accountId, cartola, frame, dbHandle);
  const input = loadCheckingCartolaPlanInput(accountId, cartola, dbHandle);
  const plan = planCheckingCartola({
    ...input,
    replace_month: opts?.replaceMonth === true,
    rebuild: opts?.rebuild === true,
  });
  if (plan.unfoldable.length > 0) {
    throw new CheckingLedgerRebuildRefused(
      accountId,
      plan.unfoldable.map(
        (u) =>
          `${cartola.period_month}: cartola row ${u.row_id} (${u.bank_day}, ${u.amount_clp}) carries what the user filed, the new cartola no longer lists it and no kept row of its day and pesos takes it`
      ),
      "would drop filed work"
    );
  }
  refuseTaxSettlementsLeftBehind(accountId, cartola, plan, dbHandle);
  // A replaced month whose kept rows the cartola prints in other text: what the pages show of them
  // is read before the write and carried across it (`checkingRestatementCarry.ts`).
  const identity = opts?.replaceMonth === true && keptRowTextChanges(input, plan) ? restatementIdentityHook() : null;
  const identityBefore = identity ? identity.snapshot(accountId, [cartola.period_month]) : null;
  let restatementCarry: RestatementCarry | null = null;
  const changesBefore = totalChanges(dbHandle);
  let anchorDerived: CheckingLedgerAnchorAt | null = null;
  let applied: ReturnType<typeof applyCheckingCartolaPlan>;
  try {
    applied = applyCheckingCartolaPlan(accountId, cartola, plan, dbHandle, {
      replaceMonth: opts?.replaceMonth === true,
      afterWrite: () => {
        anchorDerived = assertCartolaLedgerAfterApply(accountId, cartola, frame, dbHandle);
        if (identity) restatementCarry = identity.carry(accountId, cartola, identityBefore, dbHandle);
      },
    });
  } catch (e) {
    if (e instanceof TaxSettlementRepointError) {
      throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "tax_settlement", [`${e.message}; nothing of this cartola was written`]);
    }
    throw e;
  }
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
    partialsFolded: plan.fold.filter((f) => f.why === "daily_listing").length,
    partialsRemoved: dailyRemoved,
    cartolaRowsRemoved: plan.remove.length - dailyRemoved,
    cartolaRowsFolded: plan.fold.filter((f) => f.why === "replaced_cartola_row").length,
    fold_conflicts: applied.fold_conflicts,
    wrote: totalChanges(dbHandle) !== changesBefore,
    inserted_flows,
    skipped_flows,
    flow_adoptions: applied.flow_adoptions,
    listed_row_folds: applied.listed_row_folds,
    left_alone: applied.left_alone,
    restatement_carry: restatementCarry,
    anchor_derived: anchorDerived,
  };
}

/** Whether a kept cartola row of the month is printed in other text (description, document, branch). */
function keptRowTextChanges(input: ReturnType<typeof loadCheckingCartolaPlanInput>, plan: CheckingCartolaPlan): boolean {
  const rows = new Map(input.rows.map((r) => [r.id, r]));
  return plan.keep.some((k) => {
    const row = rows.get(k.row_id);
    if (row?.kind !== "cartola" || row.listed == null) return false;
    const mv = input.movements[k.movement]!;
    return row.listed.description !== mv.listed.description || row.listed.document_no !== mv.listed.document_no || (bankRowText(row.id).branch ?? "") !== (mv.branch || "—");
  });
}

/**
 * A replaced month's row a tax settlement names that the new cartola no longer lists would stay
 * beside the rows that record the month (no row takes its money, so the settlement cannot move):
 * the import is refused naming the row, the table and the tax year.
 */
function refuseTaxSettlementsLeftBehind(accountId: number, cartola: ParsedCheckingCartola, plan: CheckingCartolaPlan, dbHandle: Database): void {
  const problems: string[] = [];
  for (const l of plan.left_alone) {
    for (const table of l.tables.filter((t) => t === "f22_settlements" || t === "us_f1040_settlements")) {
      const years = (dbHandle.prepare(`SELECT DISTINCT tax_year FROM ${table} WHERE movement_id = ? ORDER BY tax_year`).all(l.row_id) as { tax_year: number }[]).map((r) => r.tax_year);
      const row = dbHandle.prepare(`SELECT occurred_on, amount FROM movements WHERE id = ?`).get(l.row_id) as { occurred_on: string; amount: number };
      problems.push(
        `movement ${l.row_id} (${row.occurred_on}, ${row.amount} CLP) is named by ${table} of tax year ${years.join(", ")}, and the cartola lists no movement for it: ` +
          `link the settlement to the row that records its money, then import again`
      );
    }
  }
  if (problems.length > 0) throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "tax_settlement", problems);
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

/**
 * Whether the month's record names the cartola's own document (by basename): the document it was
 * imported from, or the second document that confirmed it (`checkingCartolaCrossCheck.ts`).
 */
export function cartolaMonthRecordNamesFile(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): boolean {
  const row = dbHandle
    .prepare(`SELECT source_file, confirmed_by_file FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .get(accountId, cartola.period_month) as { source_file: string; confirmed_by_file: string | null } | undefined;
  if (row == null) return false;
  const own = cartolaSourceFileBasename(cartola.source_file);
  return cartolaSourceFileBasename(row.source_file) === own || (row.confirmed_by_file != null && cartolaSourceFileBasename(row.confirmed_by_file) === own);
}

/** The month record's own period (DESDE / HASTA of the document it was imported from). */
function cartolaMonthRecordPeriod(accountId: number, periodMonth: string, dbHandle: Database = db): CartolaMonthPeriod {
  const row = dbHandle
    .prepare(`SELECT period_month, period_from, period_to FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .get(accountId, periodMonth) as CartolaMonthPeriod | undefined;
  if (row == null) throw new Error(`account ${accountId}: no cartola month ${periodMonth} on file`);
  return row;
}

/** The DESDE of the next month's cartola on file (the bank's statement of this month's close), or null. */
function nextCartolaMonthDesde(accountId: number, periodMonth: string, dbHandle: Database = db): string | null {
  const row = dbHandle
    .prepare(`SELECT period_from FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .get(accountId, addCalendarMonths(periodMonth, 1)) as { period_from: string | null } | undefined;
  return row?.period_from ?? null;
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

function skippedAlreadyImported(label: string, cartola: ParsedCheckingCartola): CheckingCartolaFileImportLog {
  return {
    file: label,
    period_month: cartola.period_month,
    status: "skipped_already_imported",
    movements_parsed: cartola.movements.length,
    movements_imported: 0,
    skipped_rows: cartola.skipped,
    saldo_final_clp: cartola.saldo_final_clp,
    saldo_inicial_clp: cartola.saldo_inicial_clp,
  };
}

/** A refused cartola's log: nothing of it was written; its problems, one per line. */
function refusedLog(label: string, cartola: ParsedCheckingCartola, refusal: CartolaImportRefusal): CheckingCartolaFileImportLog {
  return {
    ...fileLogFromCartola(label, cartola, { status: "refused", movements_imported: 0 }),
    error: refusal.message,
    problems: refusal.problems,
  };
}

export function importCartolaList(
  accountId: number,
  cartolas: { cartola: ParsedCheckingCartola; label: string }[],
  opts: { wipe?: boolean; dryRun?: boolean; forceReimport?: boolean; forceSameFileOnly?: boolean },
  fileLogs: CheckingCartolaFileImportLog[],
  /** Collects each imported cartola's rows, for an upload's result view. */
  flows?: { inserted: ImportFlowItem[]; skipped: SkippedImportFlowItem[] }
): void {
  // The anchor a cartola of this run derived (it starts the history): the run's next cartolas are
  // checked against it, and `finishCartolaImportRun` writes it.
  let runAnchor: CheckingLedgerAnchorAt | null = null;
  // Oldest month first, whatever order the feeder read the documents in (a stable sort: one
  // month's documents keep their order): the guard checks each month against the ones before it.
  const ordered = [...cartolas].sort((a, b) => ymCompare(a.cartola.period_month, b.cartola.period_month));
  for (const { cartola, label } of ordered) {
    if (isPhantomBoundaryCartolaSlice(cartola)) {
      console.log(
        `  skip phantom boundary month ${cartola.period_month} (${cartola.source_file}, 0 movements)`
      );
      continue;
    }
    // A month on file is written again only when the file replaces it: forced (`forceReimport`;
    // with `forceSameFileOnly`, only a month whose record names this document), or, for a document
    // covering part of a month, fuller (`cartolaImportShouldReplaceExisting`). Then it is a diff
    // against the month's rows (restate, insert, remove what the new file no longer lists). The
    // same document again writes nothing (its printed saldo only refreshes its record); another
    // document covering the whole month, as the month on file does, is a cross-check
    // (`checkingCartolaCrossCheck.ts`): equal confirms the month, different is refused. Decided
    // before the account's rows are read.
    const onFile = !opts.wipe && isCheckingCartolaMonthImported(accountId, cartola.period_month);
    const sameDocument = onFile && cartolaMonthRecordNamesFile(accountId, cartola);
    const forced = opts.forceReimport === true && (!opts.forceSameFileOnly || sameDocument);
    // On file and reaching the import: forced, or replaced by a fuller document.
    const replaceMonth = onFile;
    if (onFile && !forced) {
      if (sameDocument) {
        if (shouldBackfillCartolaSaldoRef(accountId, cartola)) {
          try {
            assertCartolaSaldoRefreshAgrees(accountId, cartola);
          } catch (e) {
            if (!(e instanceof CartolaImportRefusal)) throw e;
            fileLogs.push(refusedLog(label, cartola, e));
            continue;
          }
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
        fileLogs.push(skippedAlreadyImported(label, cartola));
        continue;
      }
      const nextDesde = nextCartolaMonthDesde(accountId, cartola.period_month);
      if (cartolaCoversWholeMonth(cartolaMonthRecordPeriod(accountId, cartola.period_month), nextDesde) && cartolaCoversWholeMonth(cartola, nextDesde)) {
        let comparison: ReturnType<typeof compareCartolaWithMonthOnFile>;
        try {
          comparison = compareCartolaWithMonthOnFile(accountId, cartola);
        } catch (e) {
          fileLogs.push(logParseError(label, e, cartola.period_month));
          continue;
        }
        const diffs = comparison.differences;
        if (diffs.length === 0) {
          if (!opts.dryRun) recordCartolaMonthConfirmed(accountId, cartola);
          for (const o of comparison.order) console.log(`  ORDER ${label}: ${o}`);
          fileLogs.push({ ...fileLogFromCartola(label, cartola, { status: "confirmed", movements_imported: 0 }), ...(comparison.order.length > 0 ? { order_notes: comparison.order } : {}) });
          continue;
        }
        const problems = diffs.map((d) => describeCartolaMonthDifference(cartola.period_month, d));
        console.error(`  REFUSED ${label}: it states ${cartola.period_month} differently from the month on file:\n    ${problems.join("\n    ")}`);
        fileLogs.push(refusedLog(label, cartola, new CartolaImportRefusal(cartola.period_month, cartola.source_file, "second_document_differs", problems)));
        continue;
      }
      if (!cartolaImportShouldReplaceExisting(accountId, cartola)) {
        fileLogs.push(skippedAlreadyImported(label, cartola));
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
      const r = importCheckingCartola(accountId, cartola, db, { replaceMonth, runAnchor });
      if (r.anchor_derived) runAnchor = r.anchor_derived;
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
      for (const c of r.fold_conflicts) console.log(`  cartola ${cartola.period_month}: ${checkingFoldConflictReport(c)}`);
      if (r.left_alone.length > 0) {
        console.log(
          `  cartola ${cartola.period_month}: LEFT AS THEY ARE (a record names them; the month lists their money elsewhere): ` +
            r.left_alone.map((x) => `row ${x.row_id} (${x.why}; ${x.tables.join(", ")})`).join("; ")
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
      if (r.restatement_carry && !restatementCarryIsEmpty(r.restatement_carry)) {
        console.log(`  cartola ${cartola.period_month} read in other text:\n${describeRestatementCarry(r.restatement_carry).join("\n")}`);
      }
      flows?.inserted.push(...r.inserted_flows);
      flows?.skipped.push(...r.skipped_flows);
      fileLogs.push({
        ...fileLogFromCartola(label, cartola, {
          status: "imported",
          movements_imported: r.movementsInserted,
        }),
        ...(r.anchor_derived ? { anchor_derived: true } : {}),
        ...(r.restatement_carry ? { restatement_carry: r.restatement_carry } : {}),
      });
    } catch (e) {
      if (e instanceof CartolaImportRefusal) {
        console.error(`  REFUSED ${label}: ${e.problems.join("; ")}`);
        fileLogs.push(refusedLog(label, cartola, e));
        continue;
      }
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
    // The anchor stays pinned unless a cartola of this run derived it (it starts the history, or
    // none was on file): that cartola was checked against the anchor written here.
    let anchor: ReturnType<typeof ensureCheckingLedgerAnchor>;
    try {
      anchor = ensureCheckingLedgerAnchor(accountId, db, { repin: fileLogs.some((f) => f.anchor_derived === true) });
    } catch (e) {
      // The ledger disagrees with the cartolas on file for a reason no cartola of this run caused
      // (each was checked): reported as its own entry; the cartolas this run imported stay.
      if (!(e instanceof CheckingLedgerAnchorPinnedError)) throw e;
      console.error(`  LEDGER ANCHOR: ${e.message}`);
      fileLogs.push({
        file: "(ledger anchor)",
        period_month: "",
        status: "refused",
        movements_parsed: 0,
        movements_imported: 0,
        skipped_rows: [],
        saldo_final_clp: null,
        saldo_inicial_clp: null,
        error: e.message,
        problems: [e.message],
      });
      anchor = { inserted: false, updated: false, cleared: false, amount_clp: null, occurred_on: null, anchor_period_month: null };
    }
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

/**
 * The rebuild was refused, everything it did rolled back: it ended with months off their cartolas,
 * or it would drop a replaced cartola row with filed work no kept row takes.
 */
export class CheckingLedgerRebuildRefused extends Error {
  constructor(readonly accountId: number, readonly problems: string[], what = "leaves printed balance(s) off the ledger") {
    super(`account ${accountId}: the rebuild ${what} (${problems.length}), rolled back:\n  ${problems.join("\n  ")}`);
  }
}

export type CheckingLedgerRebuildResult = {
  anchor_before: { amount_clp: number; occurred_on: string } | null;
  anchor_after: { amount_clp: number; occurred_on: string } | null;
  months: {
    period_month: string;
    replaced: boolean;
    inserted: number;
    restated: number;
    folded: number;
    removed: number;
    cartola_rows_removed: number;
    /** Replaced cartola rows folded into the kept row of their bank day and pesos (what was filed on them moved). */
    cartola_rows_folded: number;
    fold_conflicts: CheckingRowFoldConflict[];
    /** Set when the slice was not imported: the month's record names another document that owns it. */
    owned_by?: string;
    restatement_carry: RestatementCarry | null;
  }[];
};

/**
 * The deliberate repair of a cartola account whose ledger and anchor absorbed bad data (rows
 * written twice, the anchor moved to hide them): the given cartolas are imported again in place
 * (each month on file replaced, `replaceMonth`), oldest first, without the per-cartola ledger
 * guard (it reads the anchor being repaired); then the anchor is derived again from the newest
 * cartola (`repin`), and every cartola month on file must hold — its printed opening and closing
 * balance against the ledger (`checkingLedgerMonthsOffTheirCartolas`) — or the whole rebuild rolls
 * back (`CheckingLedgerRebuildRefused`). A replaced month's cartola row the new cartola no longer
 * lists folds into the kept row of its bank day and signed pesos (`CheckingCartolaPlanInput.rebuild`),
 * so what the user filed on a copy moves to the row that stays; one with filed work and no such row
 * refuses the rebuild naming it. `sameFileOnly` (the cuenta vista, whose documents straddle months):
 * a month on file is replaced only by the document its record names, or by a fuller one — the
 * import's ownership rule (`importCartolaList`'s `forceSameFileOnly`); another document's slice is
 * left out, reported as `owned_by`. One transaction. Run by hand only
 * (`server/scripts/rebuild-checking-ledger-from-cartolas.ts`, report-first).
 */
export function rebuildCheckingLedgerFromCartolas(
  accountId: number,
  cartolas: ParsedCheckingCartola[],
  dbHandle: Database = db,
  opts: { sameFileOnly?: boolean } = {}
): CheckingLedgerRebuildResult {
  return dbHandle.transaction(() => {
    const anchorBefore = storedCheckingLedgerAnchor(accountId, dbHandle);
    const months: CheckingLedgerRebuildResult["months"] = [];
    for (const cartola of [...cartolas].sort((a, b) => ymCompare(a.period_month, b.period_month))) {
      const replaced = isCheckingCartolaMonthImported(accountId, cartola.period_month, dbHandle);
      if (
        replaced &&
        opts.sameFileOnly &&
        !cartolaMonthRecordNamesFile(accountId, cartola, dbHandle) &&
        !cartolaImportShouldReplaceExisting(accountId, cartola, dbHandle)
      ) {
        const owner = (dbHandle.prepare(`SELECT source_file FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).get(accountId, cartola.period_month) as {
          source_file: string;
        }).source_file;
        months.push({ period_month: cartola.period_month, replaced: false, inserted: 0, restated: 0, folded: 0, removed: 0, cartola_rows_removed: 0, cartola_rows_folded: 0, fold_conflicts: [], restatement_carry: null, owned_by: owner });
        continue;
      }
      const r = importCheckingCartola(accountId, cartola, dbHandle, { replaceMonth: replaced, rebuild: true });
      months.push({
        period_month: cartola.period_month,
        replaced,
        inserted: r.movementsInserted,
        restated: r.partialsRestated + r.movementsSkipped,
        folded: r.partialsFolded,
        removed: r.partialsRemoved,
        cartola_rows_removed: r.cartolaRowsRemoved,
        cartola_rows_folded: r.cartolaRowsFolded,
        fold_conflicts: r.fold_conflicts,
        restatement_carry: r.restatement_carry,
      });
    }
    clearCheckingAccountValuations(accountId, dbHandle);
    ensureCheckingLedgerAnchor(accountId, dbHandle, { repin: true });
    const off = checkingLedgerMonthsOffTheirCartolas(accountId, dbHandle);
    if (off.length > 0) throw new CheckingLedgerRebuildRefused(accountId, off);
    const after = storedCheckingLedgerAnchor(accountId, dbHandle);
    return {
      anchor_before: anchorBefore && { amount_clp: anchorBefore.amount_clp, occurred_on: anchorBefore.occurred_on },
      anchor_after: after && { amount_clp: after.amount_clp, occurred_on: after.occurred_on },
      months,
    };
  })();
}
