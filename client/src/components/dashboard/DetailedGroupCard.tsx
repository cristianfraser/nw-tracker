import type { ReactNode } from "react";
import { cn } from "../../cn";
import type { DisplayUnit } from "../../queries/keys";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import { DashboardCardValue } from "./DashboardCardValue";

export type DetailedGroupCardProps = {
  title: string;
  /** When set, title is rendered as a `Link` (see `DashboardCardTitleRow`). */
  titleTo?: string;
  /** The bucket's colour (`r,g,b`): the title becomes a pill in it. */
  titleColorRgb?: string | null;
  /** The balance in `unit` (null: none on file). */
  value: number | null;
  unit: DisplayUnit;
  animated?: boolean;
  /** Day Δ rendered right-aligned on the balance row (e.g. `CardValueDayPl`). */
  valueDelta?: ReactNode;
  /** Deposits / Δ rows (e.g. `DashboardCardGroupMetrics`). */
  metrics?: ReactNode;
  /** Breakdown list or other footer content. */
  breakdown?: ReactNode;
  /** Extra classes on the outer `card` wrapper (e.g. `card--cash`). */
  className?: string;
  /** Outer wrapper classes (default: stretched detail card). */
  outerClassName?: string;
  fxMissing?: boolean;
  /** Lower opacity when all contributing accounts have stale sync sources. */
  syncStale?: boolean;
};

/**
 * Full-height dashboard / group summary card: title, main value, optional metrics and breakdown.
 */
export function DetailedGroupCard({
  title,
  titleTo,
  titleColorRgb,
  value,
  unit,
  animated = true,
  valueDelta,
  metrics,
  breakdown,
  className,
  outerClassName = "card card--detail card--detail-stretch",
  fxMissing = false,
  syncStale = false,
}: DetailedGroupCardProps) {
  return (
    <div className={cn(outerClassName, className)}>
      <DashboardCardTitleRow label={title} titleTo={titleTo} colorRgb={titleColorRgb} />
      <div className="value">
        <DashboardCardValue
          flashOnChange
          value={value}
          unit={unit}
          animated={animated}
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
