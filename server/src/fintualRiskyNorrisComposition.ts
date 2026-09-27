import { chileCalendarAddDays, chileWallClockNow, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import { ensureEquityDailyHistoryForWatchlistTickers } from "./equityDailyWatchlistBackfill.js";
import { equityCloseEod } from "./equityQuote.js";
import { isFintualCarryForwardFundUnitNote } from "./fintualFundUnitDaily.js";
import {
  FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS,
  verifyFintualSeriesAgainstOfficialPrices,
  type FintualSerieReconcileResult,
} from "./fintualPublicSeriePrice.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "./globalSyncState.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import { isChileBusinessDay } from "./marketHolidays.js";
import {
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
  basketUsdForHoldings,
  loadCompositeHoldings,
  loadCompositeMeta,
  OFFICIAL_APV_FUND_UNIT_SERIES_KEYS,
  OFFICIAL_RISKY_NORRIS_FUND_UNIT_SERIES_KEYS,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  type CompositeHolding,
  type CompositeMeta,
} from "./watchlistComposite.js";

export const FINTUAL_RN_MANAGED_FUND_ID = 4;
export const FINTUAL_INVERSIONES_API_BASE = "https://inversiones.fintual.com";
const WEIGHT_SUM_MAX = 1.01;
/** Minimum raw ETF weight sum before normalization (excludes fund/bond sleeves). */
const ETF_WEIGHT_SUM_MIN = 0.95;

/**
 * Every top-level field the endpoint is known to carry. Anything else throws — a renamed or new
 * sleeve must be looked at before the proxy keeps pricing off a payload it only half understands.
 * Only `etf_positions` is read; the fund, bond and future-contract sleeves are the non-ETF remainder
 * that `ETF_WEIGHT_SUM_MIN` bounds (`future_contract_positions` appeared 2026-09-01, empty so far).
 */
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "date",
  "etf_positions",
  "fund_positions",
  "bond_positions",
  "future_contract_positions",
]);

/**
 * Fintual tickers whose bare symbol resolves to a different instrument on Yahoo.
 * Fintual's "SPXS" is the Invesco S&P 500 UCITS ETF (Acc, LSE, USD ~$1,000/share);
 * Yahoo's bare SPXS is the Direxion Daily S&P 500 Bear 3X ETF (~$26). Price that
 * sleeve with a same-index US-listed ETF so the NYSE EOD/live-quote pipelines apply.
 */
export const FINTUAL_TICKER_PRICE_PROXY: Readonly<Record<string, string>> = {
  SPXS: "SPY",
};

export type FintualManagedFundPositionsResponse = {
  date: string;
  etf_positions: FintualEtfPosition[];
  /** Raw ETF weight sum before normalization. */
  raw_etf_weight_sum: number;
};

const stmtFundUnitOnDate = db.prepare(
  `SELECT unit_value_clp, note FROM fund_unit_daily
   WHERE series_key = ? AND day = ? LIMIT 1`
);
const stmtSeriesHasRowOnOrBefore = db.prepare(
  `SELECT 1 FROM fund_unit_daily WHERE series_key = ? AND day <= ? LIMIT 1`
);

const stmtDeleteHoldings = db.prepare(
  `DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`
);

const stmtUpsertMeta = db.prepare(
  `INSERT INTO watchlist_composite_meta (
     bucket_slug, fintual_managed_fund_id, composition_date,
     anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(bucket_slug) DO UPDATE SET
     fintual_managed_fund_id = excluded.fintual_managed_fund_id,
     composition_date = excluded.composition_date,
     anchor_fund_unit_clp = excluded.anchor_fund_unit_clp,
     anchor_apv_fund_unit_clp = excluded.anchor_apv_fund_unit_clp,
     anchor_basket_usd = excluded.anchor_basket_usd,
     anchor_fx_clp = excluded.anchor_fx_clp,
     last_sync_ymd = excluded.last_sync_ymd`
);

const stmtInsertHolding = db.prepare(
  `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
   VALUES (?, ?, ?, ?)`
);

export type FintualEtfPosition = {
  weight: number;
  etf: { asset: { ticker: string } };
};

export function parseManagedFundPositionsBody(body: unknown): FintualManagedFundPositionsResponse {
  if (!body || typeof body !== "object") {
    throw new Error("Fintual managed fund positions: invalid JSON body");
  }
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Fintual managed fund positions: unexpected field "${key}"`);
    }
  }
  const date = typeof o.date === "string" ? o.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Fintual managed fund positions: invalid date "${date}"`);
  }
  if (!Array.isArray(o.etf_positions)) {
    throw new Error("Fintual managed fund positions: etf_positions must be an array");
  }
  const etf_positions: FintualEtfPosition[] = [];
  for (const raw of o.etf_positions) {
    if (!raw || typeof raw !== "object") continue;
    const pos = raw as { weight?: unknown; etf?: unknown };
    const weight = typeof pos.weight === "number" ? pos.weight : Number(pos.weight);
    const etf = pos.etf as { asset?: { ticker?: unknown } } | undefined;
    const tickerRaw = etf?.asset?.ticker;
    const ticker = typeof tickerRaw === "string" ? tickerRaw.trim().toUpperCase() : "";
    if (!Number.isFinite(weight) || weight <= 0 || !ticker) {
      throw new Error("Fintual managed fund positions: invalid etf_positions row");
    }
    etf_positions.push({ weight, etf: { asset: { ticker } } });
  }
  if (!etf_positions.length) {
    throw new Error("Fintual managed fund positions: empty etf_positions");
  }
  const rawSum = etf_positions.reduce((s, p) => s + p.weight, 0);
  if (rawSum < ETF_WEIGHT_SUM_MIN) {
    throw new Error(
      `Fintual managed fund positions: etf weight sum ${rawSum} below ${ETF_WEIGHT_SUM_MIN}`
    );
  }
  if (rawSum > WEIGHT_SUM_MAX) {
    throw new Error(
      `Fintual managed fund positions: etf weight sum ${rawSum} above ${WEIGHT_SUM_MAX}`
    );
  }
  const normalized = etf_positions.map((p) => ({ ...p, weight: p.weight / rawSum }));
  return { date, etf_positions: normalized, raw_etf_weight_sum: rawSum };
}

export async function fetchRiskyNorrisComposition(
  fetchImpl: typeof fetch = fetch
): Promise<FintualManagedFundPositionsResponse> {
  const url = `${FINTUAL_INVERSIONES_API_BASE}/api/managed_funds/managed_fund_full_last_detailed_positions/${FINTUAL_RN_MANAGED_FUND_ID}`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "nw-tracker/1.0",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fintual managed fund positions HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Fintual managed fund positions: response is not JSON");
  }
  return parseManagedFundPositionsBody(body);
}

/** Holdings keyed by the Yahoo ticker used for pricing (weights merged when two Fintual tickers map to one). */
export function holdingsForPricing(
  positions: FintualEtfPosition[],
  compositionDate: string
): CompositeHolding[] {
  const weightByPriceTicker = new Map<string, number>();
  for (const p of positions) {
    const ticker = FINTUAL_TICKER_PRICE_PROXY[p.etf.asset.ticker] ?? p.etf.asset.ticker;
    weightByPriceTicker.set(ticker, (weightByPriceTicker.get(ticker) ?? 0) + p.weight);
  }
  return [...weightByPriceTicker].map(([ticker, weight]) => ({
    ticker,
    weight,
    synced_at: compositionDate,
  }));
}

/** How far back from Fintual's positions date the anchor may walk before the series is declared stale. */
export const RN_COMPOSITION_ANCHOR_MAX_WALK_DAYS = 14;
/**
 * Self-check alarm: |the previous anchor's prediction − the official cuota| beyond this many
 * basis points is a step error. Measured 2026-09-22 over 79 sessions (2026-05-27..09-17, current
 * holdings): per-session error rmse 24 bp, p90 29 bp, nothing beyond 30 bp after June — so 30 bp
 * would have alarmed seven times in four months. The anchor-pairing defect this check exists for
 * read −50 bp (a Friday NYSE session Fintual carried flat over a Chile holiday, missing from the
 * level) and −190 bp (a cuota one day older than its price base).
 */
export const RN_COMPOSITION_SELF_CHECK_ERROR_BP = 40;
/**
 * Series refreshed from the official public prices before anchoring: the Risky Norris A serie
 * (serie 6, the anchor — the empty RN goal never publishes in the evening poll, so this is its
 * only source) and the APV serie (serie 7) the APV/RN ratio needs on the same day.
 */
export const RN_COMPOSITION_REFRESH_SERIES_KEYS: readonly string[] = [
  "fintual_cert_risky_norris",
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
];

export type CompositionAnchor = {
  /**
   * The day whose valuation the anchor cuota embeds — a Chile business day on or before Fintual's
   * positions date carrying a published (non-carry) Risky Norris cuota. Stored as
   * `watchlist_composite_meta.composition_date`, so the basket's price base (closes on or before
   * it) and the fx base (that day's dólar observado) resolve on the session the cuota was priced with.
   */
  anchor_ymd: string;
  series_key: string;
  fund_unit_clp: number;
  /** APV régimen cuota on `anchor_ymd` exactly; null only when no APV serie exists at all (demo/CI). */
  apv_fund_unit_clp: number | null;
  /** Fintual's positions "as of" date — the holdings' date, informational. */
  positions_ymd: string;
};

type FundUnitRow = { unit_value_clp: number; note: string | null };

function publishedFundUnitOnDay(
  seriesKeys: readonly string[],
  ymd: string
): { series_key: string; unit_value_clp: number } | null {
  for (const seriesKey of seriesKeys) {
    const row = stmtFundUnitOnDate.get(seriesKey, ymd) as FundUnitRow | undefined;
    if (row == null || !Number.isFinite(row.unit_value_clp) || row.unit_value_clp <= 0) continue;
    if (isFintualCarryForwardFundUnitNote(row.note)) continue;
    return { series_key: seriesKey, unit_value_clp: row.unit_value_clp };
  }
  return null;
}

function apvFundUnitOnAnchorDay(apvSeriesKeys: readonly string[], anchorYmd: string): number | null {
  const exact = publishedFundUnitOnDay(apvSeriesKeys, anchorYmd);
  if (exact != null) return exact.unit_value_clp;
  for (const seriesKey of apvSeriesKeys) {
    if (stmtSeriesHasRowOnOrBefore.get(seriesKey, anchorYmd) != null) {
      throw new Error(
        `Risky Norris composition: ${seriesKey} has no published cuota on anchor day ${anchorYmd} — ` +
          `the APV/RN ratio needs both cuotas on one valuation; fill the serie (fintual:backfill-cert-fund-units) before anchoring`
      );
    }
  }
  return null;
}

/**
 * Resolve the proxy's anchor for Fintual's positions date.
 *
 * Fintual values Risky Norris only on Chile business days: a weekend or Chile-holiday row is a
 * flat carry of the previous business day's valuation, and a NYSE session Fintual did not value
 * (a Chile holiday) only enters the cuota on the next business day. Anchoring on the positions
 * date itself paired that carried cuota with the closes of a session it does not contain
 * (2026-09-20: the 09-17 valuation under Friday 09-18's closes — Friday's +0,41% never entered
 * the level, and the APV cards read −1,04% for a −0,49% day), and a positions date newer than the
 * latest cuota paired an older cuota with newer closes (2026-09-21: the 09-16 cuota under 09-17's
 * closes, −190 bp). So the anchor day is the latest Chile business day on or before the positions
 * date that carries a published cuota; a carry-forward placeholder is skipped like a holiday. The
 * APV cuota must exist on that exact day — the APV/RN ratio is only meaningful on one valuation —
 * and an APV serie that exists but lacks the day is a data gap (throws), never an on-or-before
 * substitute.
 */
export function resolveCompositionAnchor(
  positionsYmd: string,
  opts: { seriesKeys?: readonly string[]; apvSeriesKeys?: readonly string[] } = {}
): CompositionAnchor {
  const seriesKeys = opts.seriesKeys ?? OFFICIAL_RISKY_NORRIS_FUND_UNIT_SERIES_KEYS;
  const apvSeriesKeys = opts.apvSeriesKeys ?? OFFICIAL_APV_FUND_UNIT_SERIES_KEYS;
  let ymd = positionsYmd;
  for (let step = 0; step <= RN_COMPOSITION_ANCHOR_MAX_WALK_DAYS; step++) {
    if (isChileBusinessDay(ymd)) {
      const rn = publishedFundUnitOnDay(seriesKeys, ymd);
      if (rn != null) {
        return {
          anchor_ymd: ymd,
          series_key: rn.series_key,
          fund_unit_clp: rn.unit_value_clp,
          apv_fund_unit_clp: apvFundUnitOnAnchorDay(apvSeriesKeys, ymd),
          positions_ymd: positionsYmd,
        };
      }
    }
    ymd = chileCalendarAddDays(ymd, -1);
  }
  throw new Error(
    `Risky Norris composition: no published Risky Norris cuota on a Chile business day within ` +
      `${RN_COMPOSITION_ANCHOR_MAX_WALK_DAYS} days before ${positionsYmd} (${seriesKeys.join(", ")}) — fund_unit_daily stale`
  );
}

export type CompositionSelfCheck = {
  previous_anchor_ymd: string;
  anchor_ymd: string;
  /** The previous anchor's EOD prediction for `anchor_ymd`, CLP per cuota. */
  predicted_clp: number;
  official_clp: number;
  /** (predicted ÷ official − 1) in basis points. */
  error_bp: number;
  /** |error_bp| beyond `RN_COMPOSITION_SELF_CHECK_ERROR_BP`. */
  alarm: boolean;
};

/**
 * What the proxy said the cuota would be on the day that now anchors it, against what Fintual
 * printed: the previous anchor's EOD estimate for `anchor.anchor_ymd`, computed exactly as the
 * app valued that day. Between two consecutive anchors this is the per-session proxy error
 * (24 bp rmse); a pairing defect or a stale composition reads as a step change. Null when
 * nothing new was published since the previous anchor (or there was none).
 */
export function compositionSelfCheck(
  previous: CompositeMeta | null,
  previousHoldings: CompositeHolding[],
  anchor: CompositionAnchor,
  now: Date = new Date()
): CompositionSelfCheck | null {
  if (previous == null || previousHoldings.length === 0) return null;
  if (previous.composition_date >= anchor.anchor_ymd) return null;
  const predicted = proxyClpFromMeta(previous, previousHoldings, anchor.anchor_ymd, {
    preferLive: false,
    now,
  });
  const error_bp = (predicted / anchor.fund_unit_clp - 1) * 10_000;
  return {
    previous_anchor_ymd: previous.composition_date,
    anchor_ymd: anchor.anchor_ymd,
    predicted_clp: predicted,
    official_clp: anchor.fund_unit_clp,
    error_bp,
    alarm: Math.abs(error_bp) > RN_COMPOSITION_SELF_CHECK_ERROR_BP,
  };
}

export type SyncRiskyNorrisCompositionResult = {
  /** The anchor day (`CompositionAnchor.anchor_ymd`) — what `composition_date` now holds. */
  composition_date: string;
  /** Fintual's positions "as of" date (the holdings' date). */
  positions_date: string;
  tickers: string[];
  holdings_count: number;
  anchor_fund_unit_clp: number;
  anchor_apv_fund_unit_clp: number | null;
  anchor_basket_usd: number;
  raw_etf_weight_sum: number;
  /** The official public-serie refresh run before anchoring; `error` = fetch failed, anchored on the stored series. */
  official_refresh: { results: FintualSerieReconcileResult[] } | { error: string };
  self_check: CompositionSelfCheck | null;
  /** The self-check could not be computed (e.g. a dropped ticker with no bar on the anchor day). */
  self_check_error: string | null;
};

export type SyncRiskyNorrisCompositionOptions = {
  /** Skip the official public-serie refresh (offline runs, tests); default on. */
  refreshOfficialSeries?: boolean;
  fetchImpl?: typeof fetch;
};

/**
 * @param sharedState When called from `runGlobalSyncAll`, its in-memory state snapshot.
 * The runner saves that snapshot in its `finally`, so the `fintualRnCompositionLastSyncYmd`
 * stamp must land on the same object — a load/save here would be clobbered by that final save,
 * leaving the source stale forever (15-minute re-sync loop). Standalone callers omit it and
 * this function loads/saves the state file itself.
 */
export async function syncRiskyNorrisComposition(
  cl: ChileWallClock = chileWallClockNow(),
  sharedState?: GlobalSyncStateFile,
  opts: SyncRiskyNorrisCompositionOptions = {}
): Promise<SyncRiskyNorrisCompositionResult> {
  const api = await fetchRiskyNorrisComposition(opts.fetchImpl);
  const positionsDate = api.date;
  const holdings = holdingsForPricing(api.etf_positions, positionsDate);
  const tickers = holdings.map((h) => h.ticker);

  await ensureEquityDailyHistoryForWatchlistTickers(tickers, cl.ymd);

  // The anchor serie publishes day D on D+1 through the official public prices only, so refresh
  // it (and the APV serie the ratio needs) first — otherwise the anchor lags the publisher by
  // however old the last goals poll is. A failed refresh is reported, never a reason not to
  // re-anchor on what the DB holds (the pairing stays consistent, only older).
  let official_refresh: SyncRiskyNorrisCompositionResult["official_refresh"];
  if (opts.refreshOfficialSeries ?? true) {
    try {
      const results = await verifyFintualSeriesAgainstOfficialPrices({
        fromYmd: chileCalendarAddDays(cl.ymd, -FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS),
        toYmd: cl.ymd,
        dryRun: false,
        seriesKeys: RN_COMPOSITION_REFRESH_SERIES_KEYS,
        fetchImpl: opts.fetchImpl,
      });
      official_refresh = { results };
    } catch (e) {
      official_refresh = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    official_refresh = { results: [] };
  }

  const anchor = resolveCompositionAnchor(positionsDate);
  for (const ticker of tickers) {
    const close = equityCloseEod(ticker, anchor.anchor_ymd);
    if (close == null || !Number.isFinite(close) || close <= 0) {
      throw new Error(
        `Risky Norris composition sync: missing equity_daily for ${ticker} on or before ${anchor.anchor_ymd}`
      );
    }
  }

  const previous = loadCompositeMeta(RISKY_NORRIS_PROXY_BUCKET);
  const previousHoldings = loadCompositeHoldings(RISKY_NORRIS_PROXY_BUCKET);
  let self_check: CompositionSelfCheck | null = null;
  let self_check_error: string | null = null;
  try {
    self_check = compositionSelfCheck(previous, previousHoldings, anchor);
  } catch (e) {
    self_check_error = e instanceof Error ? e.message : String(e);
  }

  // Informational snapshots only — valuation uses per-ticker relative prices
  // (basketReturnForHoldings) and re-resolves the observado-frame fx at read time.
  const anchor_basket_usd = basketUsdForHoldings(holdings, anchor.anchor_ymd, { preferLive: false });
  const anchor_fx_clp = observadoFrameFxForDay(anchor.anchor_ymd).clp_per_usd;
  const last_sync_ymd = cl.ymd;

  let anchor_apv_fund_unit_clp: number | null = null;
  if (anchor.apv_fund_unit_clp != null) {
    const relDiff = Math.abs(anchor.apv_fund_unit_clp - anchor.fund_unit_clp) / anchor.fund_unit_clp;
    if (relDiff >= APV_PROXY_NEGLIGIBLE_REL_DIFF) {
      anchor_apv_fund_unit_clp = anchor.apv_fund_unit_clp;
    }
  }

  db.transaction(() => {
    stmtUpsertMeta.run(
      RISKY_NORRIS_PROXY_BUCKET,
      FINTUAL_RN_MANAGED_FUND_ID,
      anchor.anchor_ymd,
      anchor.fund_unit_clp,
      anchor_apv_fund_unit_clp,
      anchor_basket_usd,
      anchor_fx_clp,
      last_sync_ymd
    );
    stmtDeleteHoldings.run(RISKY_NORRIS_PROXY_BUCKET);
    for (const h of holdings) {
      stmtInsertHolding.run(RISKY_NORRIS_PROXY_BUCKET, h.ticker, h.weight, h.synced_at);
    }
  })();

  if (sharedState) {
    sharedState.fintualRnCompositionLastSyncYmd = last_sync_ymd;
  } else {
    const state = loadGlobalSyncState();
    state.fintualRnCompositionLastSyncYmd = last_sync_ymd;
    saveGlobalSyncState(state);
  }

  return {
    composition_date: anchor.anchor_ymd,
    positions_date: positionsDate,
    tickers,
    holdings_count: holdings.length,
    anchor_fund_unit_clp: anchor.fund_unit_clp,
    anchor_apv_fund_unit_clp,
    anchor_basket_usd,
    raw_etf_weight_sum: api.raw_etf_weight_sum,
    official_refresh,
    self_check,
    self_check_error,
  };
}
