import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  latestFundUnitRowOnOrBefore,
  priorAfpUnoFundUnitRowBeforeForDisplay,
} from "./afpUnoValuation.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { equitySessionYmdForTicker, resolveEquityQuote } from "./equityQuote.js";
import { fxForLiveMtm, fxRowOnOrBefore } from "./fxRates.js";
import { listDistinctEquityTickersForSync } from "./accountEquityTicker.js";

export type MarketDisplaySeriesRow = {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "uf";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
};

const stmtAll = db.prepare(
  `SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key,
          show_in_marquee, show_in_rates, rates_chart_title
   FROM market_display_series
   ORDER BY sort_order, id`
);

export function listMarketDisplaySeries(): MarketDisplaySeriesRow[] {
  return stmtAll.all() as MarketDisplaySeriesRow[];
}

export function listMarqueeSeries(): MarketDisplaySeriesRow[] {
  return (stmtAll.all() as MarketDisplaySeriesRow[]).filter((r) => r.show_in_marquee === 1);
}

export function listRatesInstrumentSeries(): MarketDisplaySeriesRow[] {
  return (stmtAll.all() as MarketDisplaySeriesRow[]).filter((r) => r.show_in_rates === 1);
}

const stmtFundUnitPriorTo = db.prepare(
  `SELECT day, unit_value_clp FROM fund_unit_daily
   WHERE series_key = ? AND day < ? ORDER BY day DESC LIMIT 1`
);

const stmtUfOnOrBefore = db.prepare(
  `SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);
const stmtFxPriorTo = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date < ? ORDER BY date DESC LIMIT 1`
);

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

export type MarketTickerEquityRow = {
  ticker: string;
  trade_date: string;
  value_usd: number;
  delta_pct: number | null;
  source: "live" | "eod";
};

const CRYPTO_MARQUEE_TICKERS = ["BTC-USD", "ETH-USD"] as const;

/** Yahoo live/EOD symbols for the marquee: DB config + built-in/panel NYSE + crypto. */
export function equityTickersForMarqueeQuotes(marqueeSeries: MarketDisplaySeriesRow[]): string[] {
  const fromConfig = marqueeSeries
    .filter((r) => r.kind === "equity" && r.series_key?.trim())
    .map((r) => r.series_key!.trim().toUpperCase());
  const fromAccounts = listDistinctEquityTickersForSync();
  return [...new Set([...fromConfig, ...fromAccounts, ...CRYPTO_MARQUEE_TICKERS])];
}

export type MarketTickerPayload = {
  chile_today: string;
  uf: { date: string; clp_per_uf: number } | null;
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  risky_norris: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  equities: MarketTickerEquityRow[];
  /** Series config used to build this payload (marquee labels / order). */
  marquee_series: MarketDisplaySeriesRow[];
};

/**
 * Marquee snapshot driven by `market_display_series` rows with `show_in_marquee = 1`.
 */
export function getMarketTickerPayloadFromDb(): MarketTickerPayload {
  const today = chileCalendarTodayYmd();
  const now = new Date();
  const marquee_series = listMarqueeSeries();

  let uf: MarketTickerPayload["uf"] = null;
  let usd: MarketTickerPayload["usd"] = null;
  let uno_a: MarketTickerPayload["uno_a"] = null;
  let risky_norris: MarketTickerPayload["risky_norris"] = null;
  const equities: MarketTickerEquityRow[] = [];

  for (const row of marquee_series) {
    if (row.kind === "uf") {
      const ufRow = stmtUfOnOrBefore.get(today) as { date: string; clp_per_uf: number } | undefined;
      if (ufRow != null && Number.isFinite(ufRow.clp_per_uf) && ufRow.clp_per_uf > 0) {
        uf = { date: ufRow.date, clp_per_uf: ufRow.clp_per_uf };
      }
      continue;
    }
    if (row.kind === "fx_usd") {
      const fxRow = fxForLiveMtm(today, now) ?? fxRowOnOrBefore(today);
      if (fxRow != null && Number.isFinite(fxRow.clp_per_usd) && fxRow.clp_per_usd > 0) {
        const fxStale = fxRow.date < today;
        const prior = fxStale
          ? null
          : (stmtFxPriorTo.get(fxRow.date) as { clp_per_usd: number } | undefined)?.clp_per_usd;
        usd = {
          date: fxRow.date,
          clp_per_usd: fxRow.clp_per_usd,
          delta_pct: fxStale ? 0 : percentChange(fxRow.clp_per_usd, prior),
        };
      }
      continue;
    }
    if (row.kind === "fund_unit" && row.series_key) {
      if (row.series_key === AFP_UNO_CUOTA_SERIES_KEY || row.slug === "afp_uno_cuota_a") {
        const fuRow = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(AFP_UNO_CUOTA_SERIES_KEY, today);
        if (fuRow != null && Number.isFinite(fuRow.unit_value_clp) && fuRow.unit_value_clp > 0) {
          const stale = fuRow.day < today;
          const prior = stale
            ? null
            : priorAfpUnoFundUnitRowBeforeForDisplay(AFP_UNO_CUOTA_SERIES_KEY, fuRow.day);
          uno_a = {
            day: fuRow.day,
            unit_value_clp: fuRow.unit_value_clp,
            delta_pct: stale ? 0 : percentChange(fuRow.unit_value_clp, prior?.unit_value_clp),
          };
        }
        continue;
      }
      if (
        row.series_key === "fintual_risky_norris" ||
        row.series_key === "fintual_cert_risky_norris"
      ) {
        const riskySeries = row.series_key;
        const rnRow = latestFundUnitRowOnOrBefore(riskySeries, today);
        if (rnRow != null && Number.isFinite(rnRow.unit_value_clp) && rnRow.unit_value_clp > 0) {
          const stale = rnRow.day < today;
          const prior = stale
            ? null
            : (
                stmtFundUnitPriorTo.get(riskySeries, rnRow.day) as
                  | { unit_value_clp: number }
                  | undefined
              )?.unit_value_clp;
          risky_norris = {
            day: rnRow.day,
            unit_value_clp: rnRow.unit_value_clp,
            delta_pct: stale ? 0 : percentChange(rnRow.unit_value_clp, prior),
          };
        }
        continue;
      }
    }
  }

  for (const ticker of equityTickersForMarqueeQuotes(marquee_series)) {
    const sessionYmd = equitySessionYmdForTicker(ticker, now);
    const q = resolveEquityQuote(ticker, sessionYmd, { preferLive: true, now });
    if (q == null || !Number.isFinite(q.price_usd) || q.price_usd <= 0) continue;
    equities.push({
      ticker,
      trade_date: q.trade_date,
      value_usd: q.price_usd,
      delta_pct: q.delta_pct,
      source: q.source,
    });
  }

  return {
    chile_today: today,
    uf,
    usd,
    uno_a,
    risky_norris,
    equities,
    marquee_series,
  };
}
