import { useMemo } from "react";
import { formatGroupedDecimalTrimmed } from "../format";
import { useTranslation } from "../i18n";
import { useMarketTicker } from "../queries/hooks";
import type { MarketDisplaySeriesRow, MarketTickerResponse } from "../types";

const EQUITY_TICKER_ORDER = ["SPY", "VEA", "OILK", "BTC-USD", "ETH-USD"] as const;

export type TickerMarqueeItem =
  | { kind: "uf"; label: string; value: string }
  | {
      kind: "usd_live";
      label: string;
      value: string;
      delta: number | null;
      fractionDigits: number;
    }
  | {
      kind: "uno_a";
      label: string;
      value: string;
      delta: number | null;
      fractionDigits: number;
    }
  | {
      kind: "risky_norris";
      label: string;
      value: string;
      delta: number | null;
      fractionDigits: number;
    }
  | {
      kind: "equity";
      label: string;
      value: string;
      delta: number | null;
      fractionDigits: number;
    };

function tickerLabel(ticker: string): string {
  if (ticker === "BTC-USD") return "BTC";
  if (ticker === "ETH-USD") return "ETH";
  return ticker;
}

type MarqueeLabels = {
  uf: string;
  usdLive: string;
  unoA: string;
  riskyNorris: string;
};

function seriesLabel(row: MarketDisplaySeriesRow, fallback: MarqueeLabels): string {
  if (row.label_i18n_key === "marketTicker.uf") return fallback.uf;
  if (row.label_i18n_key === "marketTicker.usdLive") return fallback.usdLive;
  if (row.slug === "afp_uno_cuota_a") return fallback.unoA;
  if (row.slug === "fintual_risky_norris") return fallback.riskyNorris;
  return row.label;
}

function buildItemsFromSeriesConfig(
  payload: MarketTickerResponse,
  series: MarketDisplaySeriesRow[],
  labels: MarqueeLabels
): TickerMarqueeItem[] {
  const items: TickerMarqueeItem[] = [];
  for (const row of series) {
    if (row.kind === "uf" && payload.uf != null && Number.isFinite(payload.uf.clp_per_uf)) {
      items.push({
        kind: "uf",
        label: seriesLabel(row, labels),
        value: formatGroupedDecimalTrimmed(payload.uf.clp_per_uf),
      });
      continue;
    }
    if (row.kind === "fx_usd" && payload.usd != null && Number.isFinite(payload.usd.clp_per_usd)) {
      items.push({
        kind: "usd_live",
        label: seriesLabel(row, labels),
        value: formatGroupedDecimalTrimmed(payload.usd.clp_per_usd),
        delta: payload.usd.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (row.kind === "fund_unit" && row.series_key === "afp_uno_cuota_a" && payload.uno_a != null) {
      items.push({
        kind: "uno_a",
        label: seriesLabel(row, labels),
        value: formatGroupedDecimalTrimmed(payload.uno_a.unit_value_clp),
        delta: payload.uno_a.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (row.kind === "fund_unit" && row.series_key === "fintual_risky_norris" && payload.risky_norris != null) {
      items.push({
        kind: "risky_norris",
        label: seriesLabel(row, labels),
        value: formatGroupedDecimalTrimmed(payload.risky_norris.unit_value_clp),
        delta: payload.risky_norris.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (row.kind === "equity" && row.series_key) {
      const eq = payload.equities.find((e) => e.ticker === row.series_key);
      if (eq != null && Number.isFinite(eq.value_usd)) {
        items.push({
          kind: "equity",
          label: tickerLabel(row.series_key),
          value: eq.value_usd.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }),
          delta: eq.delta_pct,
          fractionDigits: 2,
        });
      }
    }
  }
  return items;
}

function buildItemsLegacy(payload: MarketTickerResponse, labels: MarqueeLabels): TickerMarqueeItem[] {
  const items: TickerMarqueeItem[] = [];

  if (payload.uf != null && Number.isFinite(payload.uf.clp_per_uf)) {
    items.push({
      kind: "uf",
      label: labels.uf,
      value: formatGroupedDecimalTrimmed(payload.uf.clp_per_uf),
    });
  }

  if (payload.usd != null && Number.isFinite(payload.usd.clp_per_usd)) {
    items.push({
      kind: "usd_live",
      label: labels.usdLive,
      value: formatGroupedDecimalTrimmed(payload.usd.clp_per_usd),
      delta: payload.usd.delta_pct,
      fractionDigits: 2,
    });
  }

  if (payload.uno_a != null && Number.isFinite(payload.uno_a.unit_value_clp)) {
    items.push({
      kind: "uno_a",
      label: labels.unoA,
      value: formatGroupedDecimalTrimmed(payload.uno_a.unit_value_clp),
      delta: payload.uno_a.delta_pct,
      fractionDigits: 2,
    });
  }

  if (payload.risky_norris != null && Number.isFinite(payload.risky_norris.unit_value_clp)) {
    items.push({
      kind: "risky_norris",
      label: labels.riskyNorris,
      value: formatGroupedDecimalTrimmed(payload.risky_norris.unit_value_clp),
      delta: payload.risky_norris.delta_pct,
      fractionDigits: 2,
    });
  }

  const order = EQUITY_TICKER_ORDER.filter((t) => payload.equities.some((e) => e.ticker === t));
  for (const ticker of order) {
    const row = payload.equities.find((e) => e.ticker === ticker);
    if (row == null || !Number.isFinite(row.value_usd)) continue;
    items.push({
      kind: "equity",
      label: tickerLabel(ticker),
      value: row.value_usd.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      delta: row.delta_pct,
      fractionDigits: 2,
    });
  }

  return items;
}

function buildItems(payload: MarketTickerResponse, labels: MarqueeLabels): TickerMarqueeItem[] {
  const series = payload.marquee_series?.filter((s) => s.show_in_marquee === 1);
  if (series?.length) return buildItemsFromSeriesConfig(payload, series, labels);
  return buildItemsLegacy(payload, labels);
}

export function useMarketTickerMarquee(): { items: TickerMarqueeItem[]; loading: boolean } {
  const { t } = useTranslation();
  const { data: payload, isPending } = useMarketTicker();

  const labels = useMemo(
    () => ({
      uf: t("marketTicker.uf"),
      usdLive: t("marketTicker.usdLive"),
      unoA: t("marketTicker.unoA"),
      riskyNorris: t("marketTicker.riskyNorris"),
    }),
    [t]
  );
  const items = useMemo(
    () => (payload ? buildItems(payload, labels) : []),
    [payload, labels]
  );

  return { items, loading: isPending };
}
