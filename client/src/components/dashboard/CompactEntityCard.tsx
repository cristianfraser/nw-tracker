import type { ReactNode } from "react";
import type { DashboardCardValueVariant } from "./DashboardCardValue";
import { DashboardCardValue } from "./DashboardCardValue";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import { cn } from "../../cn";
import styles from "./CompactEntityCard.module.css";

export type CompactEntityCardProps = {
  /** Omit to skip the title row (e.g. the hero card, whose name repeats the page title). */
  label?: string;
  /** When set, label is rendered as a `Link`. */
  to?: string;
  /** The bucket's colour (`r,g,b`): the label becomes a pill in it. */
  labelColorRgb?: string | null;
  showUsd: boolean;
  clp: number;
  apiUsd?: number | null;
  animated?: boolean;
  fxMissing?: boolean;
  /** Lower opacity when linked sync source(s) are stale. */
  syncStale?: boolean;
  subtitle?: ReactNode;
  /** Day Δ rendered right-aligned on the balance row (e.g. `CardValueDayPl`). */
  valueDelta?: ReactNode;
  /** Deposits / Δ rows (e.g. `DashboardCardGroupMetrics`). */
  metrics?: ReactNode;
  /** `main` vs `breakdown`: number-flow alignment / animation (font size is shared). */
  valueVariant?: DashboardCardValueVariant;
  /** Optional account list / footer (e.g. cash bucket breakdown). */
  breakdown?: ReactNode;
};

/**
 * Compact summary card (sub-group or account on a class page): title + optional Δ, single value.
 */
export function CompactEntityCard({
  label,
  to,
  labelColorRgb,
  showUsd,
  clp,
  apiUsd,
  animated = true,
  subtitle,
  valueDelta,
  metrics,
  valueVariant = "breakdown",
  breakdown,
  fxMissing = false,
  syncStale = false,
}: CompactEntityCardProps) {
  return (
    <div
      className={cn(styles.root, breakdown != null && breakdown !== false && styles.rootWithBreakdown)}
    >
      {label != null ? <DashboardCardTitleRow label={label} titleTo={to} colorRgb={labelColorRgb} /> : null}
      {subtitle ? <span className={cn("muted", styles.subtitle)}>{subtitle}</span> : null}
      <div className="value mono">
        {/* No change flash on a summary card (the page's own total, an account's hero): only the
            detail cards and breakdown lines below it flash (2026-11-04). */}
        <DashboardCardValue
          clp={clp}
          apiUsd={apiUsd}
          showUsd={showUsd}
          animated={animated}
          variant={valueVariant}
          fxMissing={fxMissing}
          syncStale={syncStale}
        />
        {valueDelta}
      </div>
      {metrics ? <div>{metrics}</div> : null}
      {breakdown}
    </div>
  );
}
