import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../cn";
import { GlanceTitleLine } from "../components/account/PositionGlance";
import { ProjectionsChart } from "../components/charts/ProjectionsChart";
import { PageGridTile } from "../components/layout/PageGridTile";
import { ProjectionsAssumptions } from "../components/projections/ProjectionsAssumptions";
import { ProjectionsRail } from "../components/projections/ProjectionsRail";
import { loadableClass } from "../components/ui/Loadable";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { parseNumberInput } from "../format";
import { formatYearMonthLabel } from "../formatDateLabel";
import {
  projectionFieldGroups,
  projectionFieldKey,
  validProjectionOverrides,
  type ProjectionField,
} from "../projectionsFields";
import {
  projectionMoneyCurrencyKey,
  readStoredProjectionOverrides,
  writeStoredProjectionOverrides,
  type ProjectionOverrides,
} from "../projectionsOverrides";
import { useCurrencies, useProjections } from "../queries/hooks";
import { queryLoadError } from "../queries/pageShapeReady";
import glance from "../components/account/PositionGlance.module.css";
import band from "./accountDetail/PositionAccountDetailPage.module.css";
import styles from "./ProjectionsPage.module.css";

/**
 * /projections on the position page's layout: the title line (net worth at retirement, today's
 * money), the chart beside the rail (server `glance`: where that net worth comes from, the
 * drawdown pot, each strategy's income and how long it lasts), then the inputs in three groups
 * (`ProjectionsAssumptions`). One column below 880, in that order.
 */
export function ProjectionsPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const { data: currencies } = useCurrencies();
  const [overrides, setOverrides] = useState<ProjectionOverrides>(() => readStoredProjectionOverrides(localStorage));
  /** Free-form text while a field is being edited (allows "" mid-edit); committed on change,
   * cleared on blur so the display snaps back to the effective value. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const inflationCodes = useMemo(() => {
    const core = currencies?.currencies.filter((c) => c.tier === "core").map((c) => c.code);
    return core && core.length > 0 ? core : [displayUnit];
  }, [currencies, displayUnit]);
  const groups = useMemo(() => projectionFieldGroups(inflationCodes), [inflationCodes]);

  // Only in-bounds overrides go to the server; invalid fields show their message while the
  // figures and the chart keep the last valid parameters.
  const validOverrides = useMemo(
    () => validProjectionOverrides(groups.flatMap((g) => g.fields), overrides),
    [overrides, groups]
  );
  const query = useProjections(displayUnit, validOverrides);
  const { data, isPending } = query;
  // A failed refetch keeps the data on screen; the error shows only with nothing to show.
  const error = queryLoadError(query);
  // The form is inert only until the first response (an edit keeps the previous data on screen);
  // the figures and chart also dim while the other display unit's numbers are held.
  const resultsLoading = isPending || (data != null && data.unit !== displayUnit);

  useEffect(() => {
    writeStoredProjectionOverrides(localStorage, overrides);
  }, [overrides]);

  const setParam = (f: ProjectionField, raw: string) => {
    const key = projectionFieldKey(f);
    setDrafts((prev) => ({ ...prev, [key]: raw }));
    // A draft that isn't a number keeps the last override and shows its message.
    const parsed = parseNumberInput(raw);
    if (!parsed.ok) return;
    setOverrides((prev) => {
      const next = { ...prev };
      const currencyKey = f.kind === "money" ? projectionMoneyCurrencyKey(f.key) : null;
      if (parsed.value == null) {
        delete next[key];
        if (currencyKey) delete next[currencyKey];
      } else {
        next[key] = parsed.value;
        // A money input is typed in the unit on screen.
        if (currencyKey) next[currencyKey] = displayUnit;
      }
      return next;
    });
  };

  const commitParam = (f: ProjectionField) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[projectionFieldKey(f)];
      return next;
    });
  };

  if (error) {
    return (
      <main>
        <h1>{t("projections.title")}</h1>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }

  // The figures are the response's, in ITS unit (a held other-unit response shows dimmed, unconverted).
  const unit = data?.unit ?? displayUnit;
  const g = data?.glance;

  return (
    <main>
      <GlanceTitleLine
        title={t("projections.title")}
        value={g ? { value: g.net_worth_at_retire, currency: unit } : null}
        // Projected figures are whole units in every currency.
        valueFormat={{ digits: 0 }}
        day={null}
        loading={resultsLoading}
      >
        <div className={loadableClass(resultsLoading, glance.sub)}>
          <span>
            {data
              ? t("projections.subline", { age: data.retire_age, month: formatYearMonthLabel(data.retire_month) })
              : " "}
          </span>
        </div>
      </GlanceTitleLine>

      {/* The chart beside the rail; on a phone the chart first, then the rail's groups. */}
      <PageGridTile id="projection-band" className={cn("page-grid", band.band, styles.band)}>
        <div className={cn("chart-grid chart-grid--full-line", band.bandChart, styles.chart)}>
          <ProjectionsChart
            title={g ? t("projections.chartTitle", { age: g.end_age }) : " "}
            points={data?.chart.points ?? []}
            lines={data?.chart.lines ?? []}
            strategyLineKeys={g?.strategies.map((s) => s.line_key) ?? []}
            displayUnit={unit}
            inflationPct={data?.params.inflation_pct[unit]}
            loading={resultsLoading}
          />
        </div>
        <div className={loadableClass(resultsLoading, band.bandRail)} aria-busy={resultsLoading || undefined}>
          <ProjectionsRail glance={g} unit={unit} />
        </div>
      </PageGridTile>

      <ProjectionsAssumptions
        groups={groups}
        overrides={overrides}
        drafts={drafts}
        params={data?.params}
        paramsUnit={unit}
        displayUnit={displayUnit}
        retireAge={data?.retire_age}
        inflationDefaults={data?.inflation_default_pct}
        loading={isPending}
        onChange={setParam}
        onBlur={commitParam}
        onReset={() => {
          setOverrides({});
          setDrafts({});
        }}
      />
    </main>
  );
}
