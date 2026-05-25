import styles from "./GlobalLoadingSpinner.module.css";

export function GlobalLoadingSpinner() {
  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label="Loading">
      <span className={styles.ring} />
    </div>
  );
}
