import { ChartStylesLabCharts } from "../../components/charts/ChartStylesLabCharts";
import { ChartStyleScope } from "../../components/charts/chartStyle";
import { CHART_STYLES, type ChartStyle } from "../../chartStylePreference";
import { useTranslation } from "../../i18n";

/**
 * Rehearsal (2026-11-03): the same two sample charts under each chart style, side by side
 * (`ChartStylesLabCharts`). The toolbar's «Charts» select applies a style to the real pages.
 */
const STYLE_LABEL_KEY: Record<ChartStyle, string> = {
  plain: "app.displayPreferences.chartStyles.plain",
  pen: "app.displayPreferences.chartStyles.pen",
  pencil: "app.displayPreferences.chartStyles.pencil",
  marker: "app.displayPreferences.chartStyles.marker",
  watercolor: "app.displayPreferences.chartStyles.watercolor",
  crayon: "app.displayPreferences.chartStyles.crayon",
};

export function ChartStylesLabPage() {
  const { t } = useTranslation();
  return (
    <div className="page-grid" style={{ rowGap: "var(--row-gap)" }}>
      <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
        {t("chartStylesLab.intro")}
      </p>
      <div
        style={{
          gridColumn: "1 / -1",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
          gap: "var(--gutter)",
        }}
      >
        {CHART_STYLES.map((style) => (
          <ChartStyleScope key={style} style={style} cssStyle={{ minWidth: 0 }}>
            <h2 style={{ marginTop: 0 }}>{t(STYLE_LABEL_KEY[style])}</h2>
            <ChartStylesLabCharts />
          </ChartStyleScope>
        ))}
      </div>
    </div>
  );
}
