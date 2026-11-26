import { useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { CHART_STYLES, type ChartStyle } from "../../chartStylePreference";
import { ChartStylesPreviewModal } from "../../components/charts/ChartStylesPreviewModal";
import { RoughPolylines, roughPenFor } from "../../components/charts/roughShapes";
import { TaxResidencySection } from "../../components/panel/TaxResidencySection";
import styles from "./SettingsPage.module.css";

const STYLE_SHORT_KEY: Record<ChartStyle, string> = {
  plain: "panelSettings.display.chartStyleShort.plain",
  pen: "panelSettings.display.chartStyleShort.pen",
  pencil: "panelSettings.display.chartStyleShort.pencil",
  marker: "panelSettings.display.chartStyleShort.marker",
  watercolor: "panelSettings.display.chartStyleShort.watercolor",
  crayon: "panelSettings.display.chartStyleShort.crayon",
};

/** The sample every chart style draws: one short series in an 80×30 box. */
const SAMPLE_RUNS: [number, number][][] = [
  [
    [3, 24],
    [16, 18],
    [30, 21],
    [44, 11],
    [58, 14],
    [77, 5],
  ],
];
const SAMPLE_POINTS = SAMPLE_RUNS[0].map(([x, y]) => `${x},${y}`).join(" ");
const SAMPLE_COLOR = "#3d9cf9";

/** A chart style drawn as itself: the app's line in the plain style, the style's own pen otherwise. */
function ChartStyleSample({ style }: { style: ChartStyle }) {
  const pen = roughPenFor(style);
  return (
    <svg className={styles.sample} viewBox="0 0 80 30" aria-hidden="true">
      {pen ? (
        <RoughPolylines runs={SAMPLE_RUNS} color={SAMPLE_COLOR} pen={pen} seed={7} width={1.6} />
      ) : (
        <polyline points={SAMPLE_POINTS} fill="none" stroke={SAMPLE_COLOR} strokeWidth={1.6} />
      )}
    </svg>
  );
}

/** One setting: its name and what it changes, then its choices as a group. */
function Setting({ id, name, what, children }: { id: string; name: string; what: ReactNode; children: ReactNode }) {
  return (
    <li className={styles.setting}>
      <span className={styles.name} id={id}>
        {name}
      </span>
      <span className={`muted ${styles.what}`}>{what}</span>
      <span className={styles.choice} role="group" aria-labelledby={id}>
        {children}
      </span>
    </li>
  );
}

/**
 * /panel/settings: «Display» as a list of settings — each a line with its choices as text
 * buttons, the current one underlined (the chart controls' look); the chart style is picked from
 * a sample of each — over the tax residency.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const { decimalSeparator, setDecimalSeparator, language, setLanguage, chartStyle, setChartStyle } =
    useDisplayPreferences();
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <section className={styles.frame}>
        <h2>{t("panelSettings.display.title")}</h2>
        <ul className={styles.settings}>
          <Setting id="nw-settings-lang" name={t("settings.language")} what={t("panelSettings.display.languageWhat")}>
            <span className="surface-controls__set">
              <button type="button" className={language === "es" ? "is-on" : undefined} aria-pressed={language === "es"} onClick={() => setLanguage("es")}>
                {t("settings.languageEs")}
              </button>
              <button type="button" className={language === "en" ? "is-on" : undefined} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>
                {t("settings.languageEn")}
              </button>
            </span>
          </Setting>
          <Setting
            id="nw-settings-ds"
            name={t("app.displayPreferences.numberFormat")}
            what={t("panelSettings.display.numberFormatWhat")}
          >
            <span className={`surface-controls__set mono`}>
              <button
                type="button"
                className={decimalSeparator === "comma" ? "is-on" : undefined}
                aria-pressed={decimalSeparator === "comma"}
                onClick={() => setDecimalSeparator("comma")}
              >
                1.234,56
              </button>
              <button
                type="button"
                className={decimalSeparator === "period" ? "is-on" : undefined}
                aria-pressed={decimalSeparator === "period"}
                onClick={() => setDecimalSeparator("period")}
              >
                1,234.56
              </button>
            </span>
          </Setting>
          <Setting
            id="nw-settings-chart-style"
            name={t("app.displayPreferences.chartStyle")}
            what={
              <>
                {t("panelSettings.display.chartStyleWhat")}{" "}
                <button type="button" className={styles.link} onClick={() => setPreviewOpen(true)}>
                  {t("panelSettings.display.compareCharts")}
                </button>
              </>
            }
          >
            <span className={styles.styles}>
              {CHART_STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`${styles.style} ${s === chartStyle ? styles.styleOn : ""}`}
                  aria-pressed={s === chartStyle}
                  title={t(`app.displayPreferences.chartStyles.${s}`)}
                  onClick={() => setChartStyle(s)}
                >
                  <ChartStyleSample style={s} />
                  {t(STYLE_SHORT_KEY[s])}
                </button>
              ))}
            </span>
          </Setting>
        </ul>
      </section>
      {/* Mounted only while open: the samples draw every style at once. */}
      {previewOpen ? <ChartStylesPreviewModal open onClose={() => setPreviewOpen(false)} /> : null}
      <TaxResidencySection />
    </>
  );
}
