import { useState } from "react";
import { Button } from "@crfrsr/ui";
import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { CHART_STYLES, type ChartStyle } from "../../chartStylePreference";
import { ChartStylesPreviewModal } from "../../components/charts/ChartStylesPreviewModal";
import { TaxResidencySection } from "../../components/panel/TaxResidencySection";

export function SettingsPage() {
  const { t } = useTranslation();
  const { decimalSeparator, setDecimalSeparator, language, setLanguage, chartStyle, setChartStyle } =
    useDisplayPreferences();
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <>
      <div
        className="toggle-row"
        role="radiogroup"
        aria-label={t("settings.language")}
      >
        <span className="muted">{t("settings.language")}</span>
        <label>
          <input
            type="radio"
            name="nw-global-lang"
            checked={language === "es"}
            onChange={() => setLanguage("es")}
          />{" "}
          {t("settings.languageEs")}
        </label>
        <label>
          <input
            type="radio"
            name="nw-global-lang"
            checked={language === "en"}
            onChange={() => setLanguage("en")}
          />{" "}
          {t("settings.languageEn")}
        </label>
      </div>
      <div className="toggle-row" role="radiogroup" aria-label={t("app.displayPreferences.numberFormat")}>
        <span className="muted">{t("app.displayPreferences.numberFormat")}</span>
        <label>
          <input
            type="radio"
            name="nw-global-ds"
            checked={decimalSeparator === "comma"}
            onChange={() => setDecimalSeparator("comma")}
          />{" "}
          <span className="mono">1.234,56</span>
        </label>
        <label>
          <input
            type="radio"
            name="nw-global-ds"
            checked={decimalSeparator === "period"}
            onChange={() => setDecimalSeparator("period")}
          />{" "}
          <span className="mono">1,234.56</span>
        </label>
      </div>
      {/* Rehearsal (2026-11-03): hand-drawn chart renderings, compared side by side in the preview. */}
      <div className="toggle-row">
        <label>
          <span className="muted">{t("app.displayPreferences.chartStyle")}</span>
          <select
            name="nw-global-chart-style"
            value={chartStyle}
            onChange={(e) => setChartStyle(e.target.value as ChartStyle)}
          >
            {CHART_STYLES.map((s) => (
              <option key={s} value={s}>
                {t(`app.displayPreferences.chartStyles.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
          {t("chartStylesLab.previewButton")}
        </Button>
      </div>
      {/* Mounted only while open: the samples draw every style at once. */}
      {previewOpen ? <ChartStylesPreviewModal open onClose={() => setPreviewOpen(false)} /> : null}
      <TaxResidencySection />
    </>
  );
}
