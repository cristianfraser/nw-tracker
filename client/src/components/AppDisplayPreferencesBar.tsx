import { useIsFetching } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { cn } from "../cn";
import styles from "./AppDisplayPreferencesBar.module.css";

/**
 * Global CLP/USD + MTD/YTD controls. Default: full-width bottom dock, toolbar centered.
 * Desktop: compact toolbar at the bottom-right (not stretched).
 */
export function AppDisplayPreferencesBar() {
  const { t } = useTranslation();
  const { displayUnit, setDisplayUnit, metricsPeriod, setMetricsPeriod } = useDisplayPreferences();
  const dashboardFetching = useIsFetching({
    predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "dashboard",
  });
  const unitBusy = dashboardFetching > 0;

  return (
    <div className={styles.host} data-app-display-prefs-host>
      <div className={styles.dock}>
        <div
          className={styles.bar}
          role="toolbar"
          aria-label={t("app.displayPreferences.toolbarAria")}
        >
          <div className={cn("toggle-row", styles.row)}>
          <span className="muted">{t("app.displayPreferences.displayCurrency")}</span>
        <label>
          <input
            type="radio"
            name="nw-global-du"
            checked={displayUnit === "clp"}
            disabled={unitBusy}
            onChange={() => setDisplayUnit("clp")}
          />{" "}
          CLP
        </label>
        <label>
          <input
            type="radio"
            name="nw-global-du"
            checked={displayUnit === "usd"}
            disabled={unitBusy}
            onChange={() => setDisplayUnit("usd")}
          />{" "}
          USD
        </label>
        <span className="muted" style={{ marginLeft: "1.25rem" }}>
          {t("dashboard.chartGranularityLabel")}{" "}
        </span>
        <label>
          <input
            type="radio"
            name="nw-global-mp"
            checked={metricsPeriod === "month"}
            onChange={() => setMetricsPeriod("month")}
          />{" "}
          {t("dashboard.monthly")}
        </label>
        <label>
          <input
            type="radio"
            name="nw-global-mp"
            checked={metricsPeriod === "year"}
            onChange={() => setMetricsPeriod("year")}
          />{" "}
          {t("dashboard.yearly")}
        </label>
          </div>
        </div>
      </div>
    </div>
  );
}
