import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useTranslation } from "../i18n";
import type { FxLatest, MarketSeriesPoint, UfLatest } from "../types";

const EQUITY_TICKER_ORDER = ["SPY", "VEA", "BTC-USD", "ETH-USD"] as const;

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

function latestPoint(points: MarketSeriesPoint[]): MarketSeriesPoint | null {
  return points.length > 0 ? points[points.length - 1]! : null;
}

/** Last point whose `read(p)` differs from the series tail (skips forward-filled duplicate days). */
function priorDistinctValue(
  points: MarketSeriesPoint[],
  read: (p: MarketSeriesPoint) => number | null | undefined
): number | null {
  if (points.length < 2) return null;
  const latestVal = read(points[points.length - 1]!);
  if (latestVal == null || !Number.isFinite(latestVal)) return null;
  for (let i = points.length - 2; i >= 0; i--) {
    const v = read(points[i]!);
    if (v != null && Number.isFinite(v) && Math.abs(v - latestVal) > 1e-6) {
      return v;
    }
  }
  return null;
}

type MarqueeLabels = {
  uf: string;
  usdLive: string;
};

function buildItems(
  uf: UfLatest | null,
  fx: FxLatest | null,
  series: MarketSeriesPoint[],
  equityTickers: string[],
  labels: MarqueeLabels
): TickerMarqueeItem[] {
  const items: TickerMarqueeItem[] = [];
  const latest = latestPoint(series);

  const ufVal = uf?.clp_per_uf ?? latest?.clp_per_uf ?? null;
  if (ufVal != null && Number.isFinite(ufVal)) {
    items.push({
      kind: "uf",
      label: labels.uf,
      value: Math.round(ufVal).toLocaleString("es-CL"),
    });
  }

  const usdLive = fx?.clp_per_usd ?? latest?.clp_per_usd ?? null;
  if (usdLive != null && Number.isFinite(usdLive)) {
    const usdPrior = priorDistinctValue(series, (p) => p.clp_per_usd);
    const delta =
      usdPrior != null && Number.isFinite(usdPrior) ? Math.round(usdLive - usdPrior) : null;
    items.push({
      kind: "usd_live",
      label: labels.usdLive,
      value: Math.round(usdLive).toLocaleString("es-CL"),
      delta,
      fractionDigits: 0,
    });
  }

  const ordered = EQUITY_TICKER_ORDER.filter((t) => equityTickers.includes(t));
  for (const ticker of ordered) {
    const live = latest?.equity_usd[ticker] ?? null;
    if (live == null || !Number.isFinite(live)) continue;
    const prior = priorDistinctValue(series, (p) => p.equity_usd[ticker]);
    const delta = prior != null && Number.isFinite(prior) ? live - prior : null;
    items.push({
      kind: "equity",
      label: tickerLabel(ticker),
      value: live.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      delta,
      fractionDigits: 2,
    });
  }

  return items;
}

const REFRESH_MS = 60_000;

export function useMarketTickerMarquee(): { items: TickerMarqueeItem[]; loading: boolean } {
  const { t } = useTranslation();
  const [uf, setUf] = useState<UfLatest | null>(null);
  const [fx, setFx] = useState<FxLatest | null>(null);
  const [points, setPoints] = useState<MarketSeriesPoint[]>([]);
  const [equityTickers, setEquityTickers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [ufRow, fxRow, series] = await Promise.all([
          api.ufLatest(),
          api.fxLatest(),
          api.marketSeries(),
        ]);
        if (cancelled) return;
        setUf(ufRow);
        setFx(fxRow);
        setPoints(series.points);
        setEquityTickers(series.equity_tickers);
      } catch {
        if (!cancelled) {
          setUf(null);
          setFx(null);
          setPoints([]);
          setEquityTickers([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const labels = useMemo(
    () => ({
      uf: t("marketTicker.uf"),
      usdLive: t("marketTicker.usdLive"),
    }),
    [t]
  );
  const items = useMemo(
    () => buildItems(uf, fx, points, equityTickers, labels),
    [uf, fx, points, equityTickers, labels]
  );

  return { items, loading };
}
