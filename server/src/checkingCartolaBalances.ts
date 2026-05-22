import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { parseCheckingCartolaFile } from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import { monthEndUtcYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

const BALANCE_CACHE_TTL_MS = 30_000;
const balanceCache = new Map<string, { balance: number; expiresAt: number }>();

export function clearCheckingBalanceCache(accountId?: number): void {
  if (accountId == null) {
    balanceCache.clear();
    return;
  }
  const prefix = `${accountId}|`;
  for (const key of balanceCache.keys()) {
    if (key.startsWith(prefix)) balanceCache.delete(key);
  }
}

/** Running CLP balance from all movements on or before `asOfYmd` (inclusive). */
export function checkingMovementBalanceClpAt(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS total
       FROM movements
       WHERE account_id = ? AND occurred_on <= ?`
    )
    .get(accountId, asOfYmd) as { total: number };
  return Math.round(Number(row.total));
}

/** Cached wrapper for hot paths (API/charts); invalidated on movement writes via TTL. */
export function checkingMovementBalanceClpAtCached(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const key = `${accountId}|${asOfYmd}`;
  const now = Date.now();
  const hit = balanceCache.get(key);
  if (hit && hit.expiresAt > now) return hit.balance;
  const balance = checkingMovementBalanceClpAt(accountId, asOfYmd, dbHandle);
  balanceCache.set(key, { balance, expiresAt: now + BALANCE_CACHE_TTL_MS });
  return balance;
}

/** Month-end balance from movements only (not parsed cartola saldo). */
export function checkingMovementBalanceAtMonthEnd(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db
): number {
  return checkingMovementBalanceClpAtCached(accountId, monthEndUtcYmd(periodMonth), dbHandle);
}

/** Latest balance for summary cards (today in Chile). */
export function checkingMovementBalanceLive(
  accountId: number,
  dbHandle: Database = db
): { value_clp: number; as_of_date: string } {
  const asOf = chileCalendarTodayYmd();
  return {
    value_clp: checkingMovementBalanceClpAtCached(accountId, asOf, dbHandle),
    as_of_date: asOf,
  };
}

/**
 * Remove stale persisted `valuations` rows for cuenta corriente.
 * Balances are derived from movements at read time, not stored.
 */
export function clearCheckingAccountValuations(accountId: number, dbHandle: Database = db): number {
  const r = dbHandle.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
  clearCheckingBalanceCache(accountId);
  return r.changes;
}

const OPENING_NOTE_PREFIX = "import:cartola|opening|";

/** Fill saldo_inicial / period_from on import rows when migration 053 added empty columns. */
export function backfillCheckingImportSaldoInicial(
  accountId: number,
  dbHandle: Database = db
): void {
  let rows: { period_month: string; source_file: string; saldo_inicial_clp: number | null }[];
  try {
    rows = dbHandle
      .prepare(
        `SELECT period_month, source_file, saldo_inicial_clp
         FROM checking_cartola_imports WHERE account_id = ?`
      )
      .all(accountId) as typeof rows;
  } catch {
    return;
  }
  const dir = resolveCfraserCheckingCartolasDir();
  const upd = dbHandle.prepare(
    `UPDATE checking_cartola_imports
     SET saldo_inicial_clp = ?, period_from = ?
     WHERE account_id = ? AND period_month = ? AND saldo_inicial_clp IS NULL`
  );
  for (const row of rows) {
    if (row.saldo_inicial_clp != null) continue;
    const filePath = path.join(dir, row.source_file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const cartola = parseCheckingCartolaFile(filePath);
      upd.run(
        cartola.saldo_inicial_clp,
        cartola.period_from,
        accountId,
        row.period_month
      );
    } catch {
      /* unreadable file */
    }
  }
}

export function checkingOpeningMovementNote(periodMonth: string): string {
  return `${OPENING_NOTE_PREFIX}${periodMonth}|saldo inicial`;
}

/**
 * Insert one opening-balance movement from the earliest cartola's saldo inicial so the
 * ledger matches bank month-end balances (cumsum starts at statement opening, not zero).
 */
export function ensureCheckingOpeningBalance(accountId: number, dbHandle: Database = db): {
  inserted: boolean;
  amount_clp: number | null;
  occurred_on: string | null;
} {
  const existing = dbHandle
    .prepare(
      `SELECT 1 FROM movements WHERE account_id = ? AND note LIKE ? LIMIT 1`
    )
    .get(accountId, `${OPENING_NOTE_PREFIX}%`) as { 1: number } | undefined;
  if (existing) return { inserted: false, amount_clp: null, occurred_on: null };

  backfillCheckingImportSaldoInicial(accountId, dbHandle);

  let earliest: {
    period_month: string;
    saldo_inicial_clp: number | null;
    period_from: string | null;
  } | undefined;
  try {
    earliest = dbHandle
      .prepare(
        `SELECT period_month, saldo_inicial_clp, period_from
         FROM checking_cartola_imports
         WHERE account_id = ?
         ORDER BY period_month ASC
         LIMIT 1`
      )
      .get(accountId) as typeof earliest;
  } catch {
    return { inserted: false, amount_clp: null, occurred_on: null };
  }

  const saldoInicial = earliest?.saldo_inicial_clp;
  if (saldoInicial == null || !Number.isFinite(saldoInicial)) {
    return { inserted: false, amount_clp: null, occurred_on: null };
  }

  const periodMonth = earliest!.period_month;
  const occurredOn =
    earliest?.period_from && /^\d{4}-\d{2}-\d{2}$/.test(earliest.period_from)
      ? earliest.period_from
      : `${periodMonth}-01`;

  const [py, pm] = periodMonth.split("-").map(Number);
  const priorMonth =
    pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, "0")}`;
  const balanceAtPriorMonthEnd = checkingMovementBalanceClpAt(
    accountId,
    monthEndUtcYmd(priorMonth),
    dbHandle
  );
  if (Math.round(balanceAtPriorMonthEnd) === Math.round(saldoInicial)) {
    return { inserted: false, amount_clp: null, occurred_on: null };
  }

  dbHandle
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, Math.round(saldoInicial), occurredOn, checkingOpeningMovementNote(periodMonth));

  clearCheckingBalanceCache(accountId);
  return { inserted: true, amount_clp: Math.round(saldoInicial), occurred_on: occurredOn };
}
