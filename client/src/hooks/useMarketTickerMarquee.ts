import { useMemo } from "react";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatGroupedDecimal, formatGroupedDecimalTrimmed } from "../format";
import { useTranslation } from "../i18n";
import { useMarketTicker } from "../queries/hooks";
import type { MarketDisplaySeriesRow, MarketTickerResponse } from "../types";

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
      kind: "risky_norris_proxy";
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

/**
 * The server already expressed the value in the display unit; pesos print grouped with the
 * decimals they have (a cuota, a UF), dollars always with two.
 */
/** An index (`none`) reads as its level with two decimals, like a USD price. */
function formatMarqueeValue(value: number, currency: "usd" | "clp" | "none"): string {
  return currency === "clp" ? formatGroupedDecimalTrimmed(value) : formatGroupedDecimal(value, 2);
}

type MarqueeLabels = {
  uf: string;
  usdLive: string;
  unoA: string;
  riskyNorris: string;
  riskyNorrisProxy: string;
};

function seriesLabel(row: MarketDisplaySeriesRow, fallback: MarqueeLabels): string {
  if (row.label_i18n_key === "marketTicker.uf") return fallback.uf;
  if (row.label_i18n_key === "marketTicker.usdLive") return fallback.usdLive;
  if (row.slug === "afp_uno_cuota_a") return fallback.unoA;
  if (row.slug === "fintual_risky_norris") return fallback.riskyNorris;
  if (row.slug === "fintual_risky_norris_proxy") return fallback.riskyNorrisProxy;
  return row.label;
}

function buildItemsFromSeriesConfig(
  payload: MarketTickerResponse,
  series: MarketDisplaySeriesRow[],
  labels: MarqueeLabels
): TickerMarqueeItem[] {
  const items: TickerMarqueeItem[] = [];
  for (const row of series) {
    if (row.kind === "uf" && payload.uf != null && Number.isFinite(payload.uf.value)) {
      items.push({
        kind: "uf",
        label: seriesLabel(row, labels),
        value: formatMarqueeValue(payload.uf.value, payload.uf.currency),
      });
      continue;
    }
    if (row.kind === "fx_usd" && payload.usd != null && Number.isFinite(payload.usd.clp_per_usd)) {
      // The rate itself: CLP per USD whatever the display unit.
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
        value: formatMarqueeValue(payload.uno_a.value, payload.uno_a.currency),
        delta: payload.uno_a.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (row.kind === "fund_unit" && row.series_key === "fintual_risky_norris" && payload.risky_norris != null) {
      items.push({
        kind: "risky_norris",
        label: seriesLabel(row, labels),
        value: formatMarqueeValue(payload.risky_norris.value, payload.risky_norris.currency),
        delta: payload.risky_norris.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (
      row.kind === "composite" &&
      row.series_key === "fintual_risky_norris_proxy" &&
      payload.risky_norris_proxy != null
    ) {
      items.push({
        kind: "risky_norris_proxy",
        label: seriesLabel(row, labels),
        value: formatMarqueeValue(payload.risky_norris_proxy.value, payload.risky_norris_proxy.currency),
        delta: payload.risky_norris_proxy.delta_pct,
        fractionDigits: 2,
      });
      continue;
    }
    if (row.kind === "equity" && row.series_key) {
      const eq = payload.equities.find((e) => e.ticker === row.series_key);
      if (eq != null && Number.isFinite(eq.value)) {
        items.push({
          kind: "equity",
          label: tickerLabel(row.series_key),
          value: formatMarqueeValue(eq.value, eq.currency),
          delta: eq.delta_pct,
          fractionDigits: 2,
        });
      }
    }
  }
  return items;
}

function buildItems(payload: MarketTickerResponse, labels: MarqueeLabels): TickerMarqueeItem[] {
  const series = payload.marquee_series?.filter((s) => s.show_in_marquee === 1) ?? [];
  return buildItemsFromSeriesConfig(payload, series, labels);
}

export function useMarketTickerMarquee(): { items: TickerMarqueeItem[]; loading: boolean } {
  const { t } = useTranslation();
  // Items carry pre-formatted strings, so the memo must refresh on separator change; the
  // unit is part of the query key, so a toggle refetches the strip in the other currency.
  const { decimalSeparator, displayUnit } = useDisplayPreferences();
  const { data: payload, isPending } = useMarketTicker(displayUnit);

  const labels = useMemo(
    () => ({
      uf: t("marketTicker.uf"),
      usdLive: t("marketTicker.usdLive"),
      unoA: t("marketTicker.unoA"),
      riskyNorris: t("marketTicker.riskyNorris"),
      riskyNorrisProxy: t("watchlist.riskyNorrisProxy"),
    }),
    [t]
  );
  const items = useMemo(
    () => (payload ? buildItems(payload, labels) : []),
    [payload, labels, decimalSeparator]
  );

  return { items, loading: isPending };
}
