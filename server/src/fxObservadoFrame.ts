import { chileCalendarAddDays, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";

/**
 * The dólar observado frame — the fx a Fintual cuota actually embeds.
 *
 * Fintual values Risky Norris for day D with day D's US closes and day D's CHILEAN INTERBANK
 * fx: the Banco Central «dólar observado» published on the next bank business day is the
 * weighted average of day D's interbank trades (the market closes 14:00 Chile). Yahoo's CLP=X
 * close is a single print at 17:05 New York, three to four hours after that market closed, so
 * valuing the proxy with it carried every late-afternoon peso move into today and out again
 * tomorrow. Measured 2026-09-11 over 66 sessions: US closes × observado(D+1)/observado(D)
 * reproduces the official cuota return with 18 bp rmse (corr 0,990), US closes × Yahoo close
 * 31 bp (err↔fx corr −0,41, lag-1 autocorr −0,28); every lag-1 price variant was uncorrelated.
 *
 * `fx_daily_bcentral` rows are keyed by PUBLICATION date, so day D's frame value is the first
 * row dated after D. Until it is published (D itself, or D-1 before the evening `sbif_usd`
 * sync) the best estimate is the running average of the live USD/CLP prints (`live_market_quotes`, the same rows
 * `fxForLiveMtm` reads) inside D's interbank window (2026-09-09: window average 925,55 vs the observado published next morning 925,97),
 * and with no prints yet the frame's most recent observation on an earlier day — yesterday's
 * window estimate while yesterday's publication is pending too, else the last published
 * observado — the same on-or-before convention every other series uses (carrying the last
 * PUBLISHED row instead would pair today's basket with the interbank fx of two sessions ago:
 * 2026-09-11 00:40 read −119 bp against the official 09-10 cuota that way). A row missing where
 * one was due is a data gap and throws; the caller must not guess a frame.
 */
const CHILE_TZ = "America/Santiago";
export const INTERBANK_WINDOW_START_CHILE = { hour: 9, minute: 0 } as const;
export const INTERBANK_WINDOW_END_CHILE = { hour: 14, minute: 0 } as const;
/** Prints needed before a running window average counts as an estimate (5-min poll ⇒ ~15 min). */
export const INTERBANK_WINDOW_MIN_PRINTS = 3;
/** A publication further than this after `ymd` is a series gap, never "the next one". */
export const OBSERVADO_PUBLICATION_MAX_LAG_DAYS = 7;
/** With nothing published after `ymd`, the last row must be at most this old or the sync is stale. */
export const OBSERVADO_PENDING_MAX_STALE_DAYS = 7;

export type ObservadoFrameFx = {
  clp_per_usd: number;
  /**
   * published: the observado printed after `ymd` (day `ymd`'s interbank average);
   * interbank_window: running average of live USD/CLP prints inside `ymd`'s interbank window
   * (publication pending); carry: the frame's most recent observation on an earlier day
   * (pending, no prints on `ymd` yet).
   */
  source: "published" | "interbank_window" | "carry";
  /** Publication date of the observado row used, or the day whose window average was used. */
  as_of: string;
};

const stmtFirstPublishedAfter = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily_bcentral WHERE date > ? ORDER BY date ASC LIMIT 1`
);
const stmtLatestPublishedOnOrBefore = db.prepare(
  `SELECT date, clp_per_usd FROM fx_daily_bcentral WHERE date <= ? ORDER BY date DESC LIMIT 1`
);
const stmtWindowPrints = db.prepare(
  `SELECT AVG(value) AS avg, COUNT(*) AS n FROM live_market_quotes
   WHERE symbol = ? AND kind = 'fx_clp_per_usd' AND fetched_at >= ? AND fetched_at <= ?`
);

type ObservadoRow = { date: string; clp_per_usd: number };

function validRow(row: ObservadoRow | undefined): ObservadoRow | null {
  if (row == null || !Number.isFinite(row.clp_per_usd) || row.clp_per_usd <= 0) return null;
  return row;
}

/** Instants bounding day `ymd`'s interbank window (Chile wall clock), the end capped at `now`. */
export function interbankWindowBounds(ymd: string, now: Date): { start: Date; end: Date } {
  const start = dateAtTimeZoneWallClock(
    ymd,
    INTERBANK_WINDOW_START_CHILE.hour,
    INTERBANK_WINDOW_START_CHILE.minute,
    CHILE_TZ
  );
  const close = dateAtTimeZoneWallClock(
    ymd,
    INTERBANK_WINDOW_END_CHILE.hour,
    INTERBANK_WINDOW_END_CHILE.minute,
    CHILE_TZ
  );
  const end = now.getTime() < close.getTime() ? now : close;
  return { start, end };
}

/** Running average of the live CLP=X prints inside day `ymd`'s interbank window, up to `now`. */
export function interbankWindowAverageClpPerUsd(
  ymd: string,
  now: Date
): { clp_per_usd: number; prints: number } | null {
  const { start, end } = interbankWindowBounds(ymd, now);
  if (end.getTime() <= start.getTime()) return null;
  const row = stmtWindowPrints.get(LIVE_FX_SYMBOL, start.toISOString(), end.toISOString()) as
    | { avg: number | null; n: number }
    | undefined;
  if (row == null || row.n < INTERBANK_WINDOW_MIN_PRINTS || row.avg == null) return null;
  if (!Number.isFinite(row.avg) || row.avg <= 0) return null;
  return { clp_per_usd: row.avg, prints: row.n };
}

/** The dólar observado frame fx for day `ymd` — see the module doc for the three sources. */
export function observadoFrameFxForDay(ymd: string, now: Date = new Date()): ObservadoFrameFx {
  const published = publishedFrameFx(ymd);
  if (published != null) return published;

  // Nothing published after ymd yet: today, or a recent day whose publication the evening
  // sbif_usd sync has not landed. The last published row bounds how recent "pending" may be.
  const head = validRow(stmtLatestPublishedOnOrBefore.get(ymd) as ObservadoRow | undefined);
  if (head == null) {
    throw new Error(`observado frame ${ymd}: no fx_daily_bcentral row on or before ${ymd}`);
  }
  if (head.date < chileCalendarAddDays(ymd, -OBSERVADO_PENDING_MAX_STALE_DAYS)) {
    throw new Error(
      `observado frame ${ymd}: dólar observado series ends ${head.date} — sbif_usd sync stale`
    );
  }
  return pendingFrameFx(ymd, now, head);
}

/** Route 1: the observado published after `ymd`, when it exists (a wide gap throws). */
function publishedFrameFx(ymd: string): ObservadoFrameFx | null {
  const next = validRow(stmtFirstPublishedAfter.get(ymd) as ObservadoRow | undefined);
  if (next == null) return null;
  if (next.date > chileCalendarAddDays(ymd, OBSERVADO_PUBLICATION_MAX_LAG_DAYS)) {
    throw new Error(
      `observado frame ${ymd}: no dólar observado published within ${OBSERVADO_PUBLICATION_MAX_LAG_DAYS} days after it (next row ${next.date}) — fx_daily_bcentral gap, run the sbif_usd backfill`
    );
  }
  return { clp_per_usd: next.clp_per_usd, source: "published", as_of: next.date };
}

/**
 * Routes 2 and 3 for a day whose publication is pending: this day's window average, else the
 * most recent observation on an earlier day — walking back one day at a time, each earlier day
 * either publishes (route 1, always true once the walk passes `head.date`) or contributes its
 * own window average. `head` is the last published row on or before the original day, so the
 * walk is bounded by the staleness guard already applied to it.
 */
function pendingFrameFx(ymd: string, now: Date, head: ObservadoRow): ObservadoFrameFx {
  const window = interbankWindowAverageClpPerUsd(ymd, now);
  if (window != null) {
    return { clp_per_usd: window.clp_per_usd, source: "interbank_window", as_of: ymd };
  }
  let day = ymd;
  for (let i = 0; i <= OBSERVADO_PENDING_MAX_STALE_DAYS + 1; i++) {
    day = chileCalendarAddDays(day, -1);
    const published = publishedFrameFx(day);
    if (published != null) {
      return { clp_per_usd: published.clp_per_usd, source: "carry", as_of: published.as_of };
    }
    const earlier = interbankWindowAverageClpPerUsd(day, now);
    if (earlier != null) {
      return { clp_per_usd: earlier.clp_per_usd, source: "carry", as_of: day };
    }
  }
  // Unreachable while the staleness guard holds (the walk passes head.date within the bound).
  return { clp_per_usd: head.clp_per_usd, source: "carry", as_of: head.date };
}

/** Chile calendar day of `now` — the day whose window a live proxy reads. */
export function observadoFrameTodayYmd(now: Date = new Date()): string {
  return chileWallClockAt(now).ymd;
}
