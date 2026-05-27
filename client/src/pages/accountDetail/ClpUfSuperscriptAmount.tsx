import { formatClp, formatUfUnitsFine } from "../../format";
import { cn } from "../../cn";
import styles from "./ClpUfSuperscriptAmount.module.css";

export type ClpUfSuperscriptAmountProps = {
  clpClp: number | null | undefined;
  ufAmount: number | null | undefined;
  className?: string;
};

/**
 * Renders CLP amount with UF equivalent in superscript (e.g. $1.234.567 with small UF above).
 */
export function ClpUfSuperscriptAmount({ clpClp, ufAmount, className }: ClpUfSuperscriptAmountProps) {
  if (clpClp == null || !Number.isFinite(clpClp)) {
    if (ufAmount != null && Number.isFinite(ufAmount)) {
      return (
        <span className={cn("mono", styles.root, className)}>
          <span className={styles.clpMuted}>—</span>
          <sup className={styles.ufSup}>{formatUfUnitsFine(ufAmount)}</sup>
        </span>
      );
    }
    return <span className={cn("mono", styles.root, className)}>—</span>;
  }
  const ufOk = ufAmount != null && Number.isFinite(ufAmount);
  return (
    <span className={cn("mono", styles.root, className)}>
      <span className={styles.clp}>{formatClp(clpClp)}</span>
      {ufOk ? <sup className={styles.ufSup}>{formatUfUnitsFine(ufAmount)}</sup> : null}
    </span>
  );
}
