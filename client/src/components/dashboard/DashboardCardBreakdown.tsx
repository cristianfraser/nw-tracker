import { Link } from "react-router-dom";
import {
  nestCardBreakdownLines,
  type CardBreakdownLine,
  type CardBreakdownNode,
} from "../../dashboardCardBreakdown";
import { DashboardCardValue } from "./DashboardCardValue";
import { cn } from "../../cn";
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

function BreakdownAmount({
  node,
  showUsd,
  animated,
  mountSeedKey,
  muted,
}: {
  node: CardBreakdownNode;
  showUsd: boolean;
  animated: boolean;
  mountSeedKey: string;
  muted: boolean;
}) {
  const amount = (
    <span className={cn("card-breakdown__amount", "mono", muted && "card-breakdown__amount--muted")}>
      <DashboardCardValue
        clp={node.clp}
        apiUsd={node.usd}
        showUsd={showUsd}
        animated={animated}
        variant="breakdown"
        mountSeedKey={mountSeedKey}
      />
    </span>
  );
  if (!node.to) return amount;
  return (
    <Link to={node.to} className={styles.amountLink}>
      {amount}
    </Link>
  );
}

function BreakdownNodeRow({
  node,
  showUsd,
  cardSlug,
  animated,
  depth,
  index,
  rowKeyPrefix,
}: {
  node: CardBreakdownNode;
  showUsd: boolean;
  cardSlug: string;
  animated: boolean;
  depth: number;
  index: number;
  rowKeyPrefix: string;
}) {
  const isGroup = depth === 0;
  /** One account leaf under a group: show the group total only (same as brokerage “Fondos mutuos”). */
  const soleChild = node.children.length === 1 ? node.children[0]! : null;
  const hideOnlyChild =
    soleChild != null &&
    soleChild.children.length === 0 &&
    Boolean(soleChild.to?.startsWith("/account/"));
  const liClass = isGroup ? styles.group : styles.child;
  const mountSeedKey = `${cardSlug}:${rowKeyPrefix}:${depth}:${index}:${node.label}`;
  const label = node.to ? (
    <Link to={node.to} className={styles.labelLink}>
      {node.label}
    </Link>
  ) : (
    <span className={styles.label}>{node.label}</span>
  );

  return (
    <li className={liClass}>
      <div className={styles.row}>
        {label}
        <BreakdownAmount
          node={node}
          showUsd={showUsd}
          animated={animated}
          mountSeedKey={mountSeedKey}
          muted={!isGroup}
        />
      </div>
      {node.children.length > 0 && !hideOnlyChild ? (
        <ul className={styles.nested}>
          {node.children.map((child, j) => (
            <BreakdownNodeRow
              key={`${rowKeyPrefix}-${depth + 1}-${child.label}-${j}`}
              node={child}
              showUsd={showUsd}
              cardSlug={cardSlug}
              animated={animated}
              depth={depth + 1}
              index={j}
              rowKeyPrefix={rowKeyPrefix}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

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
  const items = nestCardBreakdownLines(lines);
  if (items.length === 0) return null;
  return (
    <ul className={cn("card-breakdown-root", styles.root, className)}>
      {items.map((node, i) => (
        <BreakdownNodeRow
          key={`${rowKeyPrefix}-0-${node.label}-${i}`}
          node={node}
          showUsd={showUsd}
          cardSlug={cardSlug}
          animated={animated}
          depth={0}
          index={i}
          rowKeyPrefix={rowKeyPrefix}
        />
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
