import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { cn } from "../../cn";
import type { DisplayUnit } from "../../queries/keys";
import styles from "./AppDisplayPreferencesBar.module.css";

/**
 * Global CLP/USD control (Período/Rango moved onto each chart/table — per-surface
 * controls, `surfaceDisplayPrefs.ts`). Default: full-width bottom dock, toolbar centered.
 * Desktop: compact toolbar at the bottom-right (not stretched). The number-format
 * (decimal separator) control lives in the settings panel (`/panel/settings`), not here.
 */
export function AppDisplayPreferencesBar() {
  const { t } = useTranslation();
  const { displayUnit, setDisplayUnit } = useDisplayPreferences();

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
          </div>
        </div>
      </div>
    </div>
  );
}
