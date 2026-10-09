import type { ReactNode } from "react";
import { cn } from "../../cn";
import type { ColdStripShape } from "../../coldPageShape";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import compactStyles from "./CompactEntityCard.module.css";
import metricStyles from "./CardGroupMetrics.module.css";
import styles from "./PlaceholderCardsStrip.module.css";

/** Non-breaking space: an element with the real text's height and nothing to read. */
const BLANK = "\u00A0";

function BlankMetricRow() {
  return (
    <div className={metricStyles.row}>
      <span className={metricStyles.deposited}>
        <span className={cn(metricStyles.amount, styles.blankMetric, "mono")}>{BLANK}</span>
      </span>
    </div>
  );
}

/** Blank counterpart of the card's title row, balance row and month / year / total metric rows. */
function BlankCardRows({ titled }: { titled: boolean }) {
  return (
    <>
      {titled ? <DashboardCardTitleRow label={BLANK} /> : null}
      <div className="value mono">
        <span className={cn("mono", styles.blankValue)}>{BLANK}</span>
      </div>
      <div>
        <div className={metricStyles.root}>
          <BlankMetricRow />
          <BlankMetricRow />
          <span className={metricStyles.divider} aria-hidden="true" />
          <BlankMetricRow />
        </div>
      </div>
    </>
  );
}

function summaryCard(titled: boolean): ReactNode {
  return (
    <div className={cn(compactStyles.root, compactStyles.rootStripInner)}>
      <BlankCardRows titled={titled} />
    </div>
  );
}

/**
 * Nameless card skeleton for a first-ever visit, before any nav tree is known: the strip's own
 * layout (`PortfolioEntityCardsStrip` — same grid, same card shells) with blank titles, values
 * and metric rows. Purely visual — it shows no data and passes no nodes to the nav-card lookups.
 * Beside other summary cards each is titled, as the real strip titles them, so the rows line up.
 */
export function PlaceholderCardsStrip({ summary, detail }: ColdStripShape) {
  if (summary < 1) return null;
  const titled = summary > 1;
  const extraSummary = Array.from({ length: summary - 1 }, (_, i) => ({
    key: `summary-${i + 1}`,
    slot: summaryCard(titled),
  }));
  const detailSlots =
    detail > 0
      ? Array.from({ length: detail }, (_, i) => (
          <div key={`detail-${i}`} className="card card--detail card--detail-stretch">
            <BlankCardRows titled />
          </div>
        ))
      : null;
  return (
    <div style={{ marginTop: "0.85rem" }} aria-hidden="true">
      <PortfolioEntityCardsStrip
        compactSlot={summaryCard(titled)}
        summarySlots={extraSummary}
        detailSlots={detailSlots}
        wrapValueGroup={false}
      />
    </div>
  );
}
