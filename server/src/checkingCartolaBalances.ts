import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { parseCheckingCartolaFile } from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolasDir } from "./cfraserPaths.js";
import { isCartolaDesdeBoundaryPhantomMonth, monthEndUtcYmd, monthKeyFromYmd, ymCompare } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  MOVEMENT_AMOUNT_COLUMNS_SQL,
  movementClpLegOrZero,
  type MovementAmountFields,
} from "./movementAmounts.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import {
  displayLedgerCutoffYmd,
  signedClpDeltaForAccountMovement,
  sumClpThroughDisplayDate,
} from "./movementTransfer.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import type { MovementTransferRow } from "./movementTransfer.js";

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

/**
 * Running CLP balance for DISPLAY at `asOfYmd`: movements on or before that date, or every
 * known movement when the date is Chile today or later — a row the bank dates after today
 * (post-cutoff posting) already counts now and keeps counting once its date arrives
 * (`displayLedgerCutoffYmd`). Reconciliation against a cartola uses the strict readers
 * (`nonAnchorClpFlowTotals`, `checkingMovementBalanceAtMonthEnd`).
 */
export function checkingMovementBalanceClpAt(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  return sumClpThroughDisplayDate(accountId, asOfYmd, dbHandle);
}

function cachedBalance(key: string, compute: () => number): number {
  const now = Date.now();
  const hit = balanceCache.get(key);
  if (hit && hit.expiresAt > now) return hit.balance;
  const balance = compute();
  balanceCache.set(key, { balance, expiresAt: now + BALANCE_CACHE_TTL_MS });
  return balance;
}

/**
 * Cached wrapper for hot paths (API/charts); invalidated on movement writes via TTL. The key
 * carries the cutoff actually applied, so a value computed for "today" (no upper bound) is
 * never served as that date's strict history after the day rolls over.
 */
export function checkingMovementBalanceClpAtCached(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  return cachedBalance(`${accountId}|${asOfYmd}|${displayLedgerCutoffYmd(asOfYmd)}`, () =>
    checkingMovementBalanceClpAt(accountId, asOfYmd, dbHandle)
  );
}

/**
 * Month-end balance from movements only, strictly by the bank's posting day (never the display
 * read, never `occurred_on`): the cartola month table compares it against the statement's saldo
 * final, which is as-of the period end the bank printed (`movement_bank_postings`).
 */
export function checkingMovementBalanceAtMonthEnd(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db
): number {
  const asOf = monthEndUtcYmd(periodMonth);
  return cachedBalance(`${accountId}|${asOf}|bank`, () =>
    sumClpThroughBankPostedDate(accountId, asOf, dbHandle)
  );
}

/**
 * Running CLP balance through `asOfYmd` by the bank's posting day — the frame of a cartola.
 * Anchor rows included (they are part of the balance); same signed, transfer-aware accounting
 * as `sumClpThroughDate`.
 */
export function sumClpThroughBankPostedDate(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  const rows = dbHandle
    .prepare(
      `SELECT m.account_id, m.from_account_id, m.to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, m.flow_kind
       FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE (m.account_id = ? OR m.from_account_id = ? OR m.to_account_id = ?)
         AND ${BANK_POSTED_ON_SQL} <= ?`
    )
    .all(accountId, accountId, accountId, accountId, asOfYmd) as MovementTransferRow[];
  let total = 0;
  for (const r of rows) total += signedClpDeltaForAccountMovement(r, accountId);
  return Math.round(total);
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

/**
 * Every month with data for the account, sorted ascending: cartola import periods
 * (DESDE-boundary phantom months skipped) plus the calendar months of the account's
 * movements — transfer legs included (a transfer row carries the account in
 * `from_account_id`/`to_account_id` with `account_id` NULL, so a `WHERE account_id = ?`
 * scan misses it; see `nonAnchorClpFlowTotals`). Shared by the month-summary table grid
 * and the anchor placement so the two can't disagree on where history starts.
 *
 * Synthetic anchor/opening rows are excluded: the anchor is dated the month-end BEFORE
 * the first timeline month, so counting its own month made the timeline self-referential
 * and every re-derivation walked the anchor one month further into the past (found
 * 2026-08: the real cuenta vista anchor had drifted 2016-10-31 → 2016-04-30).
 */
export function checkingTimelineMonthKeys(
  accountId: number,
  dbHandle: Database = db
): string[] {
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
    .prepare(
      `SELECT ${BANK_POSTED_ON_SQL} AS posted_on FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE (m.account_id = ? OR m.from_account_id = ? OR m.to_account_id = ?)
         AND (m.note IS NULL OR (
           m.note NOT LIKE 'import:cartola|anchor|%'
           AND m.note NOT LIKE 'import:cartola|opening|%'
         ))`
    )
    .all(accountId, accountId, accountId, accountId) as { posted_on: string }[]) {
    const mk = monthKeyFromYmd(r.posted_on);
    if (mk) keys.add(mk);
  }

  return [...keys].sort(ymCompare);
}

/** Earliest month from cartola imports or movement dates (same sources as month table timeline). */
export function getCheckingTimelineStartMonth(
  accountId: number,
  dbHandle: Database = db
): string | null {
  const keys = checkingTimelineMonthKeys(accountId, dbHandle);
  return keys.length > 0 ? keys[0]! : null;
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

export type NonAnchorClpFlowTotals = {
  deposits_clp: number;
  withdrawals_clp: number;
  net_clp: number;
  movement_count: number;
};

/**
 * Signed CLP flow totals over the account's non-anchor movements in an inclusive date
 * window (`fromYmd` omitted = from the beginning of history).
 *
 * Single source of the abonos/cargos accounting: the anchor derivation reads `net_clp`
 * (through `toYmd`) and the cartola month table reads deposits/withdrawals/count per
 * calendar month, so the two can never drift apart — and both MUST use the same
 * transfer-aware, signed accounting as the balance reader (`sumClpThroughDate` →
 * `signedClpDeltaForAccountMovement`), because the anchor exists precisely to make that
 * reader land on the cartola's saldo final.
 *
 * A previous implementation summed `MOVEMENT_CLP_LEG_SQL` over `WHERE account_id = ?`,
 * which is wrong twice over: a transfer row carries the account in
 * `from_account_id`/`to_account_id` with `account_id` **NULL** (and `NULL = ?` never
 * matches, so those rows vanished from the filter entirely), and the CLP leg is unsigned
 * so an outbound transfer would have counted as an inflow anyway. On the real cuenta
 * vista that was the whole ledger: 260 transfer legs summing −1x.xxx.xxx were invisible,
 * so the derived anchor came out −1x.xxx.xxx instead of +1.074 and the account's final
 * balance read −1x.xxx.xxx instead of 0. The month table had the same bug plus a
 * `note LIKE 'import:cartola|<month>|%'` filter that also hid mirror-converted transfers
 * (human notes), daily-xlsx rows (`import:cartola-partial|…`), and manual movements —
 * fixed 2026-08-11 by routing it through this helper.
 */
export function nonAnchorClpFlowTotals(
  accountId: number,
  window: { fromYmd?: string; toYmd: string },
  dbHandle: Database = db
): NonAnchorClpFlowTotals {
  const dateSql =
    window.fromYmd != null
      ? `${BANK_POSTED_ON_SQL} >= ? AND ${BANK_POSTED_ON_SQL} <= ?`
      : `${BANK_POSTED_ON_SQL} <= ?`;
  const dateParams =
    window.fromYmd != null ? [window.fromYmd, window.toYmd] : [window.toYmd];
  const rows = dbHandle
    .prepare(
      `SELECT m.account_id, m.from_account_id, m.to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, m.flow_kind
       FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE (m.account_id = ? OR m.from_account_id = ? OR m.to_account_id = ?)
         AND ${dateSql}
         AND (m.note IS NULL OR (
           m.note NOT LIKE 'import:cartola|anchor|%'
           AND m.note NOT LIKE 'import:cartola|opening|%'
         ))`
    )
    .all(accountId, accountId, accountId, accountId, ...dateParams) as MovementTransferRow[];
  let deposits = 0;
  let withdrawals = 0;
  let net = 0;
  for (const row of rows) {
    const delta = signedClpDeltaForAccountMovement(row, accountId);
    net += delta;
    if (delta > 0) deposits += delta;
    else if (delta < 0) withdrawals += -delta;
  }
  return {
    deposits_clp: Math.round(deposits),
    withdrawals_clp: Math.round(withdrawals),
    net_clp: Math.round(net),
    movement_count: rows.length,
  };
}

function computeDerivedAnchorAmount(
  accountId: number,
  saldoFinal: number,
  anchorDate: string,
  dbHandle: Database = db
): number {
  const sum = nonAnchorClpFlowTotals(accountId, { toYmd: anchorDate }, dbHandle).net_clp;
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
      `SELECT id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, occurred_on FROM movements
       WHERE account_id = ? AND note LIKE ?
       LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as
    | ({ id: number; occurred_on: string } & MovementAmountFields)
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
    amount_clp: Math.round(movementClpLegOrZero(existing)),
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
      .prepare(`UPDATE movements SET amount = ?, currency = 'clp', occurred_on = ?, note = ? WHERE id = ?`)
      .run(amount, occurredOn, note, existing.id);
  } else {
    dbHandle
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
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
      `SELECT id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, occurred_on, note FROM movements
       WHERE account_id = ? AND note LIKE ?
       LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as
    | ({ id: number; occurred_on: string; note: string } & MovementAmountFields)
    | undefined;

  if (existing) {
    if (
      Math.round(movementClpLegOrZero(existing)) === amount &&
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
      .prepare(`UPDATE movements SET amount = ?, currency = 'clp', occurred_on = ?, note = ? WHERE id = ?`)
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
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
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
