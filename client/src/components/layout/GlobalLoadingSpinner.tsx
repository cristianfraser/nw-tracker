import i18n from "../../i18n";
import styles from "./GlobalLoadingSpinner.module.css";

export function GlobalLoadingSpinner() {
  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label={i18n.t("common.loading")}>
      <span className={styles.ring} />
    </div>
  );
}
