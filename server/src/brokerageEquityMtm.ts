import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { readSpyVeaShareUnitsFromStocksCsv } from "./accountPosition.js";
import { db } from "./db.js";
import type { EodCloseSeries } from "./equityYahooEod.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

/** Yahoo chart symbols loaded at `import:excel` into `equity_daily` (USD close per share/coin). */
export const EQUITY_DAILY_IMPORT_TICKERS = ["SPY", "VEA", "BTC-USD", "ETH-USD"] as const;

const insEod = db.prepare(
  `INSERT INTO equity_daily (ticker, trade_date, close_usd) VALUES (?,?,?)
   ON CONFLICT(ticker, trade_date) DO UPDATE SET close_usd = excluded.close_usd`
);

export function upsertEquityDailySeries(ticker: string, series: EodCloseSeries): number {
  let n = 0;
  for (let i = 0; i < series.dates.length; i++) {
    const d = series.dates[i]!;
    const c = series.closes[i]!;
    if (!Number.isFinite(c)) continue;
    insEod.run(ticker, d, c);
    n += 1;
  }
  return n;
}

const stmtHasUnits = db.prepare(
  `SELECT 1 FROM brokerage_flows WHERE account_id = ? AND COALESCE(units_delta, 0) != 0 LIMIT 1`
);

export function accountUsesEquityMtm(accountId: number): boolean {
  return stmtHasUnits.get(accountId) != null;
}

const stmtSlug = db.prepare(
  `SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
);

export function equityTickerForAccount(accountId: number): "SPY" | "VEA" | null {
  const r = stmtSlug.get(accountId) as { slug: string } | undefined;
  if (r?.slug === "spy") return "SPY";
  if (r?.slug === "vea") return "VEA";
  return null;
}

const stmtUnits = db.prepare(
  `SELECT COALESCE(SUM(units_delta), 0) AS u FROM brokerage_flows WHERE account_id = ? AND occurred_on <= ?`
);

const stmtClose = db.prepare(
  `SELECT close_usd FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
);

/** CLP MTM: shares through `asOfYmd` × last EOD ≤ asOf × FX. `asOfYmd` is the snapshot date (month-end). */
export function computeEquityMtmClp(accountId: number, asOfYmd: string): number | null {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  if (!accountUsesEquityMtm(accountId)) return null;
  const urow = stmtUnits.get(accountId, asOfYmd) as { u: number };
  const units = urow?.u ?? 0;
  if (units <= 0 || !Number.isFinite(units)) return null;
  const crow = stmtClose.get(ticker, asOfYmd) as { close_usd: number } | undefined;
  if (!crow || !Number.isFinite(crow.close_usd)) return null;
  const fx = fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * crow.close_usd * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

const stmtMaxEqDate = db.prepare(
  `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
);

/**
 * Latest CLP mark for SPY/VEA on the dashboard: prefer flows-based MTM; if that is unavailable (no `units_delta`
 * yet, or stale `valuations` row with 0), use share count from `net worth-stocks.csv` × last EOD × FX.
 */
export function computeLatestDisplayedEquityClp(
  accountId: number
): { value_clp: number; as_of_date: string } | null {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  const mdRow = stmtMaxEqDate.get(ticker) as { md: string | null } | undefined;
  const md = mdRow?.md;
  if (!md) return null;

  const fromFlows = computeEquityMtmClp(accountId, md);
  if (fromFlows != null && Number.isFinite(fromFlows) && fromFlows > 0) {
    return { value_clp: fromFlows, as_of_date: md };
  }

  const slug = ticker === "SPY" ? "spy" : "vea";
  const u = readSpyVeaShareUnitsFromStocksCsv(slug);
  if (u == null || !Number.isFinite(u) || u <= 0) return null;

  const crow = stmtClose.get(ticker, md) as { close_usd: number } | undefined;
  if (!crow || !Number.isFinite(crow.close_usd)) return null;
  const fx = fxMonthEndForBalanceUsd(md);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = u * crow.close_usd * fx.clp_per_usd;
  if (!Number.isFinite(clp) || clp <= 0) return null;
  return { value_clp: clp, as_of_date: md };
}

export function deleteEquityDailyForImportTickers(): void {
  const ph = EQUITY_DAILY_IMPORT_TICKERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM equity_daily WHERE ticker IN (${ph})`).run(...EQUITY_DAILY_IMPORT_TICKERS);
}

/** Merge timeline keys with month-ends covered by `equity_daily` for MTM brokerage accounts. */
export function expandSnapshotDatesForEquityMtm(
  baseDates: string[],
  allIds: number[],
  merge: { spyId?: number; veaId?: number } | undefined
): string[] {
  const s = new Set(baseDates);
  const addTickerMonths = (accountId: number | undefined, ticker: "SPY" | "VEA") => {
    if (accountId == null || !accountUsesEquityMtm(accountId)) return;
    const r = db
      .prepare(`SELECT min(trade_date) AS a, max(trade_date) AS b FROM equity_daily WHERE ticker = ?`)
      .get(ticker) as { a: string | null; b: string | null } | undefined;
    if (!r?.a || !r.b) return;
    for (const me of monthEndsBetweenInclusive(r.a, r.b)) s.add(me);
  };
  if (merge?.spyId) addTickerMonths(merge.spyId, "SPY");
  if (merge?.veaId) addTickerMonths(merge.veaId, "VEA");
  if (!merge) {
    for (const id of allIds) {
      const t = equityTickerForAccount(id);
      if (t) addTickerMonths(id, t);
    }
  }
  return [...s].sort();
}
