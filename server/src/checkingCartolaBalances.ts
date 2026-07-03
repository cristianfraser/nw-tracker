import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { parseCheckingCartolaFile } from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import { isCartolaDesdeBoundaryPhantomMonth, monthEndUtcYmd, monthKeyFromYmd, ymCompare } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { sumClpThroughDate } from "./movementTransfer.js";

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
  return sumClpThroughDate(accountId, asOfYmd, dbHandle);
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

const ANCHOR_NOTE_PREFIX = "import:cartola|anchor|";
const OPENING_NOTE_PREFIX = "import:cartola|opening|";

export type CheckingLedgerAnchorDto = {
  movement_id: number;
  amount_clp: number;
  occurred_on: string;
  anchor_period_month: string;
  cartola_saldo_final_clp: number;
  cartola_derived_amount_clp: number;
};

export type CartolaDerivedAnchorDto = {
  period_month: string;
  occurred_on: string;
  amount_clp: number;
};

export type EnsureCheckingLedgerAnchorResult = {
  inserted: boolean;
  updated: boolean;
  cleared: boolean;
  amount_clp: number | null;
  occurred_on: string | null;
  anchor_period_month: string | null;
};

/**
 * Fill saldo_inicial / period_from on import rows left empty by migration 053.
 * Reads cartola PDFs from cfraser/ — import-time only; request paths must not call this
 * (they read SQLite only). The cartola import runs it before ensureCheckingLedgerAnchor.
 */
export function backfillCheckingImportSaldoInicial(
  accountId: number,
  dbHandle: Database = db
): void {
  const rows = dbHandle
    .prepare(
      `SELECT period_month, source_file, saldo_inicial_clp
       FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as { period_month: string; source_file: string; saldo_inicial_clp: number | null }[];
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
    } catch (e) {
      console.warn(
        `saldo_inicial backfill: could not parse ${filePath} for ${row.period_month}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
}

export function checkingLedgerAnchorNote(periodMonth: string): string {
  return `${ANCHOR_NOTE_PREFIX}${periodMonth}|saldo final`;
}

export function isCheckingLedgerAnchorNote(note: string | null | undefined): boolean {
  return note != null && note.startsWith(ANCHOR_NOTE_PREFIX);
}

function priorMonthYm(periodMonth: string): string {
  const [py, pm] = periodMonth.split("-").map(Number);
  if (pm === 1) return `${py - 1}-12`;
  return `${py}-${String(pm - 1).padStart(2, "0")}`;
}

/** Month-end of the month before `startMonth` (default ledger offset placement). */
export function defaultCheckingLedgerAnchorDate(startMonth: string): string {
  return monthEndUtcYmd(priorMonthYm(startMonth));
}

/** Earliest month from cartola imports or movement dates (same sources as month table timeline). */
export function getCheckingTimelineStartMonth(
  accountId: number,
  dbHandle: Database = db
): string | null {
  const keys = new Set<string>();

  try {
    const imports = dbHandle
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
    for (const r of imports) {
      if (
        isCartolaDesdeBoundaryPhantomMonth({
          period_month: r.period_month,
          period_from: r.period_from,
          period_to: r.period_to,
          movement_count: Number(r.movement_count) || 0,
        })
      ) {
        continue;
      }
      keys.add(r.period_month);
    }
  } catch {
    /* migration not applied */
  }

  for (const r of dbHandle
    .prepare(`SELECT occurred_on FROM movements WHERE account_id = ?`)
    .all(accountId) as { occurred_on: string }[]) {
    const mk = monthKeyFromYmd(r.occurred_on);
    if (mk) keys.add(mk);
  }

  if (keys.size === 0) return null;
  return [...keys].sort(ymCompare)[0]!;
}

function defaultAnchorPlacementDate(
  accountId: number,
  dbHandle: Database = db
): string | null {
  const startMonth = getCheckingTimelineStartMonth(accountId, dbHandle);
  if (!startMonth) return null;
  return defaultCheckingLedgerAnchorDate(startMonth);
}

function deleteLegacyOpeningMovements(accountId: number, dbHandle: Database = db): number {
  const r = dbHandle
    .prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`)
    .run(accountId, `${OPENING_NOTE_PREFIX}%`);
  if (r.changes > 0) clearCheckingBalanceCache(accountId);
  return r.changes;
}

function getLatestCartolaSaldoFinal(
  accountId: number,
  dbHandle: Database = db
): { period_month: string; saldo_final_clp: number } | null {
  const row = dbHandle
    .prepare(
      `SELECT period_month, saldo_final_clp
       FROM checking_cartola_imports
       WHERE account_id = ? AND saldo_final_clp IS NOT NULL
       ORDER BY period_month DESC
       LIMIT 1`
    )
    .get(accountId) as { period_month: string; saldo_final_clp: number } | undefined;
  if (!row || !Number.isFinite(row.saldo_final_clp)) return null;
  return { period_month: row.period_month, saldo_final_clp: Math.round(row.saldo_final_clp) };
}

/** Sum movements excluding anchor and legacy opening rows (through `asOfYmd` inclusive). */
function sumNonAnchorMovementsClpAt(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const row = dbHandle
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS total
       FROM movements
       WHERE account_id = ? AND occurred_on <= ?
         AND (note IS NULL OR (
           note NOT LIKE 'import:cartola|anchor|%'
           AND note NOT LIKE 'import:cartola|opening|%'
         ))`
    )
    .get(accountId, asOfYmd) as { total: number };
  return Math.round(Number(row.total));
}

function computeDerivedAnchorAmount(
  accountId: number,
  saldoFinal: number,
  anchorDate: string,
  dbHandle: Database = db
): number {
  const sum = sumNonAnchorMovementsClpAt(accountId, anchorDate, dbHandle);
  return Math.round(saldoFinal - sum);
}

export function getCartolaDerivedAnchor(
  accountId: number,
  dbHandle: Database = db
): CartolaDerivedAnchorDto | null {
  const latest = getLatestCartolaSaldoFinal(accountId, dbHandle);
  if (!latest) return null;
  const occurredOn = defaultAnchorPlacementDate(accountId, dbHandle);
  if (!occurredOn) return null;
  const amountCutoff = monthEndUtcYmd(latest.period_month);
  const amount = computeDerivedAnchorAmount(
    accountId,
    latest.saldo_final_clp,
    amountCutoff,
    dbHandle
  );
  return { period_month: latest.period_month, occurred_on: occurredOn, amount_clp: amount };
}

export function getCheckingLedgerAnchor(
  accountId: number,
  dbHandle: Database = db
): CheckingLedgerAnchorDto | null {
  const latest = getLatestCartolaSaldoFinal(accountId, dbHandle);
  if (!latest) return null;

  const existing = dbHandle
    .prepare(
      `SELECT id, amount_clp, occurred_on FROM movements
       WHERE account_id = ? AND note LIKE ?
       LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as
    | { id: number; amount_clp: number; occurred_on: string }
    | undefined;
  if (!existing) return null;

  const amountCutoff = monthEndUtcYmd(latest.period_month);
  const derivedAmount = computeDerivedAnchorAmount(
    accountId,
    latest.saldo_final_clp,
    amountCutoff,
    dbHandle
  );

  return {
    movement_id: existing.id,
    amount_clp: Math.round(existing.amount_clp),
    occurred_on: existing.occurred_on,
    anchor_period_month: latest.period_month,
    cartola_saldo_final_clp: latest.saldo_final_clp,
    cartola_derived_amount_clp: derivedAmount,
  };
}

export function clearCheckingLedgerAnchor(accountId: number, dbHandle: Database = db): boolean {
  const r = dbHandle
    .prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`)
    .run(accountId, `${ANCHOR_NOTE_PREFIX}%`);
  if (r.changes > 0) clearCheckingBalanceCache(accountId);
  return r.changes > 0;
}

/** UI save: keep user amount/date; note uses latest cartola month as target. */
export function upsertCheckingLedgerAnchor(
  accountId: number,
  input: { amount_clp: number; occurred_on: string },
  dbHandle: Database = db
): CheckingLedgerAnchorDto | null {
  const latest = getLatestCartolaSaldoFinal(accountId, dbHandle);
  if (!latest) return null;

  const amount = Math.round(input.amount_clp);
  const occurredOn = input.occurred_on;
  const note = checkingLedgerAnchorNote(latest.period_month);

  const existing = dbHandle
    .prepare(
      `SELECT id FROM movements WHERE account_id = ? AND note LIKE ? LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as { id: number } | undefined;

  if (existing) {
    dbHandle
      .prepare(`UPDATE movements SET amount_clp = ?, occurred_on = ?, note = ? WHERE id = ?`)
      .run(amount, occurredOn, note, existing.id);
  } else {
    dbHandle
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(accountId, amount, occurredOn, note);
  }

  clearCheckingBalanceCache(accountId);
  return getCheckingLedgerAnchor(accountId, dbHandle);
}

/**
 * Insert or update one ledger offset from the latest cartola saldo final.
 * Amount aligns ledger at latest month-end; default date is month-end before first timeline month.
 * Reads SQLite only — safe on request paths (POST /movements via maybeSyncCheckingLedgerAnchor).
 * The cartola import runs backfillCheckingImportSaldoInicial (cfraser/ file reads) beforehand.
 */
export function ensureCheckingLedgerAnchor(
  accountId: number,
  dbHandle: Database = db
): EnsureCheckingLedgerAnchorResult {
  deleteLegacyOpeningMovements(accountId, dbHandle);

  const latest = getLatestCartolaSaldoFinal(accountId, dbHandle);
  if (!latest) {
    const cleared = clearCheckingLedgerAnchor(accountId, dbHandle);
    return {
      inserted: false,
      updated: false,
      cleared,
      amount_clp: null,
      occurred_on: null,
      anchor_period_month: null,
    };
  }

  const periodMonth = latest.period_month;
  const occurredOn = defaultAnchorPlacementDate(accountId, dbHandle);
  if (!occurredOn) {
    return {
      inserted: false,
      updated: false,
      cleared: false,
      amount_clp: null,
      occurred_on: null,
      anchor_period_month: periodMonth,
    };
  }
  const amountCutoff = monthEndUtcYmd(periodMonth);
  const amount = computeDerivedAnchorAmount(
    accountId,
    latest.saldo_final_clp,
    amountCutoff,
    dbHandle
  );
  const note = checkingLedgerAnchorNote(periodMonth);

  const existing = dbHandle
    .prepare(
      `SELECT id, amount_clp, occurred_on, note FROM movements
       WHERE account_id = ? AND note LIKE ?
       LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as
    | { id: number; amount_clp: number; occurred_on: string; note: string }
    | undefined;

  if (existing) {
    if (
      Math.round(existing.amount_clp) === amount &&
      existing.occurred_on === occurredOn &&
      existing.note === note
    ) {
      return {
        inserted: false,
        updated: false,
        cleared: false,
        amount_clp: amount,
        occurred_on: occurredOn,
        anchor_period_month: periodMonth,
      };
    }
    dbHandle
      .prepare(`UPDATE movements SET amount_clp = ?, occurred_on = ?, note = ? WHERE id = ?`)
      .run(amount, occurredOn, note, existing.id);
    clearCheckingBalanceCache(accountId);
    return {
      inserted: false,
      updated: true,
      cleared: false,
      amount_clp: amount,
      occurred_on: occurredOn,
      anchor_period_month: periodMonth,
    };
  }

  dbHandle
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amount, occurredOn, note);

  clearCheckingBalanceCache(accountId);
  return {
    inserted: true,
    updated: false,
    cleared: false,
    amount_clp: amount,
    occurred_on: occurredOn,
    anchor_period_month: periodMonth,
  };
}

/** Re-sync anchor after manual movement on a cash cartola account. */
export function maybeSyncCheckingLedgerAnchor(
  accountId: number,
  bucketKindSlug: string,
  dbHandle: Database = db
): void {
  if (!isMovementBalanceCashCategory(bucketKindSlug)) return;
  ensureCheckingLedgerAnchor(accountId, dbHandle);
}
