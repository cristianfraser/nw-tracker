import { Link } from "react-router-dom";
import {
  nestCardBreakdownLines,
  type CardBreakdownLine,
  type CardBreakdownNode,
} from "../../dashboardCardBreakdown";
import { DashboardCardValue } from "./DashboardCardValue";
import { currencyHasAdaptiveCardDecimals, minAdaptiveUsdFractionDigits } from "../../format";
import type { DisplayUnit } from "../../queries/keys";
import { cn } from "../../cn";
import styles from "./DashboardCardBreakdown.module.css";

type Props = {
  lines: CardBreakdownLine[];
  unit: DisplayUnit;
  animated?: boolean;
  bottomLines?: CardBreakdownLine[];
  /** Pin `bottomLines` to the card footer (direct flex child + margin-top: auto). */
  pinBottomToCard?: boolean;
};

function BreakdownAmount({
  node,
  unit,
  animated,
  muted,
  usdFractionDigits,
}: {
  node: CardBreakdownNode;
  unit: DisplayUnit;
  animated: boolean;
  muted: boolean;
  usdFractionDigits: 0 | 1 | 2;
}) {
  const amount = (
    <span className={cn("card-breakdown__amount", "mono", muted && "card-breakdown__amount--muted")}>
      <DashboardCardValue
        value={node.value}
        unit={unit}
        animated={animated}
        variant="breakdown"
        fractionDigits={usdFractionDigits}
        flashOnChange
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
  unit,
  animated,
  depth,
  rowKeyPrefix,
  usdFractionDigits,
}: {
  node: CardBreakdownNode;
  unit: DisplayUnit;
  animated: boolean;
  depth: number;
  rowKeyPrefix: string;
  usdFractionDigits: 0 | 1 | 2;
}) {
  const isGroup = depth === 0;
  /** One account leaf under a group: show the group total only (same as brokerage “Fondos mutuos”). */
  const soleChild = node.children.length === 1 ? node.children[0]! : null;
  const hideOnlyChild =
    soleChild != null &&
    soleChild.children.length === 0 &&
    Boolean(soleChild.to?.startsWith("/account/"));
  const liClass = isGroup ? styles.group : styles.child;
  const rowStale = node.sync_stale === true;
  const label = node.to ? (
    <Link to={node.to} className={styles.labelLink}>
      {node.label}
    </Link>
  ) : (
    <span className={styles.label}>{node.label}</span>
  );

  return (
    <li className={liClass}>
      <div className={cn(styles.row, rowStale && styles.rowStale)}>
        {label}
        <BreakdownAmount
          node={node}
          unit={unit}
          animated={animated}
          muted={!isGroup}
          usdFractionDigits={usdFractionDigits}
        />
      </div>
      {node.children.length > 0 && !hideOnlyChild ? (
        <ul className={styles.nested}>
          {node.children.map((child, j) => (
            <BreakdownNodeRow
              key={`${rowKeyPrefix}-${depth + 1}-${child.label}-${j}`}
              node={child}
              unit={unit}
              animated={animated}
              depth={depth + 1}
              rowKeyPrefix={rowKeyPrefix}
              usdFractionDigits={usdFractionDigits}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function BreakdownList({
  lines,
  unit,
  animated,
  className,
  dividerClassName,
  rowKeyPrefix,
  usdFractionDigits,
}: {
  lines: CardBreakdownLine[];
  unit: DisplayUnit;
  animated: boolean;
  className?: string;
  /** The divider above the list (each list opens a section). */
  dividerClassName?: string;
  rowKeyPrefix: string;
  usdFractionDigits: 0 | 1 | 2;
}) {
  const items = nestCardBreakdownLines(lines);
  if (items.length === 0) return null;
  return (
    <>
    <span className={cn("card-divider", dividerClassName)} aria-hidden="true" />
    <ul className={cn("card-breakdown-root", styles.root, className)}>
      {items.map((node, i) => (
        <BreakdownNodeRow
          key={`${rowKeyPrefix}-0-${node.label}-${i}`}
          node={node}
          unit={unit}
          animated={animated}
          depth={0}
          rowKeyPrefix={rowKeyPrefix}
          usdFractionDigits={usdFractionDigits}
        />
      ))}
    </ul>
    </>
  );
}

export function DashboardCardBreakdown({
  lines,
  unit,
  animated = true,
  bottomLines,
  pinBottomToCard = false,
}: Props) {
  const hasMain = lines.length > 0;
  const hasBottom = (bottomLines?.length ?? 0) > 0;
  if (!hasMain && !hasBottom) return null;
  // One decimal count for the whole card (main + bottom rows): the least adaptive
  // decimals across rows, so the largest sub-balance keeps every sibling clean.
  const usdFractionDigits = currencyHasAdaptiveCardDecimals(unit)
    ? minAdaptiveUsdFractionDigits((hasBottom ? [...lines, ...bottomLines!] : lines).map((l) => l.value))
    : 0;

  if (!hasBottom) {
    return (
      <BreakdownList
        lines={lines}
        unit={unit}
        animated={animated}
        rowKeyPrefix="row"
        usdFractionDigits={usdFractionDigits}
      />
    );
  }

  if (pinBottomToCard) {
    return (
      <>
        {hasMain ? (
          <BreakdownList
            lines={lines}
            unit={unit}
            animated={animated}
            rowKeyPrefix="main"
            usdFractionDigits={usdFractionDigits}
          />
        ) : null}
        <div className="card-breakdown-spacer" aria-hidden />
        <BreakdownList
          lines={bottomLines!}
          unit={unit}
          animated={animated}
          className="card-breakdown-bottom"
          dividerClassName="card-breakdown-bottom"
          rowKeyPrefix="bottom"
          usdFractionDigits={usdFractionDigits}
        />
      </>
    );
  }

  return (
    <div className={styles.stack}>
      <BreakdownList
        lines={lines}
        unit={unit}
        animated={animated}
        rowKeyPrefix="main"
        usdFractionDigits={usdFractionDigits}
      />
      <div className={styles.push} aria-hidden />
      <BreakdownList
        lines={bottomLines!}
        unit={unit}
        animated={animated}
        rowKeyPrefix="bottom"
        usdFractionDigits={usdFractionDigits}
      />
    </div>
  );
}
