import { monthEndsBetweenInclusive } from "./calendarMonth.js";
import { readSpyVeaShareUnitsFromStocksCsv } from "./accountPosition.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import { parsePanelAccountNotes } from "./panelAccountNotes.js";
import {
  equityCloseUsdEod,
  equitySessionYmdForTicker,
  getCachedLiveEquityQuote,
  resolveEquityQuote,
} from "./equityQuote.js";
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

const shareUnitsFlowPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

const stmtHasUnits = db.prepare(
  `SELECT 1 FROM movements
   WHERE account_id = ?
     AND flow_kind IN (${shareUnitsFlowPh})
     AND COALESCE(units_delta, 0) != 0
   LIMIT 1`
);

export function accountUsesEquityMtm(accountId: number): boolean {
  return (
    stmtHasUnits.get(accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null
  );
}

const stmtBucket = db.prepare(
  `SELECT g.slug, a.notes FROM accounts a
   JOIN asset_groups g ON g.id = a.asset_group_id
   WHERE a.id = ?`
);

export function equityTickerForAccount(accountId: number): string | null {
  const r = stmtBucket.get(accountId) as { slug: string; notes: string | null } | undefined;
  const panel = parsePanelAccountNotes(r?.notes);
  if (panel) return panel.ticker;
  const kind = r?.slug ? accountBucketKindSlug(r.slug) : "";
  if (kind === "spy") return "SPY";
  if (kind === "vea") return "VEA";
  return null;
}

const stmtUnits = db.prepare(
  `SELECT COALESCE(SUM(units_delta), 0) AS u
   FROM movements
   WHERE account_id = ?
     AND occurred_on <= ?
     AND flow_kind IN (${shareUnitsFlowPh})`
);

/** CLP MTM: shares through `asOfYmd` × USD price × FX. Uses EOD from DB unless `priceUsd` passed. */
export function computeEquityMtmClp(
  accountId: number,
  asOfYmd: string,
  priceUsd?: number | null
): number | null {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  if (!accountUsesEquityMtm(accountId)) return null;
  const urow = stmtUnits.get(
    accountId,
    asOfYmd,
    ...BROKERAGE_SHARE_UNITS_FLOW_KINDS
  ) as { u: number };
  const units = urow?.u ?? 0;
  if (units <= 0 || !Number.isFinite(units)) return null;
  const closeUsd = priceUsd ?? equityCloseUsdEod(ticker, asOfYmd);
  if (closeUsd == null || !Number.isFinite(closeUsd)) return null;
  const fx = fxMonthEndForBalanceUsd(asOfYmd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = units * closeUsd * fx.clp_per_usd;
  return Number.isFinite(clp) ? clp : null;
}

/** Sync MTM using a fresh cached live quote when the dashboard has already loaded one. */
export function computeEquityMtmClpCachedLive(accountId: number): number | null {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker || !accountUsesEquityMtm(accountId)) return null;
  const session = equitySessionYmdForTicker(ticker);
  const cached = getCachedLiveEquityQuote(ticker);
  if (!cached) return null;
  return computeEquityMtmClp(accountId, session, cached.price_usd);
}

/** MTM with live Yahoo quote when session is open (dashboard / account summary). */
export async function computeEquityMtmClpLive(
  accountId: number,
  asOfYmd?: string
): Promise<{ value_clp: number; as_of_date: string; source: string } | null> {
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  const session = asOfYmd ?? equitySessionYmdForTicker(ticker);
  const quote = await resolveEquityQuote(ticker, session, { preferLive: true });
  if (!quote) return null;
  const clp = computeEquityMtmClp(accountId, session, quote.price_usd);
  if (clp == null || !Number.isFinite(clp) || clp <= 0) return null;
  return { value_clp: clp, as_of_date: quote.trade_date, source: quote.source };
}

const stmtMaxEqDate = db.prepare(
  `SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`
);

/**
 * Latest CLP mark for SPY/VEA on the dashboard: prefer flows-based MTM; if that is unavailable (no `units_delta`
 * yet, or stale `valuations` row with 0), use share count from `net worth-stocks.csv` × last EOD × FX.
 */
export async function computeLatestDisplayedEquityClp(
  accountId: number
): Promise<{ value_clp: number; as_of_date: string } | null> {
  const live = await computeEquityMtmClpLive(accountId);
  if (live != null && live.value_clp > 0) {
    return { value_clp: live.value_clp, as_of_date: live.as_of_date };
  }

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

  const closeUsd = equityCloseUsdEod(ticker, md);
  if (closeUsd == null) return null;
  const fx = fxMonthEndForBalanceUsd(md);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const clp = u * closeUsd * fx.clp_per_usd;
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
