
import { accountBucketKindSlug } from "./accountBucket.js";
import { ccOwedByCurrencyAtYmd, ccOwedNativeValueClp } from "./ccOwedWalk.js";
import type { CcOwedNative } from "./ccBillingBalances.js";
import { db } from "./db.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { billingDetailCacheForAccount, planScheduleMonths } from "./ccBillingDetailCache.js";
import { ccCupoFrame, ccStatementOwedByCurrencyByMonth, type CcCupoFrame } from "./ccBillingViews.js";
import { planCount } from "./cards/purchases.js";
import { accountStatementsAreUsdOnly } from "./cards/facturacion.js";
import {
  ccLedgerMonthEndIso,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { addCalendarMonths } from "nw-tracker-contracts";

/**
 * Whether month-end anchors can be written from the billing detail: the card has a plan ledger, or
 * its issuer bills in dollars alone (a US card has no cuotas, so its statements are the whole
 * evidence). Any other statements-only master (the retired CMR card) keeps its script-written
 * anchors.
 */
function hasBillingLedger(accountId: number): boolean {
  return planCount(accountId) > 0 || accountStatementsAreUsdOnly(accountId);
}

const deleteNativeAnchor = db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ? AND as_of_date = ?`);
const insertNativeAnchor = db.prepare(
  `INSERT INTO cc_owed_anchors (account_id, as_of_date, currency, amount) VALUES (?, ?, ?, ?)`
);

/** Replace a card's per-currency anchor on a date (a peso row always; a dollar row when it owes dollars). */
export function writeCcOwedAnchor(accountId: number, asOfDate: string, owed: CcOwedNative): void {
  deleteNativeAnchor.run(accountId, asOfDate);
  insertNativeAnchor.run(accountId, asOfDate, "clp", owed.clp);
  if (owed.usd !== 0) insertNativeAnchor.run(accountId, asOfDate, "usd", owed.usd);
}

/** The pesos an owed is valued at on its date; throws when a dollar sub-balance has no rate. */
export function ccOwedValueClpOrThrow(accountId: number, asOfDate: string, owed: CcOwedNative): number {
  const v = ccOwedNativeValueClp(owed, asOfDate);
  if (v == null) {
    throw new Error(`Account ${accountId} ${asOfDate}: no USD/CLP rate to value US$${owed.usd} of card debt`);
  }
  return v;
}

/**
 * Rewrites each `valuations` row of a card that has a per-currency anchor on its date to the pesos
 * that anchor is worth on that date. Returns the rows whose value changed.
 */
export function revalueCcOwedAnchorValuations(accountId: number): number {
  const rows = db
    .prepare(
      `SELECT as_of_date, currency, amount FROM cc_owed_anchors WHERE account_id = ? ORDER BY as_of_date`
    )
    .all(accountId) as { as_of_date: string; currency: "clp" | "usd"; amount: number }[];
  const byDate = new Map<string, CcOwedNative>();
  for (const r of rows) {
    const o = byDate.get(r.as_of_date) ?? { clp: 0, usd: 0 };
    o[r.currency] += r.amount;
    byDate.set(r.as_of_date, o);
  }
  const stored = new Map(
    (
      db.prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ?`).all(accountId) as {
        as_of_date: string;
        value: number;
      }[]
    ).map((r) => [r.as_of_date, r.value])
  );
  let changed = 0;
  for (const [date, owed] of byDate) {
    const v = ccOwedValueClpOrThrow(accountId, date, owed);
    if (stored.get(date) === v) continue;
    upsertValuationMonth.run({ account_id: accountId, as_of_date: date, value_clp: v });
    changed += 1;
  }
  return changed;
}

const upsertValuationMonth = db.prepare(`
  INSERT INTO valuations (account_id, as_of_date, value, currency)
  VALUES (@account_id, @as_of_date, @value_clp, 'clp')
  ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency
`);

/**
 * Latest billing-detail balance total (open month rolled balance), same as account «Balance total».
 * detail is sorted descending and includes plan-only projected future rows — skip those (their
 * saldo is the remaining-cuotas projection, not the live rolled balance). The +1 cutoff covers
 * the gap right after a cierre when the open month is the next calendar month.
 */
function latestBillingDetailRow(
  detail: ReturnType<typeof billingDetailCacheForAccount>["detail"]
): (typeof detail)[0] | undefined {
  const todayYm = chileCalendarTodayYmd().slice(0, 7);
  const cutoff = addCalendarMonths(todayYm, 1);
  return detail.find((r) => !r.projected && r.billing_month <= cutoff);
}

export function latestCreditCardBillingBalanceTotalClp(accountId: number): number | null {
  if (!hasBillingLedger(accountId)) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  const row = latestBillingDetailRow(detail);
  if (!row || !Number.isFinite(row.balance_statement_clp)) return null;
  return Math.round(row.balance_statement_clp);
}

export function latestCreditCardBillingBalanceTotalClpAndAsOfDate(
  accountId: number
): { value_clp: number; as_of_date: string } | null {
  if (!hasBillingLedger(accountId)) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  const row = latestBillingDetailRow(detail);
  if (!row || !Number.isFinite(row.balance_statement_clp)) return null;
  return {
    value_clp: Math.round(row.balance_statement_clp),
    as_of_date: row.as_of_date,
  };
}

/**
 * Billing-detail balance total as of a calendar date.
 * Uses the latest `billing_month` <= month(`asOfYmd`) to avoid pulling future-filled months.
 */
export function creditCardBillingBalanceTotalClpAsOf(
  accountId: number,
  asOfYmd: string
): { value_clp: number; as_of_date: string } | null {
  if (!hasBillingLedger(accountId)) return null;
  const asOfMonth = monthKeyFromYmd(asOfYmd);
  if (!asOfMonth) return null;
  const { detail } = billingDetailCacheForAccount(accountId);
  if (detail.length === 0) return null;
  const row = detail.find((r) => r.billing_month <= asOfMonth);
  if (!row || !Number.isFinite(row.balance_statement_clp)) return null;
  return {
    value_clp: Math.round(row.balance_statement_clp),
    as_of_date: row.as_of_date,
  };
}

/**
 * Month-end valuation points: **balance total** per billing month (Detalle por mes / summary card),
 * not cupo en cuotas alone. A plan month the detalle has no row for (one after the last statement
 * whose close the bank has not published, once the calendar has moved the open month past it) is
 * valued at its cupo en cuotas by the detalle's own rule (`ccCupoFrame`): the plan remainder after
 * the month, the live figure only for the open facturación — never for the calendar month.
 */
export function ccLedgerStatementClosingPointsClp(
  accountId: number
): { as_of_date: string; value_clp: number }[] | null {
  if (!hasBillingLedger(accountId)) return null;
  const { payload, detail } = billingDetailCacheForAccount(accountId);
  const ledgerMonths = payload?.months ?? [];
  const balanceByMonth = new Map(detail.map((d) => [d.billing_month, d.balance_statement_clp]));
  const months = [
    ...new Set([
      ...ledgerMonths.map((h) => h.month),
      ...balanceByMonth.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  if (months.length === 0) return null;
  // Built only when a month needs it (rare: every month usually has its detalle row).
  let frame: CcCupoFrame | null = null;
  const cupoEnCuotasClp = (ym: string): number =>
    (frame ??= ccCupoFrame(accountId, payload ? planScheduleMonths(payload) : [])).cupoEnCuotasClp(ym);
  return months.map((ym) => ({
    as_of_date: ccLedgerMonthEndIso(ym),
    value_clp: Math.round(balanceByMonth.get(ym) ?? cupoEnCuotasClp(ym)),
  }));
}

/**
 * {@link ccLedgerStatementClosingPointsClp} per currency: the same months and the same statement
 * frame, split into its pesos and dollars (`ccStatementOwedByCurrencyByMonth`). The month-end
 * anchors the owed walk starts from.
 */
export function ccLedgerStatementClosingPointsNative(
  accountId: number
): { as_of_date: string; owed: CcOwedNative }[] | null {
  if (!hasBillingLedger(accountId)) return null;
  const { payload, detail } = billingDetailCacheForAccount(accountId);
  const scheduleMonths = payload ? planScheduleMonths(payload) : [];
  const ledgerMonths = payload?.months ?? [];
  const owedByMonth = ccStatementOwedByCurrencyByMonth(accountId, scheduleMonths);
  const months = [
    ...new Set([...ledgerMonths.map((h) => h.month), ...detail.map((d) => d.billing_month)]),
  ].sort((a, b) => a.localeCompare(b));
  if (months.length === 0) return null;
  let frame: CcCupoFrame | null = null;
  return months.map((ym) => ({
    as_of_date: ccLedgerMonthEndIso(ym),
    owed:
      owedByMonth.get(ym) ??
      { clp: Math.round((frame ??= ccCupoFrame(accountId, scheduleMonths)).cupoEnCuotasClp(ym)), usd: 0 },
  }));
}

/** Ledger month-end closes for many CC accounts (one billing-detail cache pass per account). */
export function ccLedgerStatementClosingPointsClpForAccounts(
  accountIds: readonly number[]
): Map<number, { as_of_date: string; value_clp: number }[]> {
  const out = new Map<number, { as_of_date: string; value_clp: number }[]>();
  for (const id of accountIds) {
    const pts = ccLedgerStatementClosingPointsClp(id);
    if (pts?.length) out.set(id, pts);
  }
  return out;
}

/** Last day of its own month (the shape every statement-derived anchor is written on). */
function isMonthEndIso(ymd: string): boolean {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t + 86_400_000).toISOString().slice(8, 10) === "01";
}

/**
 * Delete the daily "today" stamps that newly-imported evidence contradicts: rows dated from
 * the earliest affected transaction date through yesterday.
 *
 * Those stamps froze the live formula on the day they were written, so a statement or manual
 * contract imported later — carrying transaction dates BEFORE them — leaves them asserting a
 * balance that provably predates the evidence. The owed walk would climb through the new
 * purchases and then snap back down to the stale stamp, and the whole import would land in
 * "today's" delta instead of on the days it happened. A card's balance follows its evidence
 * dates; when the evidence arrived is not part of the model.
 *
 * Month-end rows are kept: they are statement-derived, and this same run recomputes them.
 * Returns the purged dates for the caller's import log.
 */
function purgeContradictedDailyStamps(
  accountId: number,
  fromYmd: string,
  todayYmd: string
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromYmd) || fromYmd >= todayYmd) return [];
  const rows = db
    .prepare(
      `SELECT as_of_date FROM valuations
       WHERE account_id = ? AND as_of_date >= ? AND as_of_date < ?
       ORDER BY as_of_date`
    )
    .all(accountId, fromYmd, todayYmd) as { as_of_date: string }[];
  const stale = rows.map((r) => r.as_of_date).filter((d) => !isMonthEndIso(d));
  if (stale.length === 0) return [];
  const del = db.prepare(`DELETE FROM valuations WHERE account_id = ? AND as_of_date = ?`);
  for (const d of stale) {
    del.run(accountId, d);
    deleteNativeAnchor.run(accountId, d);
  }
  return stale;
}

/**
 * Persists month-end `valuations` aligned with credit-card **balance total** (not cupo-only).
 * Run after ledger + billing recompute so dashboard / charts match account detail.
 *
 * `affectedEvidenceFromYmd`: earliest transaction date this write's evidence touched (new
 * statement lines, installment contracts, header payments, or the dates of removed ones).
 * Pass it from any caller that ADDED or REMOVED dated evidence so the stamps it contradicts
 * are purged (see {@link purgeContradictedDailyStamps}); pure recomputes omit it.
 */
export function upsertCreditCardValuationsFromLedger(
  accountId: number,
  opts?: { affectedEvidenceFromYmd?: string | null }
): number {
  // This runs after CC writes — drop the cached detail first so the points below (and every
  // later read) reflect the new ledger/statement state instead of a pre-write cache entry.
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row || accountBucketKindSlug(row.bucket_slug) !== "credit_card") return 0;
  // Before the points check: dropping stamps the new evidence contradicts is about removing
  // wrong data, so it must happen even when this run has no month-end points to write.
  if (opts?.affectedEvidenceFromYmd) {
    purgeContradictedDailyStamps(accountId, opts.affectedEvidenceFromYmd, chileCalendarTodayYmd());
  }
  const pts = ccLedgerStatementClosingPointsNative(accountId);
  if (!pts || pts.length === 0) return 0;
  // The anchors are per currency (`cc_owed_anchors`); `valuations` keeps the pesos they are worth
  // on their date, for the readers of stored values (group charts, the liabilities overview).
  let n = 0;
  for (const p of pts) {
    writeCcOwedAnchor(accountId, p.as_of_date, p.owed);
    upsertValuationMonth.run({
      account_id: accountId,
      as_of_date: p.as_of_date,
      value_clp: ccOwedValueClpOrThrow(accountId, p.as_of_date, p.owed),
    });
    n += 1;
  }
  // Today's stamp is the WALKED balance (anchor + evidence dated after it), the same frame the
  // series uses for every other day — see `ccOwedWalk.ts`. Stamping the live billing formula
  // here instead made tomorrow's anchor a different frame from the walk that leads into it, so
  // the gap surfaced as a phantom move on a day with no transactions. Falls back to the live
  // number (as pesos) only when there is no anchor to walk from.
  const today = chileCalendarTodayYmd();
  const walkedToday = ccOwedByCurrencyAtYmd(accountId, today, { strictlyBefore: true });
  let owedToday: CcOwedNative | null = walkedToday ? { clp: walkedToday.clp, usd: walkedToday.usd } : null;
  if (!owedToday) {
    const liveBalance = latestCreditCardBillingBalanceTotalClp(accountId) ?? liveCreditCardOutstandingClp(accountId);
    if (liveBalance != null && Number.isFinite(liveBalance)) owedToday = { clp: Math.round(liveBalance), usd: 0 };
  }
  if (owedToday) {
    writeCcOwedAnchor(accountId, today, owedToday);
    upsertValuationMonth.run({
      account_id: accountId,
      as_of_date: today,
      value_clp: ccOwedValueClpOrThrow(accountId, today, owedToday),
    });
    n += 1;
  }
  // The pesos of every other anchor (earlier daily stamps) at its own date's rate: a stamp written
  // during a live day carries that moment's rate until the day's close is on file.
  revalueCcOwedAnchorValuations(accountId);
  if (pts.length > 0) {
  }
  return n;
}
