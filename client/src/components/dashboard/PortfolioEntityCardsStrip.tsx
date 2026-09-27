import type { ReactNode } from "react";
import { cn } from "../../cn";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

export type PortfolioEntityCardsStripProps = {
  /** Hero row (e.g. net worth `CompactEntityCard`). */
  compactSlot: ReactNode;
  /** More summary cards beside the hero in row 1, same shell (home: the Inversiones hub). */
  summarySlots?: readonly { key: string; slot: ReactNode }[];
  /** Row 2: detailed group cards. Omitted when empty. */
  detailSlots?: ReactNode;
  /** Full-width accounts summary table under the cards (leaf-bucket pages). */
  accountsTableSlot?: ReactNode;
  /** When true, wraps in `DashboardCardsValueGroup` for shared number-flow context. */
  wrapValueGroup?: boolean;
  /** Extra classes on the compact strip shell (e.g. `card--cash`). */
  compactStripClassName?: string;
};

/** Card chrome of the row-1 summary cards (`CompactEntityCard stripInner` renders inside). */
const SUMMARY_SHELL = cn(
  "portfolio-strip-compact",
  "card",
  "card--detail",
  "card--detail-compact",
  "card--detail-stretch",
  "card--dashboard-net-worth",
);

/**
 * Dashboard-style card strip: summary cards (row 1), optional detailed group children (from row
 * 2 on desktop — see `cards.css`), optional full-width per-account summary table below. Same CSS
 * grid as the home dashboard.
 */
export function PortfolioEntityCardsStrip({
  compactSlot,
  summarySlots = [],
  detailSlots,
  accountsTableSlot,
  wrapValueGroup = true,
  compactStripClassName,
}: PortfolioEntityCardsStripProps) {
  const hasDetails = detailSlots != null && detailSlots !== false;
  const hasAccountsTable = accountsTableSlot != null && accountsTableSlot !== false;
  const cards = (
    <div className="cards">
      <div className={cn(SUMMARY_SHELL, compactStripClassName)}>{compactSlot}</div>
      {summarySlots.map(({ key, slot }) => (
        <div key={key} className={SUMMARY_SHELL}>
          {slot}
        </div>
      ))}
      {hasDetails ? detailSlots : null}
    </div>
  );
  // The table stays OUTSIDE the number-flow group: grouped flows animate in lockstep, and
  // the table's hidden parallel rendering (mobile twin) measures 0-width while coupled,
  // which collapsed zero-valued visible cells to empty digits.
  const table = hasAccountsTable ? (
    <div style={{ marginTop: "0.85rem" }}>{accountsTableSlot}</div>
  ) : null;
  if (wrapValueGroup) {
    return (
      <>
        <DashboardCardsValueGroup>{cards}</DashboardCardsValueGroup>
        {table}
      </>
    );
  }
  return (
    <>
      {cards}
      {table}
    </>
  );
}
