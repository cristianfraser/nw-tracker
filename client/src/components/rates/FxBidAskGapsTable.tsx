import { PageGridTile } from "../layout/PageGridTile";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { formatClp, formatNumberInput, parseNumberInput } from "../../format";
import { useTranslation } from "../../i18n";
import { queryKeys } from "../../queries/keys";
import type { FxBidAskGapRow } from "../../types";
import { loadableClass } from "../ui/Loadable";
import { cn } from "../../cn";
import styles from "./FxBidAskGapsTable.module.css";
import { Button, Input } from "@crfrsr/ui";

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
    const buyInput = parseNumberInput(draft.buy);
    const sellInput = parseNumberInput(draft.sell);
    for (const input of [buyInput, sellInput]) {
      if (!input.ok) {
        setDrafts((prev) => ({
          ...prev,
          [gap.date]: { ...draft, error: input.message },
        }));
        return;
      }
    }
    // An empty field takes the suggested value shown as its placeholder.
    const buy = (buyInput.ok ? buyInput.value : null) ?? gap.suggested_buy;
    const sell = (sellInput.ok ? sellInput.value : null) ?? gap.suggested_sell;
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboardAll() });
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

  if (loadError) {
    return <p className="error">{loadError}</p>;
  }

  // Loading keeps the frame (heading + header, rows once there are some) dimmed; the empty copy is
  // for a gap list that loaded empty.
  if (!loading && gaps.length === 0) {
    return <p className="muted">{t("rates.fx.gapsEmpty")}</p>;
  }

  return (
    <PageGridTile id="fx-gaps" className={loadableClass(loading, "rates-bid-ask-gaps")}>
      <h2>{t("rates.fx.gapsTitle")}</h2>
      <div className={styles.list}>
        <div className={cn(styles.row, styles.header)}>
          <span className={styles.date}>{t("rates.recentColDate")}</span>
          <span className={cn("mono", styles.mid)}>{t("rates.fx.gapsColMid")}</span>
          <span className={cn("mono", styles.buy)}>{t("rates.fx.buy")}</span>
          <span className={cn("mono", styles.sell)}>{t("rates.fx.sell")}</span>
          <span className={styles.source}>{t("rates.fx.gapsColSource")}</span>
        </div>
        <div role="list">
          {gaps.map((gap) => {
            const draft = drafts[gap.date] ?? emptyDraft();
            return (
              <div key={gap.date} role="listitem" className={styles.row}>
                <span className={cn("mono", styles.date)}>{gap.date}</span>
                <span className={cn("mono", styles.mid)}>
                  {gap.mid_clp_per_usd != null ? formatClp(gap.mid_clp_per_usd) : "—"}
                </span>
                <span className={styles.buy}>
                  <Input
                    type="text"
                    inputMode="decimal"
                    aria-label={t("rates.fx.buy")}
                    value={draft.buy}
                    placeholder={
                      gap.suggested_buy != null
                        ? formatNumberInput(Math.round(gap.suggested_buy * 100) / 100)
                        : ""
                    }
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [gap.date]: { ...draft, buy: e.target.value, error: null },
                      }))
                    }
                  />
                </span>
                <span className={styles.sell}>
                  <Input
                    type="text"
                    inputMode="decimal"
                    aria-label={t("rates.fx.sell")}
                    value={draft.sell}
                    placeholder={
                      gap.suggested_sell != null
                        ? formatNumberInput(Math.round(gap.suggested_sell * 100) / 100)
                        : ""
                    }
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [gap.date]: { ...draft, sell: e.target.value, error: null },
                      }))
                    }
                  />
                </span>
                <span className={cn("muted", styles.source)}>
                  {gap.source ?? "—"}
                  {gap.buy_clp_per_usd != null && gap.sell_clp_per_usd != null ? (
                    <span className={cn("mono muted", styles.sourceRates)}>
                      {formatClp(gap.buy_clp_per_usd)} / {formatClp(gap.sell_clp_per_usd)}
                    </span>
                  ) : null}
                </span>
                <span className={styles.save}>
                  <Button disabled={draft.saving} onClick={() => void saveRow(gap)}>
                    {draft.saving ? t("common.saving") : t("common.save")}
                  </Button>
                </span>
                {draft.error ? (
                  <span className={cn("error", styles.error)}>{draft.error}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </PageGridTile>
  );
}
