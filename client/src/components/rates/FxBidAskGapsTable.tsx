import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { formatClp, formatNumberInput, parseNumberInput } from "../../format";
import { useTranslation } from "../../i18n";
import { queryKeys } from "../../queries/keys";
import type { FxBidAskGapRow } from "../../types";
import { Table } from "../ui/Table";
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
                <Input
                  type="text"
                  inputMode="decimal"
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
              </td>
              <td style={{ textAlign: "right" }}>
                <Input
                  type="text"
                  inputMode="decimal"
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
                <Button disabled={draft.saving} onClick={() => void saveRow(gap)}>
                  {draft.saving ? t("common.saving") : t("common.save")}
                </Button>
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
