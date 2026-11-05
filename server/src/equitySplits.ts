/**
 * Stock splits (`equity_splits`, migration 265). A split multiplies every share of a ticker by
 * numerator / denominator from its ex-date; the position's value does not change.
 *
 * Two frames, one rule each:
 * - **Prices are split-adjusted.** `equity_daily`, `equity_dividends` and `live_market_quotes`
 *   hold every price in today's share terms (Yahoo's convention), so readers of returns —
 *   watchlist anchors, benchmarks, the proxy basket, day changes — read them as stored and see
 *   no step on the ex-date. Recording a split rescales the rows before its ex-date once, in the
 *   same transaction; a later write of an unadjusted price for such a day is healed on the way
 *   in (`healIncomingEquityClose`).
 * - **Shares are as held.** A holder's ledger keeps the counts its broker printed, and the split
 *   is a `stock_split` movement on the ex-date carrying the new shares (amount 0: no money moves,
 *   so it is neither a deposit nor P/L). Valuing the shares held on a day therefore reads the
 *   price as traded that day: the adjusted close × the ratios of the splits after it
 *   ({@link equityAsTradedClose}).
 *
 * A split's ratio comes from Yahoo (`events=split`), the broker's notice, or by hand; they must
 * agree. On 2026-11-05 Yahoo listed no SOXX split on its ex-date while Racional had mailed the
 * 3-for-1 before the open — a price that moves like a split with none recorded is refused
 * ({@link splitLikeMoveError}), never valued against the old share count.
 */
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { equityCloseEod, equityMarketKind, equityQuoteCurrency } from "./equityQuote.js";
import { sumUnitsThroughDate } from "./movementTransfer.js";

export const STOCK_SPLIT_FLOW_KIND = "stock_split" as const;

export type EquitySplitSource = "yahoo" | "broker" | "manual";

export type EquitySplit = {
  ticker: string;
  ex_date: string;
  numerator: number;
  denominator: number;
  source: EquitySplitSource;
};

/** A price this far from its neighbour (×1.6 / ÷1.6) is a split until one explains it. */
export const SPLIT_LIKE_MOVE_FACTOR = 1.6;
/** A neighbour further than this is no reference for a split-like move (a backfill's far edge). */
const SPLIT_GUARD_MAX_GAP_DAYS = 10;
/** Two statements of one split agree when their ratios do to this precision. */
const RATIO_EPS = 1e-9;
/** Share counts carry 8–9 decimals; a stored split row may differ from a recomputation by noise. */
const UNITS_EPS = 1e-7;

export function splitRatio(s: Pick<EquitySplit, "numerator" | "denominator">): number {
  return s.numerator / s.denominator;
}

const stmtSplits = db.prepare(
  `SELECT ticker, ex_date, numerator, denominator, source FROM equity_splits
   WHERE UPPER(ticker) = UPPER(?) ORDER BY ex_date`
);

/** The ticker's recorded splits, oldest first. */
export function listEquitySplits(ticker: string): EquitySplit[] {
  return dbStateMemo("equity_splits", ticker.toUpperCase(), () => stmtSplits.all(ticker) as EquitySplit[]);
}

/** Π of the ratios of the ticker's splits with an ex-date after `ymd` (1 when none). */
export function equitySplitFactorAfter(ticker: string, ymd: string): number {
  let f = 1;
  for (const s of listEquitySplits(ticker)) if (s.ex_date > ymd) f *= splitRatio(s);
  return f;
}

/**
 * The close a share held on `ymd` traded at: the stored (adjusted) close on or before `ymd` ×
 * the splits after it. What a holder's share count on `ymd` is valued at.
 */
export function equityAsTradedClose(ticker: string, ymd: string): number | null {
  const close = equityCloseEod(ticker, ymd);
  if (close == null) return null;
  return close * equitySplitFactorAfter(ticker, ymd);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Splits guard only listed shares: a coin trades round the clock and can move that far in a day. */
function guardsSplits(ticker: string): boolean {
  return equityMarketKind(ticker) !== "crypto24";
}

/**
 * Why `price` (in today's share terms) cannot follow `reference` without a split, or null when
 * it can. `reference` is the adjusted close it is compared with.
 */
export function splitLikeMoveError(
  ticker: string,
  ymd: string,
  price: number,
  reference: { ymd: string; close: number }
): string | null {
  if (!guardsSplits(ticker)) return null;
  const r = price / reference.close;
  if (r <= SPLIT_LIKE_MOVE_FACTOR && r >= 1 / SPLIT_LIKE_MOVE_FACTOR) return null;
  return (
    `${ticker} ${ymd}: price ${price} is ×${r.toFixed(3)} the close of ${reference.ymd} (${reference.close}) ` +
    `— a split no source has recorded? Record it (equity_splits) before this price is used`
  );
}

const stmtCloseOn = db.prepare(`SELECT close FROM equity_daily WHERE ticker = ? AND trade_date = ?`);
const stmtCloseBefore = db.prepare(
  `SELECT trade_date, close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`
);
const stmtCloseAfter = db.prepare(
  `SELECT trade_date, close FROM equity_daily WHERE ticker = ? AND trade_date > ? ORDER BY trade_date ASC LIMIT 1`
);

/**
 * The close to store for an incoming `close` of `ticker` on `ymd`. The table is split-adjusted;
 * a source may still send the price as traded (Yahoo before it processes a split, another
 * feed), which is the adjusted price × the splits after `ymd`. The nearest stored close tells
 * the two apart: the candidate closer to it wins. A close that matches neither within
 * {@link SPLIT_LIKE_MOVE_FACTOR} is a split nobody recorded, and throws.
 */
export function healIncomingEquityClose(ticker: string, ymd: string, close: number): number {
  if (!guardsSplits(ticker)) return close;
  const same = stmtCloseOn.get(ticker, ymd) as { close: number } | undefined;
  const before = stmtCloseBefore.get(ticker, ymd) as { trade_date: string; close: number } | undefined;
  const after = stmtCloseAfter.get(ticker, ymd) as { trade_date: string; close: number } | undefined;
  const near = (r: { trade_date: string } | undefined) =>
    r != null && daysBetween(r.trade_date, ymd) <= SPLIT_GUARD_MAX_GAP_DAYS ? r : undefined;
  const ref: { ymd: string; close: number } | null = same
    ? { ymd, close: same.close }
    : near(before)
      ? { ymd: before!.trade_date, close: before!.close }
      : near(after)
        ? { ymd: after!.trade_date, close: after!.close }
        : null;
  const factor = equitySplitFactorAfter(ticker, ymd);
  if (ref == null) return close;
  const candidates = factor === 1 ? [close] : [close, close / factor];
  const dist = (x: number) => Math.abs(Math.log(x / ref.close));
  const best = candidates.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  const err = splitLikeMoveError(ticker, ymd, best, ref);
  if (err) throw new Error(err);
  return best;
}

/** A stored dividend per share of `ticker` on `exDate` that an incoming one restates only by the splits after it. */
export function dividendDiffersOnlyBySplits(ticker: string, exDate: string, stored: number, incoming: number): boolean {
  const f = equitySplitFactorAfter(ticker, exDate);
  return f !== 1 && Math.abs(incoming / f - stored) <= 1e-6 * Math.max(1, stored);
}

export type StockSplitLedgerRow = {
  account_id: number;
  movement_id: number;
  units_before: number;
  units_added: number;
  status: "written" | "present";
};

export type RecordEquitySplitResult = {
  status: "recorded" | "unchanged";
  split: EquitySplit;
  /** Rows rescaled to the post-split frame (only on `recorded`). */
  rescaled: { closes: number; dividends: number; live_quotes: number };
  ledger: StockSplitLedgerRow[];
};

const stmtGetSplit = db.prepare(
  `SELECT ticker, ex_date, numerator, denominator, source FROM equity_splits
   WHERE UPPER(ticker) = UPPER(?) AND ex_date = ?`
);
const stmtInsertSplit = db.prepare(
  `INSERT INTO equity_splits (ticker, ex_date, numerator, denominator, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtHolders = db.prepare(`SELECT id FROM accounts WHERE UPPER(equity_ticker) = UPPER(?) ORDER BY id`);
const stmtSplitRow = db.prepare(
  `SELECT id, units_delta FROM movements WHERE account_id = ? AND occurred_on = ? AND flow_kind = 'stock_split'`
);
const stmtInsertSplitRow = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
   VALUES (?, 0, ?, ?, ?, ?, 'stock_split')`
);


/**
 * Every holder of `split.ticker` with shares the day before the ex-date gets its `stock_split`
 * row (shares × (ratio − 1)); one already there must carry that count.
 */
function writeSplitLedgerRows(split: EquitySplit): StockSplitLedgerRow[] {
  const ratio = splitRatio(split);
  const dayBefore = addDays(split.ex_date, -1);
  const currency = equityQuoteCurrency(split.ticker);
  const out: StockSplitLedgerRow[] = [];
  for (const { id } of stmtHolders.all(split.ticker) as { id: number }[]) {
    const held = sumUnitsThroughDate(id, dayBefore, BROKERAGE_SHARE_UNITS_FLOW_KINDS);
    const existing = stmtSplitRow.get(id, split.ex_date) as { id: number; units_delta: number | null } | undefined;
    if (!(held > UNITS_EPS)) {
      if (existing) throw new Error(`Split ${split.ticker} ${split.ex_date}: account ${id} has a split row but held no shares`);
      continue;
    }
    const added = held * (ratio - 1);
    if (existing) {
      if (existing.units_delta == null || Math.abs(existing.units_delta - added) > UNITS_EPS * Math.max(1, held)) {
        throw new Error(
          `Split ${split.ticker} ${split.ex_date}: account ${id}'s split row ${existing.id} adds ${existing.units_delta} shares, ` +
            `the ${split.numerator}:${split.denominator} split of ${held} adds ${added}`
        );
      }
      out.push({ account_id: id, movement_id: existing.id, units_before: held, units_added: added, status: "present" });
      continue;
    }
    const note = `Split ${split.numerator}:${split.denominator} (${split.ticker}): ${held} → ${held * ratio} shares`;
    const res = stmtInsertSplitRow.run(id, currency, split.ex_date, note, added);
    out.push({
      account_id: id,
      movement_id: Number(res.lastInsertRowid),
      units_before: held,
      units_added: added,
      status: "written",
    });
  }
  return out;
}

/**
 * Re-frame the ticker's stored prices before the ex-date into post-split terms. Closes are
 * walked newest first against the newer neighbour: a row a source already stored adjusted
 * (Yahoo had processed the split before it was recorded here) keeps its value, any other is
 * divided — whichever lies closer to the neighbour, which is itself post-split. The newest
 * pre-split row's neighbour is the ex-date's own close, else today's live quote; with neither,
 * the rows are taken as unadjusted.
 */
function rescalePricesBefore(split: EquitySplit): RecordEquitySplitResult["rescaled"] {
  const ratio = splitRatio(split);
  const t = split.ticker;
  const rows = db
    .prepare(`SELECT trade_date, close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC`)
    .all(t, split.ex_date) as { trade_date: string; close: number }[];
  const post =
    (db
      .prepare(`SELECT close FROM equity_daily WHERE ticker = ? AND trade_date >= ? ORDER BY trade_date ASC LIMIT 1`)
      .get(t, split.ex_date) as { close: number } | undefined)?.close ??
    (db
      .prepare(
        `SELECT value AS close FROM live_market_quotes WHERE UPPER(symbol) = UPPER(?) AND kind = 'equity'
           AND session_ymd >= ? ORDER BY fetched_at DESC LIMIT 1`
      )
      .get(t, split.ex_date) as { close: number } | undefined)?.close ??
    null;
  const upd = db.prepare(`UPDATE equity_daily SET close = ? WHERE ticker = ? AND trade_date = ?`);
  let neighbour = post;
  let closes = 0;
  for (const r of rows) {
    const divided = r.close / ratio;
    const keep =
      neighbour != null && Math.abs(Math.log(r.close / neighbour)) < Math.abs(Math.log(divided / neighbour));
    const v = keep ? r.close : divided;
    if (!keep) {
      upd.run(v, t, r.trade_date);
      closes += 1;
    }
    neighbour = v;
  }
  const dividends = db
    .prepare(`UPDATE equity_dividends SET amount = amount / ? WHERE UPPER(ticker) = UPPER(?) AND ex_date < ?`)
    .run(ratio, t, split.ex_date).changes;
  const liveQuotes = db
    .prepare(
      `UPDATE live_market_quotes SET value = value / ?, previous_value = previous_value / ?
       WHERE UPPER(symbol) = UPPER(?) AND kind = 'equity' AND session_ymd < ?`
    )
    .run(ratio, ratio, t, split.ex_date).changes;
  // A quote of the ex-date session read its previous close in pre-split terms.
  db.prepare(
    `UPDATE live_market_quotes SET previous_value = (
       SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < live_market_quotes.session_ymd
       ORDER BY trade_date DESC LIMIT 1)
     WHERE UPPER(symbol) = UPPER(?) AND kind = 'equity' AND session_ymd = ?`
  ).run(t, t, split.ex_date);
  return { closes, dividends, live_quotes: liveQuotes };
}

/**
 * Record a split and bring prices and holders into its frame, all in one transaction. Idempotent:
 * the same split again is `unchanged` (its ledger rows are checked, and written for a holder that
 * has none yet); a different ratio for the same ex-date throws. A split dated after Chile today
 * is refused — the stored prices only turn post-split on the ex-date.
 */
export function recordEquitySplit(
  input: { ticker: string; ex_date: string; numerator: number; denominator: number; source: EquitySplitSource },
  now: Date = new Date()
): RecordEquitySplitResult {
  const ticker = input.ticker.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.ex_date)) throw new Error(`Split ${ticker}: ex-date ${input.ex_date} is not YYYY-MM-DD`);
  if (!(input.numerator > 0) || !(input.denominator > 0) || input.numerator === input.denominator) {
    throw new Error(`Split ${ticker}: ${input.numerator}:${input.denominator} is not a split`);
  }
  if (!guardsSplits(ticker)) throw new Error(`Split ${ticker}: not a listed share`);
  if (input.ex_date > chileWallClockAt(now).ymd) {
    throw new Error(`Split ${ticker} ${input.ex_date}: the ex-date has not come yet`);
  }
  const split: EquitySplit = {
    ticker: ticker.toUpperCase(),
    ex_date: input.ex_date,
    numerator: input.numerator,
    denominator: input.denominator,
    source: input.source,
  };
  return db
    .transaction((): RecordEquitySplitResult => {
      const stored = stmtGetSplit.get(ticker, input.ex_date) as EquitySplit | undefined;
      if (stored) {
        if (Math.abs(splitRatio(stored) - splitRatio(split)) > RATIO_EPS) {
          throw new Error(
            `Split ${ticker} ${input.ex_date}: recorded ${stored.numerator}:${stored.denominator} (${stored.source}), ` +
              `${input.source} says ${input.numerator}:${input.denominator}`
          );
        }
        return { status: "unchanged", split: stored, rescaled: { closes: 0, dividends: 0, live_quotes: 0 }, ledger: writeSplitLedgerRows(stored) };
      }
      stmtInsertSplit.run(split.ticker, split.ex_date, split.numerator, split.denominator, split.source, new Date().toISOString());
      const rescaled = rescalePricesBefore(split);
      return { status: "recorded", split, rescaled, ledger: writeSplitLedgerRows(split) };
    })
    .immediate();
}
