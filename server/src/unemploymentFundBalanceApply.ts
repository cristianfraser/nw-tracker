import type { UnemploymentFundBalanceApplyDetails, UnemploymentFundBalancePayload } from "nw-tracker-contracts";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

/**
 * `unemployment_fund.balance`: the AFC's stated balance against the app's value of the account on
 * the read's Chile day, recorded in `unemployment_fund_reads`. Report only — the fund deducts its
 * commission in units between statements (a small drift below the app is normal) and a new
 * contribution shows here before the certificate is read.
 */
export function applyUnemploymentFundBalance(payload: UnemploymentFundBalancePayload): UnemploymentFundBalanceApplyDetails {
  const rows = db.prepare(`SELECT id FROM accounts WHERE fund_series_key = ? ORDER BY id`).all(AFC_CIC_SERIES_KEY) as { id: number }[];
  if (rows.length !== 1) throw new Error(`unemployment fund: expected one account on ${AFC_CIC_SERIES_KEY}, found ${rows.length}`);
  const accountId = rows[0]!.id;
  const today = chileCalendarTodayYmd();
  const mark = accountMarkClpAtYmd(accountId, today)?.value_clp;
  if (mark == null) throw new Error(`unemployment fund: account ${accountId} has no value on ${today}`);
  const appValue = Math.round(mark);
  const stated = payload.balance_pesos;
  const difference = stated == null ? null : stated - appValue;
  const ledgerLast = db
    .prepare(
      `SELECT MAX(p.period_month) AS m FROM pension_contribution_periods p JOIN movements m ON m.id = p.movement_id WHERE m.account_id = ?`
    )
    .get(accountId) as { m: string | null };
  const info = db
    .prepare(
      `INSERT INTO unemployment_fund_reads (provider, account_id, read_at, received_at, stated_pesos, app_value_clp, difference_clp, last_contribution_month, unavailable_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(payload.provider, accountId, payload.read_at, new Date().toISOString(), stated, appValue, difference, payload.last_contribution_month, payload.unavailable_reason);
  return {
    account_id: accountId,
    read_id: Number(info.lastInsertRowid),
    stated_pesos: stated,
    app_value_clp: appValue,
    difference_clp: difference,
    difference_pct: difference == null || appValue === 0 ? null : Math.round((difference / appValue) * 10_000) / 100,
    ledger_last_contribution_month: ledgerLast.m,
  };
}

/**
 * Newest AFC contribution period (YYYY-MM) in the ledger — `pension_contribution_periods` over
 * the account on the AFC series; null without such an account (demo) or contributions.
 */
export function latestUnemploymentFundContributionPeriod(): string | null {
  const row = db
    .prepare(
      `SELECT MAX(p.period_month) AS period
         FROM pension_contribution_periods p
         JOIN movements m ON m.id = p.movement_id
         JOIN accounts a ON a.id = m.account_id
        WHERE a.fund_series_key = ?`
    )
    .get(AFC_CIC_SERIES_KEY) as { period: string | null } | undefined;
  return row?.period ?? null;
}
