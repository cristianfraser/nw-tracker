import type { Database } from "better-sqlite3";
import { insertAppMessage } from "./appMessages.js";
import { db } from "./db.js";
import { monthKeyFromYmd, monthEndUtcYmd } from "./calendarMonth.js";
import type { MonthKey } from "./cfraserCsv.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import {
  loadPre2020CheckingExcelBalances,
  pre2020SyntheticMonthKeys,
  previousMonthKey,
  PRE2020_SYNTHETIC_FIRST_MONTH,
} from "./checkingPre2020ExcelBalances.js";
import { listPre2020SourceDeposits, type Pre2020SourceDeposit } from "./checkingPre2020SourceDeposits.js";

export const CHECKING_SYNTHETIC_NOTE_PREFIX = "import:checking-synthetic|";

export function realSyntheticNote(periodMonth: string, categorySlug: string, sourceMovementId: number): string {
  return `${CHECKING_SYNTHETIC_NOTE_PREFIX}real|${periodMonth}|src:${categorySlug}|mov:${sourceMovementId}`;
}

export function mirrorSyntheticNote(periodMonth: string, targetEnd: number): string {
  return `${CHECKING_SYNTHETIC_NOTE_PREFIX}mirror|${periodMonth}|excel-target=${targetEnd}`;
}

/** Future: credit card MONTO CANCELADO → checking withdrawal when pre-2020 CC import exists. */
export function ccPaymentSyntheticNote(periodMonth: string, cardLabel: string): string {
  return `${CHECKING_SYNTHETIC_NOTE_PREFIX}real|${periodMonth}|cc|MONTO CANCELADO|${cardLabel}`;
}

export type Pre2020SyntheticRunResult = {
  account_id: number;
  dry_run: boolean;
  excel_months: number;
  deleted_prior: number;
  real_inserted: number;
  mirror_inserted: number;
  by_month: {
    period_month: string;
    target_end_clp: number;
    start_balance_clp: number;
    known_delta_clp: number;
    mirror_clp: number;
    real_count: number;
  }[];
};

export function computeMirrorAmount(
  targetEnd: number,
  startBalance: number,
  knownDelta: number
): number {
  return Math.round(targetEnd - startBalance - knownDelta);
}

export function deleteCheckingSyntheticMovements(
  accountId: number,
  dbHandle: Database = db
): number {
  const r = dbHandle
    .prepare(
      `DELETE FROM movements WHERE account_id = ? AND note LIKE ?`
    )
    .run(accountId, `${CHECKING_SYNTHETIC_NOTE_PREFIX}%`);
  clearCheckingBalanceCache(accountId);
  return r.changes;
}

function sumCheckingMovementsInMonth(
  accountId: number,
  periodMonth: string,
  dbHandle: Database
): number {
  const start = `${periodMonth}-01`;
  const end = monthEndUtcYmd(periodMonth);
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS total
       FROM movements
       WHERE account_id = ?
         AND occurred_on >= ?
         AND occurred_on <= ?
         AND note NOT LIKE 'import:cartola|opening|%'`
    )
    .get(accountId, start, end) as { total: number };
  return Math.round(Number(row.total));
}

function insertPre2020SyntheticAppLog(result: Pre2020SyntheticRunResult): void {
  if (result.dry_run) return;
  const lines: string[] = [
    `Account ${result.account_id}. Pre-2020 synthetic (${PRE2020_SYNTHETIC_FIRST_MONTH}–2019-12).`,
    `Deleted prior: ${result.deleted_prior}. Real synthetic: ${result.real_inserted}. Mirror: ${result.mirror_inserted}.`,
  ];
  for (const m of result.by_month) {
    if (m.mirror_clp === 0 && m.real_count === 0) continue;
    lines.push(
      `  ${m.period_month}: target=${m.target_end_clp} start=${m.start_balance_clp} ` +
        `delta=${m.known_delta_clp} mirror=${m.mirror_clp} real=${m.real_count}`
    );
  }
  const title = `Checking pre-2020 synthetic ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  insertAppMessage("log", title, lines.join("\n"));
}

export function buildPre2020SyntheticHistory(opts?: {
  accountId?: number;
  dryRun?: boolean;
  excelPath?: string;
  dbHandle?: Database;
}): Pre2020SyntheticRunResult {
  const dbHandle = opts?.dbHandle ?? db;
  const accountId = opts?.accountId ?? checkingAccountId(dbHandle);
  const dryRun = !!opts?.dryRun;

  const excel = loadPre2020CheckingExcelBalances(opts?.excelPath);
  const months = pre2020SyntheticMonthKeys();

  let deletedPrior = 0;
  if (!dryRun) {
    deletedPrior = deleteCheckingSyntheticMovements(accountId, dbHandle);
  }

  const sources = listPre2020SourceDeposits(dbHandle);
  const ins = dbHandle.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
     VALUES (?, ?, ?, ?, NULL)`
  );

  let realInserted = 0;
  for (const src of sources) {
    const periodMonth = monthKeyFromYmd(src.occurred_on);
    const note = realSyntheticNote(periodMonth, src.category_slug, src.movement_id);
    if (!dryRun) {
      ins.run(accountId, -Math.round(src.amount_clp), src.occurred_on, note);
    }
    realInserted += 1;
  }

  const byMonth: Pre2020SyntheticRunResult["by_month"] = [];
  let mirrorInserted = 0;

  for (const periodMonth of months) {
    const targetEnd = excel.get(periodMonth);
    if (targetEnd == null) {
      console.warn(`pre-2020 synthetic: no Excel balance for ${periodMonth}, skipping mirror`);
      continue;
    }

    const prev = previousMonthKey(periodMonth);
    const startBalance =
      periodMonth === PRE2020_SYNTHETIC_FIRST_MONTH
        ? 0
        : (prev ? excel.get(prev) : null) ?? 0;

    const knownDelta = dryRun
      ? sumCheckingMonthDeltaDryRun(accountId, periodMonth, sources, dbHandle)
      : sumCheckingMovementsInMonth(accountId, periodMonth, dbHandle);

    const mirror = computeMirrorAmount(targetEnd, startBalance, knownDelta);
    const realCount = sources.filter((s) => monthKeyFromYmd(s.occurred_on) === periodMonth).length;

    byMonth.push({
      period_month: periodMonth,
      target_end_clp: targetEnd,
      start_balance_clp: startBalance,
      known_delta_clp: knownDelta,
      mirror_clp: mirror,
      real_count: realCount,
    });

    if (mirror !== 0) {
      if (!dryRun) {
        ins.run(
          accountId,
          mirror,
          monthEndUtcYmd(periodMonth),
          mirrorSyntheticNote(periodMonth, targetEnd)
        );
      }
      mirrorInserted += 1;
    }
  }

  if (!dryRun) {
    clearCheckingBalanceCache(accountId);
  }

  const result: Pre2020SyntheticRunResult = {
    account_id: accountId,
    dry_run: dryRun,
    excel_months: excel.size,
    deleted_prior: deletedPrior,
    real_inserted: realInserted,
    mirror_inserted: mirrorInserted,
    by_month: byMonth,
  };

  logPre2020SyntheticRun(result);
  insertPre2020SyntheticAppLog(result);
  return result;
}

/** Dry-run: non-synthetic movements in month plus prospective real withdrawals. */
function sumCheckingMonthDeltaDryRun(
  accountId: number,
  periodMonth: string,
  sources: Pre2020SourceDeposit[],
  dbHandle: Database
): number {
  const start = `${periodMonth}-01`;
  const end = monthEndUtcYmd(periodMonth);
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS total
       FROM movements
       WHERE account_id = ?
         AND occurred_on >= ?
         AND occurred_on <= ?
         AND note NOT LIKE ?
         AND note NOT LIKE 'import:cartola|opening|%'`
    )
    .get(accountId, start, end, `${CHECKING_SYNTHETIC_NOTE_PREFIX}%`) as { total: number };
  let sum = Math.round(Number(row.total));
  for (const s of sources) {
    if (monthKeyFromYmd(s.occurred_on) === periodMonth) {
      sum -= Math.round(s.amount_clp);
    }
  }
  return sum;
}

function logPre2020SyntheticRun(result: Pre2020SyntheticRunResult): void {
  const prefix = result.dry_run ? "[dry-run] " : "";
  console.log(
    `${prefix}Pre-2020 checking synthetic (account ${result.account_id}): ` +
      `${result.real_inserted} real, ${result.mirror_inserted} mirror, ` +
      `${result.excel_months} Excel month(s).`
  );
  if (result.deleted_prior > 0) {
    console.log(`  Removed ${result.deleted_prior} prior synthetic movement(s).`);
  }
}

/**
 * When pre-2020 CC statements are imported, call for each MONTO CANCELADO row
 * (amount_clp is negative in parsed CSV — stored as withdrawal from checking).
 */
export function createCheckingRealSyntheticFromCcPayment(
  opts: {
    accountId?: number;
    occurred_on: string;
    amount_clp: number;
    cardLabel: string;
    dryRun?: boolean;
  },
  dbHandle: Database = db
): { inserted: boolean; note: string } {
  const accountId = opts.accountId ?? checkingAccountId(dbHandle);
  const periodMonth = monthKeyFromYmd(opts.occurred_on);
  const note = ccPaymentSyntheticNote(periodMonth, opts.cardLabel);
  const amount = opts.amount_clp < 0 ? Math.round(opts.amount_clp) : -Math.round(Math.abs(opts.amount_clp));
  if (!opts.dryRun) {
    dbHandle
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(accountId, amount, opts.occurred_on, note);
    clearCheckingBalanceCache(accountId);
  }
  return { inserted: !opts.dryRun, note };
}
