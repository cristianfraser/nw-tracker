import { useTranslation } from "react-i18next";
import { formatGroupedDecimalTrimmed } from "../../format";
import { useChartStyle } from "./chartStyle";
import {
  HATCH_TUNING_DEFAULT,
  HATCH_TUNING_LIMITS,
  setHatchTuning,
  useHatchTuning,
  type HatchTuning,
} from "./hatchTuning";
import styles from "./HatchTuningControl.module.css";

/**
 * A floating panel to try the hand-drawn hatch angles live: how many degrees a chart's bar series
 * spread over, and how far each bar, map tile and area run tilts off its base. Shown only in the
 * hand-drawn styles.
 */
export function HatchTuningControl() {
  const { t } = useTranslation();
  const style = useChartStyle();
  const tuning = useHatchTuning();
  if (style === "plain") return null;
  const row = (key: keyof HatchTuning, label: string) => {
    const [lo, hi] = HATCH_TUNING_LIMITS[key];
    return (
      <label className={styles.row}>
        <span className={styles.label}>{label}</span>
        <input
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={tuning[key]}
          onChange={(e) => setHatchTuning({ [key]: e.currentTarget.valueAsNumber })}
        />
        <span className={styles.value}>{formatGroupedDecimalTrimmed(tuning[key])}</span>
      </label>
    );
  };
  return (
    <div className={styles.panel} role="group" aria-label={t("charts.hatchTuning.title")}>
      <div className={styles.head}>
        <span>{t("charts.hatchTuning.title")}</span>
        <button type="button" className={styles.reset} onClick={() => setHatchTuning(HATCH_TUNING_DEFAULT)}>
          {t("charts.hatchTuning.reset")}
        </button>
      </div>
      {row("range", t("charts.hatchTuning.range"))}
      {row("noise", t("charts.hatchTuning.noise"))}
    </div>
  );
}
