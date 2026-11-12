import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { cn } from "../../cn";
import { useCurrencies } from "../../queries/hooks";
import styles from "./AppDisplayPreferencesBar.module.css";

/** The picker's options until `/api/currencies` answers (the current unit always listed). */
const FALLBACK_UNITS = ["clp", "usd"] as const;

function unitRank(code: string): number {
  const i = (FALLBACK_UNITS as readonly string[]).indexOf(code);
  return i < 0 ? FALLBACK_UNITS.length : i;
}

/**
 * Global display-currency control: the core currencies the server loads (`/api/currencies`). (Período/Rango moved onto each chart/table — per-surface
 * controls, `surfaceDisplayPrefs.ts`). Default: full-width bottom dock, toolbar centered.
 * Desktop: compact toolbar at the bottom-right (not stretched). The number-format
 * (decimal separator) and chart style controls live in the settings panel (`/panel/settings`).
 */
export function AppDisplayPreferencesBar() {
  const { t } = useTranslation();
  const { displayUnit, setDisplayUnit } = useDisplayPreferences();
  const { data: currencies } = useCurrencies();
  // Pesos and dollars first, as the toggle always listed them; any other core currency after.
  const loaded = currencies?.currencies
    .filter((c) => c.tier === "core")
    .map((c) => c.code)
    .sort((a, b) => unitRank(a) - unitRank(b) || a.localeCompare(b));
  const codes = loaded && loaded.length > 0 ? loaded : [...FALLBACK_UNITS];
  const options = codes.includes(displayUnit) ? codes : [...codes, displayUnit];

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
                onChange={(e) => setDisplayUnit(e.target.value)}
              >
                {options.map((code) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
