import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { formatClp } from "../../format";
import { useTranslation } from "../../i18n";
import { queryKeys } from "../../queries/keys";
import type { FxBidAskGapRow } from "../../types";
import { Table } from "../ui/Table";

type RowDraft = {
  buy: string;
  sell: string;
  saving: boolean;
  error: string | null;
};

function emptyDraft(): RowDraft {
  return { buy: "", sell: "", saving: false, error: null };
}

export function FxBidAskGapsTable() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [gaps, setGaps] = useState<FxBidAskGapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.fxBidAskGaps();
      setGaps(res.gaps);
      const next: Record<string, RowDraft> = {};
      for (const gap of res.gaps) {
        next[gap.date] = emptyDraft();
      }
      setDrafts(next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveRow = async (gap: FxBidAskGapRow) => {
    const draft = drafts[gap.date];
    if (!draft) return;
    const buyRaw = draft.buy.trim();
    const sellRaw = draft.sell.trim();
    const buy = buyRaw ? Number(buyRaw) : gap.suggested_buy;
    const sell = sellRaw ? Number(sellRaw) : gap.suggested_sell;
    if (
      buy == null ||
      sell == null ||
      !Number.isFinite(buy) ||
      !Number.isFinite(sell) ||
      buy <= 0 ||
      sell <= 0
    ) {
      setDrafts((prev) => ({
        ...prev,
        [gap.date]: { ...draft, error: t("rates.fx.gapsInvalidValues") },
      }));
      return;
    }
    if (buy < sell) {
      setDrafts((prev) => ({
        ...prev,
        [gap.date]: { ...draft, error: t("rates.fx.gapsBuySellOrder") },
      }));
      return;
    }
    setDrafts((prev) => ({
      ...prev,
      [gap.date]: { ...draft, saving: true, error: null },
    }));
    try {
      await api.upsertFxBidAsk(gap.date, buy, sell);
      await reload();
      void queryClient.invalidateQueries({ queryKey: queryKeys.marketSeries() });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (e) {
      setDrafts((prev) => ({
        ...prev,
        [gap.date]: {
          ...draft,
          saving: false,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  if (loading) {
    return <p className="muted">{t("common.loading")}</p>;
  }

  if (loadError) {
    return <p className="error">{loadError}</p>;
  }

  if (gaps.length === 0) {
    return <p className="muted">{t("rates.fx.gapsEmpty")}</p>;
  }

  return (
    <section className="rates-bid-ask-gaps" style={{ marginTop: "1.5rem", maxWidth: "58rem" }}>
      <h2 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>{t("rates.fx.gapsTitle")}</h2>
      <p className="muted" style={{ marginBottom: "0.75rem", lineHeight: 1.45, fontSize: "0.92rem" }}>
        {t("rates.fx.gapsHint")}
      </p>
      <Table
        header={
          <thead>
            <tr>
              <th>{t("rates.recentColDate")}</th>
              <th className="mono" style={{ textAlign: "right" }}>
                {t("rates.fx.gapsColMid")}
              </th>
              <th className="mono" style={{ textAlign: "right" }}>
                {t("rates.fx.buy")}
              </th>
              <th className="mono" style={{ textAlign: "right" }}>
                {t("rates.fx.sell")}
              </th>
              <th>{t("rates.fx.gapsColSource")}</th>
              <th />
            </tr>
          </thead>
        }
      >
        {gaps.map((gap) => {
          const draft = drafts[gap.date] ?? emptyDraft();
          return (
            <tr key={gap.date}>
              <td className="mono">{gap.date}</td>
              <td className="mono" style={{ textAlign: "right" }}>
                {gap.mid_clp_per_usd != null ? formatClp(gap.mid_clp_per_usd) : "—"}
              </td>
              <td style={{ textAlign: "right" }}>
                <input
                  className="mono"
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.buy}
                  placeholder={
                    gap.suggested_buy != null ? String(Math.round(gap.suggested_buy * 100) / 100) : ""
                  }
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [gap.date]: { ...draft, buy: e.target.value, error: null },
                    }))
                  }
                  style={{ width: "6.5rem", textAlign: "right" }}
                />
              </td>
              <td style={{ textAlign: "right" }}>
                <input
                  className="mono"
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.sell}
                  placeholder={
                    gap.suggested_sell != null ? String(Math.round(gap.suggested_sell * 100) / 100) : ""
                  }
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [gap.date]: { ...draft, sell: e.target.value, error: null },
                    }))
                  }
                  style={{ width: "6.5rem", textAlign: "right" }}
                />
              </td>
              <td className="muted" style={{ fontSize: "0.85rem" }}>
                {gap.source ?? "—"}
                {gap.buy_clp_per_usd != null && gap.sell_clp_per_usd != null ? (
                  <div className="mono muted" style={{ fontSize: "0.8rem", marginTop: "0.15rem" }}>
                    {formatClp(gap.buy_clp_per_usd)} / {formatClp(gap.sell_clp_per_usd)}
                  </div>
                ) : null}
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <button type="button" disabled={draft.saving} onClick={() => void saveRow(gap)}>
                  {draft.saving ? t("common.saving") : t("common.save")}
                </button>
                {draft.error ? (
                  <div className="error" style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
                    {draft.error}
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
      </Table>
    </section>
  );
}
