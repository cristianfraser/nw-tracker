import { db } from "./db.js";
import type { YahooClpRejectReason } from "./fxYahooSanity.js";

export type YahooFxRejectedRow = {
  date: string;
  raw_clp_per_usd: number;
  reason: YahooClpRejectReason;
  rejected_at: string;
};

const upsertRejected = db.prepare(`
  INSERT INTO fx_daily_yahoo_rejected (date, raw_clp_per_usd, reason, rejected_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(date) DO UPDATE SET
    raw_clp_per_usd = excluded.raw_clp_per_usd,
    reason = excluded.reason,
    rejected_at = datetime('now')
`);

const deleteRejected = db.prepare(`DELETE FROM fx_daily_yahoo_rejected WHERE date = ?`);

const deleteFxDaily = db.prepare(`DELETE FROM fx_daily WHERE date = ?`);

export function recordYahooFxRejected(
  date: string,
  rawClpPerUsd: number,
  reason: YahooClpRejectReason
): void {
  upsertRejected.run(date, rawClpPerUsd, reason);
  deleteFxDaily.run(date);
}

export function clearYahooFxRejected(date: string): void {
  deleteRejected.run(date);
}

export function listYahooFxRejectedAsc(): YahooFxRejectedRow[] {
  return db
    .prepare(
      `SELECT date, raw_clp_per_usd, reason, rejected_at
       FROM fx_daily_yahoo_rejected ORDER BY date ASC`
    )
    .all() as YahooFxRejectedRow[];
}
