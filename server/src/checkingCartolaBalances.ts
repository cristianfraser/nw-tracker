import type { Database } from "better-sqlite3";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { movementNotAnchorSql } from "./flows/flowEvidence.js";
import { db } from "./db.js";
import { deleteAccountMovementsByNote, insertMovement, restateMovementAmount } from "./movementWrites.js";
import { stateMovementDescription } from "./movementListingFacts.js";
import { cacheKeyCheckingBalance } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
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
import { cartolaClosingDay } from "./checkingCartolaMonthBounds.js";

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

/**
 * Cached wrapper for hot paths (API/charts), in the cache registry's `checking.balance|` family:
 * dropped for the account when the change log reports a write to its movements. The key carries
 * the cutoff actually applied, so a value computed for "today" (no upper bound) is never served
 * as that date's strict history after the day rolls over. Another database handle is never cached.
 */
export function checkingMovementBalanceClpAtCached(
  accountId: number,
  asOfYmd: string,
  dbHandle: Database = db
): number {
  if (dbHandle !== db) return checkingMovementBalanceClpAt(accountId, asOfYmd, dbHandle);
  return getAggregationCached(cacheKeyCheckingBalance(accountId, asOfYmd, displayLedgerCutoffYmd(asOfYmd)), () =>
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
  if (dbHandle !== db) return sumClpThroughBankPostedDate(accountId, asOf, dbHandle);
  return getAggregationCached(cacheKeyCheckingBalance(accountId, asOf, "bank"), () =>
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
  return r.changes;
}

const ANCHOR_NOTE_PREFIX = "import:cartola|anchor|";
/** A ledger anchor's description, stated on its evidence (`stateMovementDescription`). */
const ANCHOR_DESCRIPTION = "saldo final";

/** Writes the anchor row (in place when one is on file) and states its description. */
function writeAnchorRow(accountId: number, existingId: number | null, row: { amount: number; occurredOn: string; note: string }, dbHandle: Database): void {
  const id =
    existingId != null
      ? (restateMovementAmount(existingId, { amount: row.amount, currency: HOME_CURRENCY, occurredOn: row.occurredOn, note: row.note }, dbHandle), existingId)
      : insertMovement({ accountId, amount: row.amount, currency: HOME_CURRENCY, occurredOn: row.occurredOn, note: row.note }, dbHandle);
  stateMovementDescription(id, ANCHOR_DESCRIPTION, dbHandle);
}


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

export function checkingLedgerAnchorNote(periodMonth: string): string {
  return `${ANCHOR_NOTE_PREFIX}${periodMonth}|${ANCHOR_DESCRIPTION}`;
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

  for (const r of dbHandle
    .prepare(
      `SELECT ${BANK_POSTED_ON_SQL} AS posted_on FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE (m.account_id = ? OR m.from_account_id = ? OR m.to_account_id = ?)
         AND ${movementNotAnchorSql("m")}`
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



/**
 * The newest cartola month with a printed closing balance, and the day that balance is as of
 * (`cartolaClosingDay`: its HASTA, else the month's end): the anchor is derived so the walk lands
 * there.
 */
function getLatestCartolaSaldoFinal(
  accountId: number,
  dbHandle: Database = db
): { period_month: string; saldo_final_clp: number; closing_day: string } | null {
  const row = dbHandle
    .prepare(
      `SELECT period_month, saldo_final_clp, period_from, period_to
       FROM checking_cartola_imports
       WHERE account_id = ? AND saldo_final_clp IS NOT NULL
       ORDER BY period_month DESC
       LIMIT 1`
    )
    .get(accountId) as { period_month: string; saldo_final_clp: number; period_from: string | null; period_to: string | null } | undefined;
  if (!row || !Number.isFinite(row.saldo_final_clp)) return null;
  return { period_month: row.period_month, saldo_final_clp: Math.round(row.saldo_final_clp), closing_day: cartolaClosingDay(row) };
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
 * so the derived anchor came out −1x.xxx.xxx instead of a small positive balance and the account's final
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
         AND ${movementNotAnchorSql("m")}`
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
  const amount = computeDerivedAnchorAmount(accountId, latest.saldo_final_clp, latest.closing_day, dbHandle);
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

  const derivedAmount = computeDerivedAnchorAmount(accountId, latest.saldo_final_clp, latest.closing_day, dbHandle);

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
  return deleteAccountMovementsByNote(accountId, `${ANCHOR_NOTE_PREFIX}%`, dbHandle) > 0;
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

  writeAnchorRow(accountId, existing?.id ?? null, { amount, occurredOn, note }, dbHandle);
  return getCheckingLedgerAnchor(accountId, dbHandle);
}

/**
 * The derivation would move an anchor the cartolas on file pinned: the ledger walk no longer lands
 * on the newest cartola's closing balance from the anchor on file, so some row disagrees with a
 * cartola by `derived − stored`. Never absorbed by moving the anchor.
 */
export class CheckingLedgerAnchorPinnedError extends Error {
  constructor(
    readonly accountId: number,
    readonly stored: { amount_clp: number; occurred_on: string },
    readonly derived: { amount_clp: number; occurred_on: string; period_month: string }
  ) {
    super(
      `account ${accountId}: the ledger anchor (${stored.amount_clp} CLP on ${stored.occurred_on}) is pinned by the cartolas on file; ` +
        `re-deriving it from the ${derived.period_month} saldo final gives ${derived.amount_clp} CLP on ${derived.occurred_on} ` +
        `(difference ${derived.amount_clp - stored.amount_clp}): the ledger disagrees with a cartola on file by that much. ` +
        `Find the row (the month table shows the first month off its cartola); the anchor is re-derived only once it is cleared.`
    );
  }
}

/** The account's ledger anchor row on file, or null. */
export function storedCheckingLedgerAnchor(
  accountId: number,
  dbHandle: Database = db
): { id: number; amount_clp: number; occurred_on: string; note: string } | null {
  const row = dbHandle
    .prepare(
      `SELECT id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, occurred_on, note FROM movements
       WHERE account_id = ? AND note LIKE ?
       LIMIT 1`
    )
    .get(accountId, `${ANCHOR_NOTE_PREFIX}%`) as ({ id: number; occurred_on: string; note: string } & MovementAmountFields) | undefined;
  return row ? { id: row.id, amount_clp: Math.round(movementClpLegOrZero(row)), occurred_on: row.occurred_on, note: row.note } : null;
}

/**
 * The account's ledger anchor: the opening balance that makes the walk land on the newest cartola's
 * closing balance (`getCartolaDerivedAnchor`), dated the month-end before the timeline starts.
 *
 * **An anchor on file is pinned.** Every cartola import checks the ledger against the cartola's
 * printed opening and closing balances with the anchor on file (`checkingCartolaLedgerGuard.ts`),
 * so re-deriving an established anchor must give it back; when it would not (a row disagrees with
 * a cartola), this throws `CheckingLedgerAnchorPinnedError` instead of moving it. Only the note
 * follows the newest month. The anchor is derived (written new or moved) only:
 *  - when none is on file: the first cartola of the account, or after a wipe or a hand clear;
 *  - with `repin`: the import run whose cartolas start the account's history (a cartola earlier
 *    than every month on file, checked against the anchor it derives before it was written).
 * With no cartola saldo final on file the anchor is cleared. A hand-set anchor
 * (`upsertCheckingLedgerAnchor`) stays pinned like any other.
 */
export function ensureCheckingLedgerAnchor(
  accountId: number,
  dbHandle: Database = db,
  opts?: { repin?: boolean }
): EnsureCheckingLedgerAnchorResult {
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
  const amount = computeDerivedAnchorAmount(accountId, latest.saldo_final_clp, latest.closing_day, dbHandle);
  const note = checkingLedgerAnchorNote(periodMonth);
  const existing = storedCheckingLedgerAnchor(accountId, dbHandle);

  if (existing) {
    const same = existing.amount_clp === amount && existing.occurred_on === occurredOn;
    if (!same && opts?.repin !== true) {
      throw new CheckingLedgerAnchorPinnedError(accountId, existing, { amount_clp: amount, occurred_on: occurredOn, period_month: periodMonth });
    }
    if (same && existing.note === note) {
      return {
        inserted: false,
        updated: false,
        cleared: false,
        amount_clp: amount,
        occurred_on: occurredOn,
        anchor_period_month: periodMonth,
      };
    }
    writeAnchorRow(accountId, existing.id, { amount, occurredOn, note }, dbHandle);
    return {
      inserted: false,
      updated: !same,
      cleared: false,
      amount_clp: amount,
      occurred_on: occurredOn,
      anchor_period_month: periodMonth,
    };
  }

  writeAnchorRow(accountId, null, { amount, occurredOn, note }, dbHandle);
  return {
    inserted: true,
    updated: false,
    cleared: false,
    amount_clp: amount,
    occurred_on: occurredOn,
    anchor_period_month: periodMonth,
  };
}

/**
 * After a hand movement on a cash cartola account: the anchor stays pinned, so a movement that
 * would put the ledger off a cartola on file throws (`CheckingLedgerAnchorPinnedError`); the
 * caller writes the movement and this check in one transaction.
 */
export function maybeSyncCheckingLedgerAnchor(
  accountId: number,
  bucketKindSlug: string,
  dbHandle: Database = db
): void {
  if (!isMovementBalanceCashCategory(bucketKindSlug)) return;
  ensureCheckingLedgerAnchor(accountId, dbHandle);
}
