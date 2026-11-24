import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { PageGridTile } from "../components/layout/PageGridTile";
import { RealEstateExpensesChart } from "../components/charts/RealEstateExpensesChart";
import { RealEstateAddPlaceModal } from "../components/real-estate/RealEstateAddPlaceModal";
import { RealEstatePlaceDfl2Modal } from "../components/real-estate/RealEstatePlaceDfl2Modal";
import { RealEstateAssignPurchaseModal } from "../components/real-estate/RealEstateAssignPurchaseModal";
import { RealEstateExpenseLinkModal } from "../components/real-estate/RealEstateExpenseLinkModal";
import { RealEstateBillMonthList } from "../components/real-estate/RealEstateBillMonthList";
import { loadableClass } from "../components/ui/Loadable";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { monthYearSurfacePeriod } from "../surfaceDisplayPrefs";
import { clipMonthsThenRollup } from "../timeRange";
import { rollupChartPointsByYear } from "../flowsDisplay";
import { formatGroupedDecimal, formatMoney } from "../format";
import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { useTranslation } from "../i18n";
import { useRealEstateExpenses } from "../queries/hooks";
import type { RealEstateBillSlot } from "../types";
import { Button } from "@crfrsr/ui";
import { queryLoadError } from "../queries/pageShapeReady";
import { DEMO_EDITS_LIMITED } from "../demoEdits";

/** Gastos de arriendo / departamento (`/flows/expenses/real_estate`). */
export function RealEstateExpensesPage() {
  const { t } = useTranslation();
  const chartPrefs = useSurfacePrefs("flows.re.chart", "month", "3y");
  const metricsPeriod = chartPrefs.period;
  const timeRange = chartPrefs.range;
  const chartControls = (
    <SurfaceControls
      period={chartPrefs.period}
      onPeriodChange={chartPrefs.setPeriod}
      periodOptions={["month", "year"]}
      range={chartPrefs.range}
      onRangeChange={chartPrefs.setRange}
    />
  );
  // Real estate is billed-period (bill_month) → month/year only; the surface's Período
  // clamps Diario → Mensual here (a per-day billed view has no meaning). Rango still applies.
  const granularity = monthYearSurfacePeriod(metricsPeriod);
  const { accountSlug } = useParams<{ accountSlug?: string }>();
  const [linkSlot, setLinkSlot] = useState<RealEstateBillSlot | null>(null);
  const [assignPlace, setAssignPlace] = useState<{ slug: string; label: string } | null>(null);
  const [addPlaceOpen, setAddPlaceOpen] = useState(false);
  const [dfl2PlaceSlug, setDfl2PlaceSlug] = useState<string | null>(null);
  const { data, error: queryError } = useRealEstateExpenses();
  const error = queryLoadError({ data, error: queryError });
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const places = useMemo(() => data?.places ?? [], [data]);
  const placeLabels = useMemo(() => new Map(places.map((p) => [p.slug, p.label])), [places]);

  // The place page charts that place alone (its own total); the index charts every place.
  const chartScope = data
    ? (data.chart_scopes[accountSlug && data.chart_scopes[accountSlug] ? accountSlug : "all"] ?? null)
    : null;

  const chartPoints = useMemo(() => {
    if (!chartScope) return [];
    // Every series and the total are flows. Months cut at the Rango start — counted back from the
    // scope's last bill, so a place that ended shows its own last years — then rolled up: the
    // yearly chart starts with a partial first year.
    const lastDate = chartScope.points.at(-1)?.as_of_date;
    if (!lastDate) return [];
    const keys = [...chartScope.series.map((s) => s.data_key), "total"];
    return clipMonthsThenRollup(
      chartScope.points,
      granularity,
      timeRange,
      (rows) => rollupChartPointsByYear(rows, keys),
      lastDate
    );
  }, [chartScope, granularity, timeRange]);

  const sections = useMemo(() => {
    if (!data) return [];
    const accounts = places
      .map((p) => data.by_account[p.slug])
      .filter((a) => a != null && a.months.length > 0);
    const filtered = accountSlug
      ? accounts.filter((a) => a.account_slug === accountSlug)
      : accounts;
    if (accountSlug && filtered.length === 0 && data.by_account[accountSlug]) {
      return [data.by_account[accountSlug]!];
    }
    return filtered;
  }, [data, accountSlug, places]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  // The frame renders with a zero total and no place sections until the payload arrives.
  const loading = !data;

  const titleSuffix =
    accountSlug != null && data ? (data.by_account[accountSlug]?.label ?? accountSlug) : null;

  const groupTotal = accountSlug
    ? (data?.by_account[accountSlug]?.total ?? 0)
    : (data?.total ?? 0);
  // Before the payload answers the total reads 0, in the home currency.
  const groupCurrency = data?.currency ?? HOME_CURRENCY;

  return (
    <>
      <h2 className="flow-section-title">
        {t("sidebar.flowsExpensesRealEstate")}
        {titleSuffix ? ` — ${titleSuffix}` : ""}
      </h2>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <RealEstateExpensesChart
          controls={chartControls}
          title={t("expenses.chartTitle")}
          points={chartPoints}
          series={chartScope?.series ?? []}
          kinds={chartScope?.kinds ?? []}
          placeLabels={placeLabels}
          xAxisGranularity={granularity}
          loading={loading}
        />
      </div>

      <PageGridTile id="places" className="page-grid">
        <h3>
          {t("expenses.groups.real_estate")}
          <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
            {formatMoney({ value: groupTotal, currency: groupCurrency })}
          </span>
          {!accountSlug ? (
            <Button
              onClick={() => setAddPlaceOpen(true)}
            >
              {t("expenses.realEstate.addPlaceAction")}
            </Button>
          ) : null}
        </h3>
        {sections.map((acc) => (
          <PageGridTile key={acc.account_slug} id={`place-${acc.account_slug}`}>
            <h4>
              {acc.label}
              <span className="muted mono" style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
                {formatMoney({ value: acc.total, currency: acc.currency })}
              </span>
              <Button variant="secondary"
                onClick={() => setAssignPlace({ slug: acc.account_slug, label: acc.label })}
              >
                {t("expenses.realEstate.assignAction")}
              </Button>
              {DEMO_EDITS_LIMITED ? null : (
                <Button variant="secondary" onClick={() => setDfl2PlaceSlug(acc.account_slug)}>
                  {t("expenses.realEstate.dfl2Action")}
                </Button>
              )}
            </h4>
            {(() => {
              const place = places.find((p) => p.slug === acc.account_slug);
              return place?.dfl2 ? (
                <p className="muted">
                  {t("expenses.realEstate.dfl2Summary", {
                    m2: formatGroupedDecimal(place.dfl2_built_m2!, 0, 2),
                    year: place.dfl2_reception_year,
                    through: place.dfl2_contribuciones_halved_through,
                  })}
                </p>
              ) : null;
            })()}
            <RealEstateBillMonthList block={acc} onLink={setLinkSlot} />
          </PageGridTile>
        ))}
        {sections.length === 0 && !loading ? (
          <p className="muted">{t("expenses.emptyAccount")}</p>
        ) : null}
      </PageGridTile>

      <RealEstateExpenseLinkModal
        slot={linkSlot}
        open={linkSlot != null}
        onClose={() => setLinkSlot(null)}
      />
      <RealEstateAssignPurchaseModal
        place={assignPlace}
        open={assignPlace != null}
        onClose={() => setAssignPlace(null)}
      />
      <RealEstateAddPlaceModal open={addPlaceOpen} onClose={() => setAddPlaceOpen(false)} />
      <RealEstatePlaceDfl2Modal
        place={places.find((p) => p.slug === dfl2PlaceSlug) ?? null}
        onClose={() => setDfl2PlaceSlug(null)}
      />
    </>
  );
}
