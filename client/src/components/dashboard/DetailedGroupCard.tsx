import type { ReactNode } from "react";
import { cn } from "../../cn";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import { DashboardCardValue } from "./DashboardCardValue";

export type DetailedGroupCardProps = {
  title: string;
  /** When set, title is rendered as a `Link` (see `DashboardCardTitleRow`). */
  titleTo?: string;
  balanceDelta: number | null;
  showUsd: boolean;
  clp: number;
  apiUsd?: number | null;
  cardSlug: string;
  animated?: boolean;
  /** Deposits / Δ rows (e.g. `DashboardCardGroupMetrics`). */
  metrics?: ReactNode;
  /** Breakdown list or other footer content. */
  breakdown?: ReactNode;
  /** Extra classes on the outer `card` wrapper (e.g. `card--cash`). */
  className?: string;
  /** Outer wrapper classes (default: stretched detail card). */
  outerClassName?: string;
};

/**
 * Full-height dashboard / group summary card: title + period Δ, main value, optional metrics and breakdown.
 */
export function DetailedGroupCard({
  title,
  titleTo,
  balanceDelta,
  showUsd,
  clp,
  apiUsd,
  cardSlug,
  animated = true,
  metrics,
  breakdown,
  className,
  outerClassName = "card card--detail card--detail-stretch",
}: DetailedGroupCardProps) {
  return (
    <div className={cn(outerClassName, className)}>
      <DashboardCardTitleRow
        label={title}
        titleTo={titleTo}
        balanceDelta={balanceDelta}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
      />
      <div className="value">
        <DashboardCardValue
          clp={clp}
          apiUsd={apiUsd}
          showUsd={showUsd}
          animated={animated}
          mountSeedKey={cardSlug}
        />
      </div>
      {metrics ? <div>{metrics}</div> : null}
      {breakdown}
    </div>
  );
}
