import { useTranslation } from "../../i18n";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";

export function SettingsPage() {
  const { t } = useTranslation();
  const { decimalSeparator, setDecimalSeparator, language, setLanguage } = useDisplayPreferences();

  return (
    <>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        {t("settings.pageHint")}
      </p>
      <div
        className="toggle-row"
        role="radiogroup"
        aria-label={t("settings.language")}
        style={{ marginBottom: "0.75rem" }}
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
    </>
  );
}
