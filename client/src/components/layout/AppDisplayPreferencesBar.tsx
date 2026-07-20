import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { cn } from "../../cn";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import type { DisplayUnit } from "../../queries/keys";
import styles from "./AppDisplayPreferencesBar.module.css";

/**
 * Global CLP/USD + MTD/YTD controls. Default: full-width bottom dock, toolbar centered.
 * Desktop: compact toolbar at the bottom-right (not stretched).
 * The number-format (decimal separator) control lives in the settings panel
 * (`/panel/settings`), not here.
 */
export function AppDisplayPreferencesBar() {
  const { t } = useTranslation();
  const { displayUnit, setDisplayUnit, metricsPeriod, setMetricsPeriod } = useDisplayPreferences();

  return (
    <div className={styles.host} data-app-display-prefs-host>
      <div className={styles.dock}>
        <div
          className={styles.bar}
          role="toolbar"
          aria-label={t("app.displayPreferences.toolbarAria")}
        >
          <div className={cn("toggle-row", styles.row)}>
            <label className={styles.field}>
              <span className="muted">{t("app.displayPreferences.displayCurrency")}</span>
              <select
                name="nw-global-du"
                value={displayUnit}
                onChange={(e) => setDisplayUnit(e.target.value as DisplayUnit)}
              >
                <option value="clp">CLP</option>
                <option value="usd">USD</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className="muted">{t("dashboard.chartGranularityLabel")}</span>
              <select
                name="nw-global-mp"
                value={metricsPeriod}
                onChange={(e) => setMetricsPeriod(e.target.value as CardGroupMetricsPeriod)}
              >
                <option value="day">{t("dashboard.daily")}</option>
                <option value="month">{t("dashboard.monthly")}</option>
                <option value="year">{t("dashboard.yearly")}</option>
              </select>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
