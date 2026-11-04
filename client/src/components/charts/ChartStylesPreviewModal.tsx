import { ChartStylesLabCharts } from "./ChartStylesLabCharts";
import { ChartStyleScope } from "./chartStyle";
import { CHART_STYLES, type ChartStyle } from "../../chartStylePreference";
import { useTranslation } from "../../i18n";
import { Modal } from "../ui/Modal";
import styles from "./ChartStylesPreviewModal.module.css";

/**
 * Rehearsal (2026-11-03): the same two sample charts under each chart style, side by side
 * (`ChartStylesLabCharts`), opened from the «Charts» select in the settings panel.
 */
const STYLE_LABEL_KEY: Record<ChartStyle, string> = {
  plain: "app.displayPreferences.chartStyles.plain",
  pen: "app.displayPreferences.chartStyles.pen",
  pencil: "app.displayPreferences.chartStyles.pencil",
  marker: "app.displayPreferences.chartStyles.marker",
  watercolor: "app.displayPreferences.chartStyles.watercolor",
  crayon: "app.displayPreferences.chartStyles.crayon",
};

export function ChartStylesPreviewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("chartStylesLab.title")}
      className={styles.dialog}
      closeAriaLabel={t("common.close")}
    >
      <p className={`muted ${styles.intro}`}>{t("chartStylesLab.intro")}</p>
      <div className={styles.grid}>
        {CHART_STYLES.map((style) => (
          <ChartStyleScope key={style} style={style} cssStyle={{ minWidth: 0 }}>
            <h3 style={{ marginTop: 0 }}>{t(STYLE_LABEL_KEY[style])}</h3>
            <ChartStylesLabCharts />
          </ChartStyleScope>
        ))}
      </div>
    </Modal>
  );
}
