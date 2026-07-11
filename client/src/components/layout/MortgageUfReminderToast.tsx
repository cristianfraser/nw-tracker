import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { useMortgageUfReminder } from "../../queries/hooks";
import { formatClpUfDay } from "../../format";
import styles from "./MortgageUfReminderToast.module.css";

/**
 * Global reminder for the CC-paid mortgage cuota in months where waiting past the cierre is
 * cheaper (UF flat/falling). Manually dismissed — no timeout — and reappears on every route
 * navigation (and naturally on full refresh), so it can't be paid early by mistake.
 */
export function MortgageUfReminderToast() {
  const { t } = useTranslation();
  const { data } = useMortgageUfReminder();
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);

  // Reappear on navigation (in-memory state resets on refresh on its own).
  useEffect(() => {
    setDismissed(false);
  }, [location.pathname]);

  if (!data?.show || dismissed) return null;

  const trend = t(
    data.uf_best != null && data.uf_now != null && data.uf_best === data.uf_now
      ? "reminders.mortgageUf.trendFlat"
      : "reminders.mortgageUf.trendLower"
  );

  // Format numbers at render time (never cache — decimal separator changes re-render the tree).
  const message =
    data.mode === "wait"
      ? t("reminders.mortgageUf.waitMessage", {
          trend,
          cierre: data.cierre_iso,
          nextMonth: data.next_billing_month,
          bestDate: data.best_pay_date,
          ufBest: formatClpUfDay(data.uf_best),
          ufNow: formatClpUfDay(data.uf_now),
        })
      : t("reminders.mortgageUf.payTodayMessage", {
          nextMonth: data.next_billing_month,
        });

  return (
    <div className={styles.dock}>
      <div className={styles.toast} role="status" aria-live="polite">
        <div className={styles.header}>
          <strong className={styles.title}>{t("reminders.mortgageUf.title")}</strong>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => setDismissed(true)}
            aria-label={t("reminders.mortgageUf.dismiss")}
          >
            ×
          </button>
        </div>
        <p className={styles.message}>{message}</p>
        {data.mode === "wait" && data.horizon_limited ? (
          <p className={styles.horizon}>
            {t("reminders.mortgageUf.horizonNote", { horizon: data.best_pay_date })}
          </p>
        ) : null}
        <button type="button" className={styles.action} onClick={() => setDismissed(true)}>
          {t("reminders.mortgageUf.dismiss")}
        </button>
      </div>
    </div>
  );
}
