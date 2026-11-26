import type { ReactNode } from "react";
import { cn } from "../../cn";
import styles from "./TaxRows.module.css";

export type TaxFigure = {
  key: string;
  label: string;
  value: string;
  /** The value's colour: a difference in red, a zero difference quiet. */
  tone?: "bad" | "quiet";
  sub?: ReactNode;
};

/** The return's result as figures: filed, draft, difference, settlement. Four across, two by two on a phone. */
export function TaxFigures({ figures }: { figures: TaxFigure[] }) {
  return (
    <div className={styles.figuresFrame}>
      <dl className={styles.figures}>
      {figures.map((f) => (
        <div key={f.key} className={styles.figure}>
          <dt className={styles.figureLabel}>{f.label}</dt>
          <dd className={cn(styles.figureValue, f.tone && styles[f.tone])}>{f.value}</dd>
          {f.sub != null ? <dd className={styles.figureSub}>{f.sub}</dd> : null}
        </div>
      ))}
      </dl>
    </div>
  );
}

/** What the return rests on, as short label / value facts on one wrapping line. */
export function TaxFacts({ facts }: { facts: { key: string; label?: string; value: ReactNode }[] }) {
  if (facts.length === 0) return null;
  return (
    <ul className={styles.facts}>
      {facts.map((f) => (
        <li key={f.key}>
          {f.label ? `${f.label} ` : null}
          <b>{f.value}</b>
        </li>
      ))}
    </ul>
  );
}
