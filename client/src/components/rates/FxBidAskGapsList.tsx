import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@crfrsr/ui";
import { api } from "../../api";
import { cn } from "../../cn";
import { formatGroupedDecimal, formatNumberInput, parseNumberInput } from "../../format";
import { formatPesosPerDollar } from "../../formatNative";
import { useTranslation } from "../../i18n";
import { useFxBidAskGaps } from "../../queries/hooks";
import { queryLoadError, queryShowsLoading } from "../../queries/pageShapeReady";
import { invalidateResources, resources } from "../../queries/resources";
import type { FxBidAskGapRow, FxBidAskGapYear } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows } from "../ui/OpenRows";
import styles from "./Rates.module.css";

/**
 * How many of a year's days show before «Show more». A year's open edit and its shown count
 * live with its opened rows: folding the year drops them.
 */
const DAYS_STEP = 25;

type Draft = { date: string; buy: string; sell: string };

/** The stored buy / sell row's source as copy: the known provenance id is worded, any other prints as stored. */
function gapSourceLabel(t: (key: string) => string, source: string | null): string | null {
  if (source == null) return null;
  if (source === "mid_spread_inferred") return t("rates.fx.gapsSourceMidInferred");
  return source;
}

/** A day's line beside its date: the mid rate, where its buy / sell rate comes from and the two rates. */
function gapFirstLine(t: (key: string) => string, gap: FxBidAskGapRow): string {
  const mid =
    gap.mid_clp_per_usd != null ? `${t("rates.fx.gapsColMid")} ${formatPesosPerDollar(gap.mid_clp_per_usd)}` : null;
  const source = gapSourceLabel(t, gap.source);
  const rates =
    gap.buy_clp_per_usd != null && gap.sell_clp_per_usd != null
      ? `${formatPesosPerDollar(gap.buy_clp_per_usd)} / ${formatPesosPerDollar(gap.sell_clp_per_usd)}`
      : null;
  return [mid, source, rates].filter((x): x is string => x != null).join(" · ");
}

function YearDays({ year }: { year: FxBidAskGapYear }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(DAYS_STEP);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (gap: FxBidAskGapRow, d: Draft) => {
    const buyInput = parseNumberInput(d.buy);
    const sellInput = parseNumberInput(d.sell);
    for (const input of [buyInput, sellInput]) {
      if (!input.ok) {
        setError(input.message);
        return;
      }
    }
    // An empty field takes the suggested value shown as its placeholder.
    const buy = (buyInput.ok ? buyInput.value : null) ?? gap.suggested_buy;
    const sell = (sellInput.ok ? sellInput.value : null) ?? gap.suggested_sell;
    if (buy == null || sell == null || !Number.isFinite(buy) || !Number.isFinite(sell) || buy <= 0 || sell <= 0) {
      setError(t("rates.fx.gapsInvalidValues"));
      return;
    }
    if (buy < sell) {
      setError(t("rates.fx.gapsBuySellOrder"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.upsertFxBidAsk(gap.date, buy, sell);
      setDraft(null);
      // Not awaited: the list unlocks once the rate is stored, not after the page's series refetch.
      void invalidateResources(queryClient, resources.ratesPage(), resources.dashboard());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const rows = year.rows.slice(0, shown);
  const hidden = year.rows.length - rows.length;
  const placeholder = (n: number | null) => (n != null ? formatNumberInput(Math.round(n * 100) / 100) : "");

  return (
    <div className={styles.gapDays}>
      <OpenRows>
        {rows.map((gap) =>
          draft?.date === gap.date ? (
            <OpenRow
              key={gap.date}
              title={
                <span className={styles.gapFields}>
                  <span className={styles.gapDate}>{gap.date}</span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    aria-label={t("rates.fx.buy")}
                    value={draft.buy}
                    placeholder={placeholder(gap.suggested_buy)}
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, buy: e.target.value })}
                  />
                  <Input
                    type="text"
                    inputMode="decimal"
                    aria-label={t("rates.fx.sell")}
                    value={draft.sell}
                    placeholder={placeholder(gap.suggested_sell)}
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, sell: e.target.value })}
                  />
                  {error ? (
                    <span className={cn("error", styles.gapError)} role="alert">
                      {error}
                    </span>
                  ) : null}
                </span>
              }
              action={
                <>
                  <Button variant="secondary" size="sm" disabled={saving} onClick={() => void save(gap, draft)}>
                    {saving ? t("common.saving") : t("common.save")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setDraft(null);
                      setError(null);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </>
              }
            />
          ) : (
            <OpenRow
              key={gap.date}
              title={<span className={styles.gapDate}>{gap.date}</span>}
              first={gapFirstLine(t, gap)}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving || draft != null}
                  aria-label={t("rates.fx.gapsEditDay", { date: gap.date })}
                  onClick={() => {
                    setDraft({ date: gap.date, buy: "", sell: "" });
                    setError(null);
                  }}
                >
                  {t("rates.fx.gapsEdit")}
                </Button>
              }
            />
          )
        )}
      </OpenRows>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className={styles.gapMore} onClick={() => setShown((n) => n + DAYS_STEP)}>
          {t("table.showMoreRows", { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * «Buy / sell rates to review»: the days whose USD/CLP buy / sell rate is an estimate, as the
 * server groups them — a row per year with its count, opening into its days; «Edit» turns a
 * day's line into the two fields (an empty one takes the estimate shown in it).
 */
export function FxBidAskGapsList() {
  const { t } = useTranslation();
  const query = useFxBidAskGaps();
  const loading = queryShowsLoading(query);
  const loadError = queryLoadError(query);
  const years = query.data?.years ?? [];
  const count = query.data?.count ?? 0;

  return (
    <PageGridTile id="fx-gaps" className={loadableClass(loading)}>
      <h2>
        {t("rates.fx.gapsTitle")}
        {count > 0 ? (
          <span className={styles.gapCount}>
            {" · "}
            {t(count === 1 ? "rates.fx.gapsDaysOne" : "rates.fx.gapsDays", { count: formatGroupedDecimal(count, 0) })}
          </span>
        ) : null}
      </h2>
      {loadError ? (
        <p className="error">{loadError instanceof Error ? loadError.message : String(loadError)}</p>
      ) : (
        <OpenRows loading={loading} empty={!loading && years.length === 0 ? t("rates.fx.gapsEmpty") : undefined}>
          {years.map((year) => (
            <OpenRow
              key={year.year}
              title={<span className={styles.gapDate}>{year.year}</span>}
              titleStrong
              status={t(year.count === 1 ? "rates.fx.gapsDaysOne" : "rates.fx.gapsDays", {
                count: formatGroupedDecimal(year.count, 0),
              })}
              first={year.first_date === year.last_date ? year.last_date : `${year.first_date} → ${year.last_date}`}
            >
              <YearDays year={year} />
            </OpenRow>
          ))}
        </OpenRows>
      )}
    </PageGridTile>
  );
}
