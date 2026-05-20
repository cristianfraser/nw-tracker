import type { CardBreakdownLine } from "../dashboardCardBreakdown";
import { DashboardCardValue } from "./DashboardCardValue";
import styles from "./DashboardCardBreakdown.module.css";

type Props = {
  lines: CardBreakdownLine[];
  showUsd: boolean;
  cardSlug: string;
  animated?: boolean;
  bottomLines?: CardBreakdownLine[];
  /** Pin `bottomLines` to the card footer (direct flex child + margin-top: auto). */
  pinBottomToCard?: boolean;
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
    <ul className={className ? `${styles.root} ${className}` : styles.root}>
      {lines.map((line, i) => (
        <li
          key={`${rowKeyPrefix}-${line.depth}-${line.label}-${i}`}
          className={
            line.depth >= 2 ? styles.grandchild : line.depth === 1 ? styles.child : styles.group
          }
        >
          <span className={styles.label}>{line.label}</span>
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
  pinBottomToCard = false,
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

  if (pinBottomToCard) {
    return (
      <>
        {hasMain ? (
          <BreakdownList
            lines={lines}
            showUsd={showUsd}
            cardSlug={cardSlug}
            animated={animated}
            rowKeyPrefix="main"
          />
        ) : null}
        <div className="card-breakdown-spacer" aria-hidden />
        <BreakdownList
          lines={bottomLines!}
          showUsd={showUsd}
          cardSlug={cardSlug}
          animated={animated}
          className="card-breakdown-bottom"
          rowKeyPrefix="bottom"
        />
      </>
    );
  }

  return (
    <div className={styles.stack}>
      <BreakdownList
        lines={lines}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
        rowKeyPrefix="main"
      />
      <BreakdownList
        lines={bottomLines!}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
        className={styles.bottom}
        rowKeyPrefix="bottom"
      />
    </div>
  );
}

