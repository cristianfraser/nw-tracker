import type { ReactNode } from "react";
import type { DashboardCardValueVariant } from "./DashboardCardValue";
import { DashboardCardValue } from "./DashboardCardValue";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import styles from "./CompactEntityCard.module.css";

export type CompactEntityCardProps = {
  label: string;
  /** When set, label is rendered as a `Link`. */
  to?: string;
  balanceDelta?: number | null;
  showUsd: boolean;
  clp: number;
  apiUsd?: number | null;
  cardSlug: string;
  animated?: boolean;
  subtitle?: ReactNode;
  /** Deposits / Δ rows (e.g. `DashboardCardGroupMetrics`). */
  metrics?: ReactNode;
  /** `main` vs `breakdown`: number-flow alignment / animation (font size is shared). */
  valueVariant?: DashboardCardValueVariant;
  /** When true, no inner border/padding (parent is `portfolio-strip-compact`). */
  stripInner?: boolean;
  /** Optional account list / footer (e.g. cash bucket breakdown). */
  breakdown?: ReactNode;
};

/**
 * Compact summary card (sub-group or account on a class page): title + optional Δ, single value.
 */
export function CompactEntityCard({
  label,
  to,
  balanceDelta = null,
  showUsd,
  clp,
  apiUsd,
  cardSlug,
  animated = true,
  subtitle,
  metrics,
  valueVariant = "breakdown",
  stripInner = false,
  breakdown,
}: CompactEntityCardProps) {
  const rootClass = [
    styles.root,
    stripInner ? styles.rootStripInner : "",
    breakdown ? styles.rootWithBreakdown : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass}>
      <DashboardCardTitleRow
        label={label}
        titleTo={to}
        balanceDelta={balanceDelta ?? null}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
      />
      {subtitle ? <span className="muted" style={{ fontSize: "0.75rem" }}>{subtitle}</span> : null}
      <div className="value mono">
        <DashboardCardValue
          clp={clp}
          apiUsd={apiUsd}
          showUsd={showUsd}
          animated={animated}
          variant={valueVariant}
          mountSeedKey={`${cardSlug}:compact`}
        />
      </div>
      {metrics ? <div>{metrics}</div> : null}
      {breakdown}
    </div>
  );
}
