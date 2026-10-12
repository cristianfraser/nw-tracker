/**
 * Nightly cross-check of the Risky Norris basket against the regulator's filing.
 *
 * The CMF publishes every mutual fund's foreign-securities portfolio for month M some days
 * into month M+1 (`cmfFundPortfolio.ts`). This source asks for the latest month not yet on
 * record once a day from 09:00 Chile until it is published, records the filing as a `cmf`
 * basket in the history (when Fintual stated no basket for that very day), and compares it with
 * the latest basket Fintual stated in the fortnight before the month-end: a ticker Fintual did
 * not state, or a weight more than `CMF_RN_CROSS_CHECK_WEIGHT_ALARM` apart, is a step error —
 * the evening sync prices the proxy off Fintual's own statement, and this is the one independent
 * record of what the fund held.
 *
 * State: `cmfRnPortfolioLastMonth` (latest YYYYMM on record — stored or compared) and
 * `cmfRnPortfolioLastCheckYmd` (the Chile day of the last attempt, one attempt per day).
 */
import fs from "node:fs";
import path from "node:path";
import { chileCalendarAddDays, type ChileWallClock } from "./chileDate.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { cmfBasketForFund, cmfPeriodEndIso, parseCmfForeignPortfolio } from "./cmfFundPortfolio.js";
import { db } from "./db.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import { RISKY_NORRIS_PROXY_BUCKET } from "./watchlistComposite.js";
import {
  compareCompositeHoldings,
  loadCompositePositions,
  recordCompositePositions,
  type CompositePositionHolding,
} from "./watchlistCompositeHistory.js";

/** Risky Norris's RUN at the CMF (the fund's public registry number). */
export const RISKY_NORRIS_CMF_RUN = 9570;
/** First month the fund filed a portfolio (it opened in February 2018). */
export const CMF_RN_FIRST_PERIOD = "201802";
/** The daily attempt runs from this hour (Chile); the CMF publishes during the working day. */
export const CMF_RN_SYNC_HOUR_CHILE = 9;
/** A Fintual basket older than this before the month-end is not comparable (positions move). */
export const CMF_RN_CROSS_CHECK_MAX_GAP_DAYS = 15;
/** A weight this far from Fintual's (as a fraction of the sleeve) is a step error. */
export const CMF_RN_CROSS_CHECK_WEIGHT_ALARM = 0.03;
export const CMF_DOWNLOAD_URL = "https://www.cmfchile.cl/institucional/estadisticas/ffm_download.php";

/** The latest month the CMF can have published: the calendar month before `cl`'s, as YYYYMM. */
export function cmfExpectedPeriod(cl: ChileWallClock): string {
  const y = cl.month === 1 ? cl.year - 1 : cl.year;
  const m = cl.month === 1 ? 12 : cl.month - 1;
  return `${y}${String(m).padStart(2, "0")}`;
}

export function cmfNextPeriod(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6));
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, "0")}`;
}

const stmtLatestRecordedMonth = db.prepare(
  `SELECT max(substr(positions_date, 1, 4) || substr(positions_date, 6, 2)) AS ym
   FROM watchlist_composite_positions
   WHERE bucket_slug = ? AND source = 'cmf'`
);

/**
 * The latest month on record: the state's stamp, else the latest `cmf` basket in the history
 * (the first run after the backfill), else the month before the fund's first.
 */
export function cmfRnLastRecordedPeriod(state: GlobalSyncStateFile, bucketSlug = RISKY_NORRIS_PROXY_BUCKET): string {
  const stamped = state.cmfRnPortfolioLastMonth?.trim();
  if (stamped && /^\d{6}$/.test(stamped)) return stamped;
  const row = stmtLatestRecordedMonth.get(bucketSlug) as { ym: string | null } | undefined;
  if (row?.ym) return row.ym;
  return "201801";
}

/** Stale from 09:00 Chile on any day the expected month is not on record and no attempt ran today. */
export function isCmfRnPortfolioStale(cl: ChileWallClock, state: GlobalSyncStateFile): boolean {
  if (cl.hour < CMF_RN_SYNC_HOUR_CHILE) return false;
  if (state.cmfRnPortfolioLastCheckYmd?.trim() === cl.ymd) return false;
  return cmfRnLastRecordedPeriod(state) < cmfExpectedPeriod(cl);
}

/** The next day and hour the source is due: today at 09:00 if still ahead, else tomorrow 09:00 — or, when the expected month is on record, the first day of next month. */
export function cmfRnNextDueYmd(cl: ChileWallClock, state: GlobalSyncStateFile): string {
  const pending = cmfRnLastRecordedPeriod(state) < cmfExpectedPeriod(cl);
  if (pending) {
    const checkedToday = state.cmfRnPortfolioLastCheckYmd?.trim() === cl.ymd;
    if (!checkedToday && cl.hour < CMF_RN_SYNC_HOUR_CHILE) return cl.ymd;
    return chileCalendarAddDays(cl.ymd, 1);
  }
  const y = cl.month === 12 ? cl.year + 1 : cl.year;
  const m = cl.month === 12 ? 1 : cl.month + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Downloads one month's file; null when the CMF has not published it (its answer is not a file). */
export async function fetchCmfForeignPortfolioText(
  period: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const body = new URLSearchParams({
    mm: period.slice(4, 6),
    aa: period.slice(0, 4),
    cartera: "EXTR",
    btnConsulta: "GENERAR ARCHIVO",
  });
  const res = await fetchImpl(CMF_DOWNLOAD_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0" },
    body,
  });
  if (!res.ok) throw new Error(`CMF ${period}: HTTP ${res.status}`);
  const text = await res.text();
  return text.startsWith("Run Fondo;") ? text : null;
}

/** Where the raw filings are kept beside the other import inputs (`cfraser/cmf-ffm-cartera/`). */
export function cmfFilingsDir(): string {
  return path.join(resolveCfraserCsvDir(), "cmf-ffm-cartera");
}

export type CmfRnCrossCheck = {
  /** The Fintual-stated basket compared against, null when none lies within the window. */
  fintual_positions_date: string | null;
  fintual_source: string | null;
  entered: string[];
  left: string[];
  max_weight_gap: number | null;
  alarm: boolean;
};

const stmtFintualBasketBefore = db.prepare(
  `SELECT positions_date, source FROM watchlist_composite_positions
   WHERE bucket_slug = ? AND source IN ('sync', 'snapshot') AND positions_date <= ? AND positions_date >= ?
   ORDER BY positions_date DESC LIMIT 1`
);

/** Compares a month-end CMF basket with the latest basket Fintual stated in the fortnight before it. */
export function crossCheckCmfBasket(
  monthEndIso: string,
  cmfHoldings: CompositePositionHolding[],
  bucketSlug = RISKY_NORRIS_PROXY_BUCKET
): CmfRnCrossCheck {
  const from = chileCalendarAddDays(monthEndIso, -CMF_RN_CROSS_CHECK_MAX_GAP_DAYS);
  const ref = stmtFintualBasketBefore.get(bucketSlug, monthEndIso, from) as
    | { positions_date: string; source: string }
    | undefined;
  if (!ref) {
    return { fintual_positions_date: null, fintual_source: null, entered: [], left: [], max_weight_gap: null, alarm: false };
  }
  const fintual = loadCompositePositions(bucketSlug, ref.positions_date);
  if (!fintual) throw new Error(`cross-check: basket ${ref.positions_date} vanished`);
  const diffs = compareCompositeHoldings(fintual.holdings, cmfHoldings);
  const entered = diffs.filter((d) => d.stored == null).map((d) => d.ticker);
  const left = diffs.filter((d) => d.stated == null).map((d) => d.ticker);
  let maxGap = 0;
  for (const d of diffs) {
    if (d.stored == null || d.stated == null) continue;
    maxGap = Math.max(maxGap, Math.abs(d.stored - d.stated));
  }
  return {
    fintual_positions_date: ref.positions_date,
    fintual_source: ref.source,
    entered,
    left,
    max_weight_gap: maxGap,
    alarm: entered.length > 0 || left.length > 0 || maxGap > CMF_RN_CROSS_CHECK_WEIGHT_ALARM,
  };
}

export type CmfRnPeriodResult = {
  period: string;
  month_end: string;
  etf_weight_sum: number;
  holdings: CompositePositionHolding[];
  /** `inserted` a new cmf basket; `fintual_dated` Fintual stated this very day (kept); `stored` already on record. */
  record: "inserted" | "fintual_dated" | "stored";
  cross_check: CmfRnCrossCheck;
  saved_file: string | null;
};

export type SyncCmfRnPortfolioResult = {
  processed: CmfRnPeriodResult[];
  /** The first expected month the CMF has not published yet, if the run stopped on one. */
  not_published: string | null;
};

export type SyncCmfRnPortfolioOptions = { fetchImpl?: typeof fetch; saveFiles?: boolean };

/**
 * Fetches every month from the one after the last on record through the expected month, stopping
 * at the first the CMF has not published. Stamps the state on the shared object (the runner saves
 * it); the attempt day is stamped whatever happened, so a quiet day costs one request.
 */
export async function syncCmfRnPortfolio(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  opts: SyncCmfRnPortfolioOptions = {}
): Promise<SyncCmfRnPortfolioResult> {
  const expected = cmfExpectedPeriod(cl);
  const processed: CmfRnPeriodResult[] = [];
  let notPublished: string | null = null;
  let period = cmfNextPeriod(cmfRnLastRecordedPeriod(state));
  state.cmfRnPortfolioLastCheckYmd = cl.ymd;
  while (period <= expected) {
    const text = await fetchCmfForeignPortfolioText(period, opts.fetchImpl);
    if (text == null) {
      notPublished = period;
      break;
    }
    const rows = parseCmfForeignPortfolio(text, RISKY_NORRIS_CMF_RUN);
    if (!rows.length) throw new Error(`CMF ${period}: the filing has no foreign holdings for RUN ${RISKY_NORRIS_CMF_RUN}`);
    const basket = cmfBasketForFund(rows, RISKY_NORRIS_CMF_RUN);
    const monthEnd = cmfPeriodEndIso(period);
    let savedFile: string | null = null;
    if (opts.saveFiles ?? true) {
      const dir = cmfFilingsDir();
      if (fs.existsSync(path.dirname(dir))) {
        fs.mkdirSync(dir, { recursive: true });
        savedFile = path.join(dir, `FFM_INV_EXTR_${period}.txt`);
        if (!fs.existsSync(savedFile)) fs.writeFileSync(savedFile, text);
      }
    }
    const existing = loadCompositePositions(RISKY_NORRIS_PROXY_BUCKET, monthEnd);
    let record: CmfRnPeriodResult["record"];
    if (!existing) {
      const r = recordCompositePositions({
        bucket_slug: RISKY_NORRIS_PROXY_BUCKET,
        positions_date: monthEnd,
        etf_weight_sum: basket.etf_weight_sum,
        source: "cmf",
        holdings: basket.holdings,
      });
      if (r.status !== "inserted") throw new Error(`CMF ${period}: unexpected record status ${r.status}`);
      record = "inserted";
    } else {
      record = existing.source === "cmf" ? "stored" : "fintual_dated";
    }
    processed.push({
      period,
      month_end: monthEnd,
      etf_weight_sum: basket.etf_weight_sum,
      holdings: basket.holdings,
      record,
      cross_check: crossCheckCmfBasket(monthEnd, basket.holdings),
      saved_file: savedFile,
    });
    state.cmfRnPortfolioLastMonth = period;
    period = cmfNextPeriod(period);
  }
  return { processed, not_published: notPublished };
}
