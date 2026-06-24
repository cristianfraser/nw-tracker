import {
  chileCalendarAddDays,
  chileWallClockNow,
  type ChileWallClock,
} from "./chileDate.js";
import { db } from "./db.js";
import { ensureEquityDailyHistoryForWatchlistTickers } from "./equityDailyWatchlistBackfill.js";
import { equityCloseUsdEod } from "./equityQuote.js";
import { loadGlobalSyncState, saveGlobalSyncState } from "./globalSyncState.js";
import {
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
  basketUsdForHoldings,
  officialApvFundUnitOnOrBefore,
  officialRiskyNorrisFundUnitOnOrBefore,
  RISKY_NORRIS_PROXY_BUCKET,
  type CompositeHolding,
} from "./watchlistComposite.js";

export const FINTUAL_RN_MANAGED_FUND_ID = 4;
export const FINTUAL_INVERSIONES_API_BASE = "https://inversiones.fintual.com";
export const COMPOSITION_STALE_DAYS = 30;
const WEIGHT_SUM_MIN = 0.99;
const WEIGHT_SUM_MAX = 1.01;
/** Minimum raw ETF weight sum before normalization (excludes fund/bond sleeves). */
const ETF_WEIGHT_SUM_MIN = 0.95;

const ALLOWED_TOP_LEVEL_KEYS = new Set(["date", "etf_positions", "fund_positions", "bond_positions"]);

export type FintualManagedFundPositionsResponse = {
  date: string;
  etf_positions: FintualEtfPosition[];
  /** Raw ETF weight sum before normalization. */
  raw_etf_weight_sum: number;
};

const stmtFundUnitOnDate = db.prepare(
  `SELECT unit_value_clp FROM fund_unit_daily
   WHERE series_key = ? AND day = ? LIMIT 1`
);

const stmtFxOnOrBefore = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
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

export async function fetchRiskyNorrisComposition(): Promise<FintualManagedFundPositionsResponse> {
  const url = `${FINTUAL_INVERSIONES_API_BASE}/api/managed_funds/managed_fund_full_last_detailed_positions/${FINTUAL_RN_MANAGED_FUND_ID}`;
  const res = await fetch(url, {
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

function fundUnitClpOnOrBefore(compositionDate: string): { day: string; unit_value_clp: number } {
  const resolved = officialRiskyNorrisFundUnitOnOrBefore(compositionDate);
  if (resolved.day === compositionDate) {
    return { day: resolved.day, unit_value_clp: resolved.unit_value_clp };
  }
  const exact = stmtFundUnitOnDate.get(resolved.series_key, compositionDate) as
    | { unit_value_clp: number }
    | undefined;
  if (exact != null && Number.isFinite(exact.unit_value_clp) && exact.unit_value_clp > 0) {
    return { day: compositionDate, unit_value_clp: exact.unit_value_clp };
  }
  return { day: resolved.day, unit_value_clp: resolved.unit_value_clp };
}

function fxClpOnOrBefore(ymd: string): number {
  const row = stmtFxOnOrBefore.get(ymd) as { clp_per_usd: number } | undefined;
  if (row == null || !Number.isFinite(row.clp_per_usd) || row.clp_per_usd <= 0) {
    throw new Error(`Risky Norris composition sync: no fx_daily on or before ${ymd}`);
  }
  return row.clp_per_usd;
}

export type SyncRiskyNorrisCompositionResult = {
  composition_date: string;
  tickers: string[];
  holdings_count: number;
  anchor_fund_unit_clp: number;
  anchor_basket_usd: number;
  raw_etf_weight_sum: number;
};

export async function syncRiskyNorrisComposition(
  cl: ChileWallClock = chileWallClockNow()
): Promise<SyncRiskyNorrisCompositionResult> {
  const api = await fetchRiskyNorrisComposition();
  const compositionDate = api.date;
  const holdings: CompositeHolding[] = api.etf_positions.map((p) => ({
    ticker: p.etf.asset.ticker,
    weight: p.weight,
    synced_at: compositionDate,
  }));
  const tickers = [...new Set(holdings.map((h) => h.ticker))];

  await ensureEquityDailyHistoryForWatchlistTickers(tickers, cl.ymd);

  for (const ticker of tickers) {
    const close = equityCloseUsdEod(ticker, compositionDate);
    if (close == null || !Number.isFinite(close) || close <= 0) {
      throw new Error(
        `Risky Norris composition sync: missing equity_daily for ${ticker} on ${compositionDate}`
      );
    }
  }

  const fundUnit = fundUnitClpOnOrBefore(compositionDate);
  const anchor_basket_usd = basketUsdForHoldings(holdings, compositionDate, { preferLive: false });
  const anchor_fx_clp = fxClpOnOrBefore(compositionDate);
  const last_sync_ymd = cl.ymd;

  let anchor_apv_fund_unit_clp: number | null = null;
  const apvUnit = officialApvFundUnitOnOrBefore(compositionDate);
  if (apvUnit != null) {
    const relDiff = Math.abs(apvUnit.unit_value_clp - fundUnit.unit_value_clp) / fundUnit.unit_value_clp;
    if (relDiff >= APV_PROXY_NEGLIGIBLE_REL_DIFF) {
      anchor_apv_fund_unit_clp = apvUnit.unit_value_clp;
    }
  }

  db.transaction(() => {
    stmtUpsertMeta.run(
      RISKY_NORRIS_PROXY_BUCKET,
      FINTUAL_RN_MANAGED_FUND_ID,
      compositionDate,
      fundUnit.unit_value_clp,
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

  const state = loadGlobalSyncState();
  state.fintualRnCompositionLastSyncYmd = last_sync_ymd;
  saveGlobalSyncState(state);

  return {
    composition_date: compositionDate,
    tickers,
    holdings_count: holdings.length,
    anchor_fund_unit_clp: fundUnit.unit_value_clp,
    anchor_basket_usd,
    raw_etf_weight_sum: api.raw_etf_weight_sum,
  };
}
