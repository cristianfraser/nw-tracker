import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";

export function SettingsPage() {
  const { t } = useTranslation();
  const { decimalSeparator, setDecimalSeparator } = useDisplayPreferences();

  return (
    <>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("settings.pageHint")}
      </p>
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
    </>
  );
}
