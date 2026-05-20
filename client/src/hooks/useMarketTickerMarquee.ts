import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { formatGroupedDecimalTrimmed } from "../format";
import { useTranslation } from "../i18n";
import type { MarketTickerResponse } from "../types";

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
      kind: "uno_a";
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
};

function buildItems(payload: MarketTickerResponse, labels: MarqueeLabels): TickerMarqueeItem[] {
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

const REFRESH_MS = 60_000;

export function useMarketTickerMarquee(): { items: TickerMarqueeItem[]; loading: boolean } {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<MarketTickerResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await api.marketTicker();
        if (cancelled) return;
        setPayload(data);
      } catch {
        if (!cancelled) setPayload(null);
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
      unoA: t("marketTicker.unoA"),
    }),
    [t]
  );
  const items = useMemo(
    () => (payload ? buildItems(payload, labels) : []),
    [payload, labels]
  );

  return { items, loading };
}
