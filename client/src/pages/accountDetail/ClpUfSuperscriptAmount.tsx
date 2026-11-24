import type { Money } from "../../types";
import { cn } from "../../cn";
import styles from "./ClpUfSuperscriptAmount.module.css";
import { formatMoney } from "../../format";

export type ClpUfSuperscriptAmountProps = {
  /** The amount in the payment currency (the main figure). */
  pay: Money | null;
  /** The same amount in the loan's currency (the superscript). */
  loan: Money | null;
  className?: string;
};

/**
 * A loan figure in the payment currency with its amount in the loan's currency in superscript
 * (a peso amount with the small UF figure above it).
 */
export function ClpUfSuperscriptAmount({ pay, loan, className }: ClpUfSuperscriptAmountProps) {
  const loanText = loan != null && Number.isFinite(loan.value) ? formatMoney({ value: loan.value, currency: loan.currency }, { precision: "full" }) : null;
  if (pay == null || !Number.isFinite(pay.value)) {
    if (loanText != null) {
      return (
        <span className={cn("mono", styles.root, className)}>
          <span className={styles.clpMuted}>—</span>
          <sup className={styles.ufSup}>{loanText}</sup>
        </span>
      );
    }
    return <span className={cn("mono", styles.root, className)}>—</span>;
  }
  return (
    <span className={cn("mono", styles.root, className)}>
      <span className={styles.clp}>{formatMoney({ value: pay.value, currency: pay.currency })}</span>
      {loanText != null ? <sup className={styles.ufSup}>{loanText}</sup> : null}
    </span>
  );
}
