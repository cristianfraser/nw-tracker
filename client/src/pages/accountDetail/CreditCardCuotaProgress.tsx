import { useId, useState, type CSSProperties, type PointerEvent } from "react";
import type { CcCuotaProgress, CcCuotaProgressCuota } from "../../types";
import { formatClp } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import styles from "./CreditCardCuotaProgress.module.css";

const STATUS_KEY: Record<CcCuotaProgressCuota["status"], string> = {
  paid: "account.creditCard.cuotaProgress.statusPaid",
  billed: "account.creditCard.cuotaProgress.statusBilled",
  pending: "account.creditCard.cuotaProgress.statusPending",
};

/** A segment never grows past this, however few cuotas the table's longest plan has. */
export const CUOTA_SEGMENT_MAX_PX = 30;

/**
 * An installment plan's progress: one fixed-width segment per cuota, filled when paid. Every bar
 * of a table shares the segment width — 1/`maxInstallments` of the row (the longest plan fills it),
 * capped at `CUOTA_SEGMENT_MAX_PX` — so plans compare by length. One tooltip for the whole bar
 * lists every cuota (number, facturación, amount, status): hover on a mouse, tap (or focus)
 * elsewhere. The server states the cuotas; this only draws.
 */
export function CreditCardCuotaProgress({
  progress,
  cuotaClp,
  maxInstallments,
}: {
  progress: CcCuotaProgress;
  /** The plan's current cuota, leading the caption. */
  cuotaClp: number;
  /** The largest cuota count among the bars drawn together (≥ this plan's). */
  maxInstallments: number;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tooltipId = useId();
  const open = hover || pinned;
  const total = progress.cuotas.length;

  const onPointer = (e: PointerEvent<HTMLDivElement>, over: boolean) => {
    if (e.pointerType === "mouse") setHover(over);
  };

  const segments = Math.max(maxInstallments, total, 1);
  // What is still owed, written as a minus: «-$400.000» (none left reads «$0»).
  const owed = progress.pending_clp + progress.billed_clp;
  const owedLabel = owed > 0 ? `-${formatClp(owed)}` : formatClp(0);

  return (
    <div
      className={styles.root}
      style={{ "--cuota-segments": segments, "--cuota-segment-max": `${CUOTA_SEGMENT_MAX_PX}px` } as CSSProperties}
    >
      <div className={cn("mono", styles.caption)}>
        {t("account.creditCard.cuotaProgress.caption", {
          cuota: formatClp(cuotaClp),
          paidCount: progress.paid_count,
          total,
          paid: formatClp(progress.paid_clp),
          totalClp: formatClp(progress.total_clp),
          pending: owedLabel,
        })}
      </div>
      <div
        className={styles.barWrap}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        aria-label={t("account.creditCard.cuotaProgress.ariaLabel", { paid: progress.paid_count, total })}
        onPointerEnter={(e) => onPointer(e, true)}
        onPointerLeave={(e) => onPointer(e, false)}
        onClick={() => setPinned((v) => !v)}
        onBlur={() => {
          setPinned(false);
          setHover(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setPinned(false);
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPinned((v) => !v);
          }
        }}
      >
        <div className={styles.bar}>
          {progress.cuotas.map((c) => (
            <span key={c.index} className={cn(styles.segment, styles[c.status])} />
          ))}
        </div>
        {open ? (
          <div id={tooltipId} role="tooltip" className={styles.tooltip}>
            <table className={cn("mono", styles.tooltipTable)}>
              <thead>
                <tr>
                  <th>{t("account.creditCard.cuotaProgress.colCuota")}</th>
                  <th>{t("account.creditCard.cuotaProgress.colBillingMonth")}</th>
                  <th className={styles.num}>{t("account.creditCard.cuotaProgress.colAmount")}</th>
                  <th>{t("account.creditCard.cuotaProgress.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {progress.cuotas.map((c) => (
                  <tr key={c.index} className={c.status === "pending" ? styles.rowPending : undefined}>
                    <td>
                      {c.index}/{total}
                    </td>
                    <td>{formatYearMonthLabel(c.billing_month)}</td>
                    <td className={styles.num}>{formatClp(c.amount_clp)}</td>
                    <td>
                      {t(STATUS_KEY[c.status])}
                      {c.statement_date ? <span className={styles.statementDate}>{c.statement_date}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>{t("account.creditCard.cuotaProgress.total")}</td>
                  <td className={styles.num}>{formatClp(progress.total_clp)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
