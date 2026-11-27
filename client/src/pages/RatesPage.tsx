import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PageGridTile } from "../components/layout/PageGridTile";
import { FxBidAskGapsList } from "../components/rates/FxBidAskGapsList";
import { RatesChartTile, type RatesChartLine } from "../components/rates/RatesChartTile";
import { RatesCoverageNotices } from "../components/rates/RatesCoverageNotices";
import { RatesGlanceTable } from "../components/rates/RatesGlanceTable";
import { pendingGlanceRow, RATES_CURRENCY_SERIES, ratesRowLabel } from "../components/rates/ratesSeries";
import styles from "../components/rates/Rates.module.css";
import { formatMarketValue } from "../components/watchlist/heatGrid";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { DASHBOARD_PATH } from "../dashboardPath";
import { useTranslation } from "../i18n";
import { useHeldMarketSeries, useHeldRatesGlance, useSyncStatus } from "../queries/hooks";
import { useSurfaceTab } from "../surfaceDisplayPrefs";
import type { MarketSeriesPoint, MarketSeriesResponse, RatesGlanceRow, RatesRecentEntry } from "../types";

const RATES_VIEWS = ["currencies", "instruments"] as const;
type RatesView = (typeof RATES_VIEWS)[number];

const VIEW_LABEL_KEYS: Record<RatesView, string> = {
  currencies: "rates.tabFx",
  instruments: "rates.tabTickers",
};

/** What one unit of a «Currencies» series is, under its title. */
const CURRENCY_NOTE_KEYS: Record<string, string> = {
  usd_clp: "rates.fx.clpPerUsd",
  uf_clp: "rates.fx.clpPerUf",
  eur_clp: "rates.fx.clpPerEur",
  eur_usd: "rates.fx.usdPerEur",
  ipc: "rates.fx.ipcFootnote",
};

/** The sync sources whose staleness the page warns about: the rates' own. */
const RATE_SYNC_SOURCES = ["yahoo_fx_usd", "sbif_usd", "sbif_eur", "fx_pairs"];

const NO_POINTS: readonly { date: string; value: number }[] = [];
const NO_RECENT: readonly RatesRecentEntry[] = [];

function pointsOf(
  points: readonly MarketSeriesPoint[],
  pick: (p: MarketSeriesPoint) => number | null | undefined
): { date: string; value: number }[] {
  const rows: { date: string; value: number }[] = [];
  for (const p of points) {
    const v = pick(p);
    if (v != null && Number.isFinite(v)) rows.push({ date: p.as_of_date, value: v });
  }
  return rows;
}

/** The lines of a «Currencies» tile, from the series payload's own arrays. */
function currencyLines(
  id: string,
  payload: MarketSeriesResponse | undefined,
  name: string,
  t: (key: string) => string
): RatesChartLine[] {
  const main = (points: readonly { date: string; value: number }[]): RatesChartLine[] => [
    { dataKey: "value", name, stroke: "var(--accent)", points },
  ];
  if (!payload) return main(NO_POINTS);
  switch (id) {
    case "usd_clp":
      return [
        { dataKey: "value", name: t("rates.fx.yahoo"), stroke: "var(--accent)", points: payload.fx_usd_clp },
        {
          dataKey: "observado",
          name: t("rates.fx.bcentralObservado"),
          stroke: "var(--muted)",
          strokeWidth: 1.5,
          strokeDasharray: "4 3",
          points: payload.fx_usd_clp_bcentral,
        },
        {
          dataKey: "buy",
          name: t("rates.fx.buy"),
          stroke: "var(--positive)",
          strokeWidth: 1,
          dot: { r: 2 },
          sparse: true,
          points: payload.fx_usd_clp_buy ?? NO_POINTS,
        },
        {
          dataKey: "sell",
          name: t("rates.fx.sell"),
          stroke: "var(--series-orange, #f97316)",
          strokeWidth: 1,
          dot: { r: 2 },
          sparse: true,
          points: payload.fx_usd_clp_sell ?? NO_POINTS,
        },
      ];
    case "uf_clp":
      return main(pointsOf(payload.points, (p) => p.clp_per_uf));
    case "eur_clp":
      return main(payload.eur_clp);
    case "eur_usd":
      return main(payload.eur_usd);
    case "ipc":
      return main(pointsOf(payload.points, (p) => p.ipc_index));
    default:
      throw new Error(`rates: no chart for series ${id}`);
  }
}

function instrumentLines(row: Pick<RatesGlanceRow, "kind" | "series_key">, payload: MarketSeriesResponse | undefined, name: string): RatesChartLine[] {
  const key = row.series_key;
  const points =
    payload && key != null
      ? pointsOf(payload.points, (p) => (row.kind === "equity" ? p.equity[key] : p.fund_unit[key]))
      : NO_POINTS;
  return [{ dataKey: "value", name, stroke: "var(--accent)", points }];
}

/** One series' tile: its lines are built once per payload, not on each glance refetch. */
function RatesSeriesTile({
  row,
  isCurrency,
  payload,
  fallbackUnit,
  loading,
}: {
  row: RatesGlanceRow;
  isCurrency: boolean;
  payload: MarketSeriesResponse | undefined;
  /** The display unit, for an instrument tile drawn before any series payload. */
  fallbackUnit: string;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const name = ratesRowLabel(row, t);
  const { id, kind, series_key: seriesKey } = row;
  const lines = useMemo(
    () =>
      isCurrency
        ? currencyLines(id, payload, name, t)
        : instrumentLines({ kind, series_key: seriesKey }, payload, name),
    [isCurrency, id, kind, seriesKey, payload, name, t]
  );
  // An instrument's values are in the series payload's unit (a held one keeps its own).
  const valueCurrency = isCurrency ? row.value_currency : (payload?.unit ?? fallbackUnit);
  const noteKey = CURRENCY_NOTE_KEYS[id];
  if (isCurrency && noteKey == null) throw new Error(`rates: series ${id} has no note`);
  return (
    <RatesChartTile
      surfaceId={`rates.${id}`}
      title={name}
      note={noteKey != null ? t(noteKey) : t("rates.instrumentNote", { unit: valueCurrency.toUpperCase() })}
      lines={lines}
      showLegend={isCurrency}
      valueCurrency={valueCurrency}
      formatValue={(n) => formatMarketValue({ kind, value: n, value_currency: valueCurrency })}
      recent={payload?.recent[id] ?? NO_RECENT}
      loading={loading}
    />
  );
}

/**
 * `/rates`: a glance of today's rates on the watchlist's heat grid, then one chart tile per
 * series (the position page's tile: its own Rango, the plot, the latest stored entries), in two
 * views — the currencies (USD/CLP, UF, EUR/CLP, EUR/USD, IPC) and the instruments the server
 * lists for the page. The coverage problems sit above as rows that open in place, and the
 * buy / sell rates to review close the currencies view, folded by year.
 */
export function RatesPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { tab: view, setTab: setView } = useSurfaceTab<RatesView>("rates.view", RATES_VIEWS);

  const seriesQuery = useHeldMarketSeries(displayUnit);
  const payload = seriesQuery.data;
  // Dim while there is no payload yet or the previous unit's is held.
  const seriesPending = seriesQuery.loading;
  const glanceQuery = useHeldRatesGlance(displayUnit);
  const glance = glanceQuery.data;
  const glancePending = glanceQuery.loading;
  const { data: syncStatus } = useSyncStatus();
  // Each payload's error shows in its own section: the charts stay when only the glance fails.
  const seriesError = seriesQuery.error;
  const glanceError = glanceQuery.error;

  const currencyRows = useMemo(() => {
    // Before the glance answers, the five series are valueless rows; once it has, it lists them all.
    if (!glance) return RATES_CURRENCY_SERIES.map(pendingGlanceRow);
    const byId = new Map(glance.currencies.map((r) => [r.id, r]));
    return RATES_CURRENCY_SERIES.map((s) => {
      const row = byId.get(s.id);
      if (!row) throw new Error(`rates: the glance lists no ${s.id} row`);
      return row;
    });
  }, [glance]);
  const instrumentRows = glance?.instruments ?? [];
  const syncStale = (syncStatus?.stale ?? []).some((id) => RATE_SYNC_SOURCES.includes(id));

  const errorText = (e: unknown) => (e instanceof Error ? e.message : t("common.loadFailed"));

  const rows = view === "currencies" ? currencyRows : instrumentRows;

  return (
    <main>
      <p className="muted">
        <Link to={DASHBOARD_PATH}>{t("common.backToDashboard")}</Link>
      </p>
      <h1>{t("rates.pageTitle")}</h1>
      <RatesCoverageNotices
        notices={payload?.coverage_notices ?? []}
        syncStale={syncStale}
        loading={payload != null && seriesPending}
      />

      <div className={styles.viewRow}>
        <div className="surface-controls">
          <span className="surface-controls__set" role="group" aria-label={t("rates.subnavAria")}>
            {RATES_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className={v === view ? "is-on" : undefined}
                aria-pressed={v === view}
                onClick={() => setView(v)}
              >
                {t(VIEW_LABEL_KEYS[v])}
              </button>
            ))}
          </span>
        </div>
      </div>

      <PageGridTile id="rates-glance">
        <h2 className="visually-hidden">{t("rates.glance.title")}</h2>
        {glanceError ? (
          <p className="error">{errorText(glanceError)}</p>
        ) : view === "instruments" && !glancePending && instrumentRows.length === 0 ? (
          <p className="muted">{t("rates.instrumentsEmpty")}</p>
        ) : (
          <RatesGlanceTable
            rows={rows}
            nameLabel={t(view === "currencies" ? "rates.glance.colPair" : "rates.glance.colInstrument")}
            loading={glancePending}
          />
        )}
      </PageGridTile>

      {seriesError ? (
        <p className="error">{errorText(seriesError)}</p>
      ) : rows.length > 0 ? (
        <div className="chart-grid">
          {rows.map((row) => (
            <RatesSeriesTile
              key={row.id}
              row={row}
              isCurrency={view === "currencies"}
              payload={payload}
              fallbackUnit={displayUnit}
              loading={seriesPending}
            />
          ))}
        </div>
      ) : null}

      {view === "currencies" ? <FxBidAskGapsList /> : null}
    </main>
  );
}
