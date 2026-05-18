import type { CardBreakdownLine } from "../dashboardCardBreakdown";
import { DashboardCardValue } from "./DashboardCardValue";

type Props = {
  lines: CardBreakdownLine[];
  showUsd: boolean;
  /** Stable slug for this card (e.g. `net_worth`) — used in mount seed localStorage keys. */
  cardSlug: string;
  /** Set false while currency data is loading to avoid animating from stale values. */
  animated?: boolean;
  /** Pinned to the bottom of a stretched detail card (e.g. tarjeta de crédito on cash). */
  bottomLines?: CardBreakdownLine[];
};

function BreakdownList({
  lines,
  showUsd,
  cardSlug,
  animated,
  className,
  rowKeyPrefix,
}: {
  lines: CardBreakdownLine[];
  showUsd: boolean;
  cardSlug: string;
  animated: boolean;
  className?: string;
  rowKeyPrefix: string;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className={className ? `card-breakdown ${className}` : "card-breakdown"}>
      {lines.map((line, i) => (
        <li
          key={`${rowKeyPrefix}-${line.depth}-${line.label}-${i}`}
          className={
            line.depth >= 2
              ? "card-breakdown__grandchild"
              : line.depth === 1
                ? "card-breakdown__child"
                : "card-breakdown__group"
          }
        >
          <span className="card-breakdown__label">{line.label}</span>
          <span className="card-breakdown__amount mono">
            <DashboardCardValue
              clp={line.clp}
              apiUsd={line.usd}
              showUsd={showUsd}
              animated={animated}
              variant="breakdown"
              mountSeedKey={`${cardSlug}:${rowKeyPrefix}:${i}`}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DashboardCardBreakdown({
  lines,
  showUsd,
  cardSlug,
  animated = true,
  bottomLines,
}: Props) {
  const hasMain = lines.length > 0;
  const hasBottom = (bottomLines?.length ?? 0) > 0;
  if (!hasMain && !hasBottom) return null;

  if (!hasBottom) {
    return (
      <BreakdownList
        lines={lines}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
        rowKeyPrefix="row"
      />
    );
  }

  return (
    <div className="card-breakdown-stack">
      {hasMain ? (
        <BreakdownList
          lines={lines}
          showUsd={showUsd}
          cardSlug={cardSlug}
          animated={animated}
          rowKeyPrefix="row"
        />
      ) : null}
      <BreakdownList
        lines={bottomLines!}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
        className="card-breakdown--bottom"
        rowKeyPrefix="bottom"
      />
    </div>
  );
}
