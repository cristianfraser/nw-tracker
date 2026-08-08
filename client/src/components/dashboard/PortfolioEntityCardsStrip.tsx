import type { ReactNode } from "react";
import { cn } from "../../cn";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

export type PortfolioEntityCardsStripProps = {
  /** Hero row (e.g. net worth `CompactEntityCard`). */
  compactSlot: ReactNode;
  /** Row 2: detailed group cards. Omitted when empty — no spacer for this row. */
  detailSlots?: ReactNode;
  /** Full-width accounts summary table under the cards (leaf-bucket pages). */
  accountsTableSlot?: ReactNode;
  /** When true, wraps in `DashboardCardsValueGroup` for shared number-flow context. */
  wrapValueGroup?: boolean;
  /** Extra classes on the compact strip shell (e.g. `card--cash`). */
  compactStripClassName?: string;
};

/**
 * Dashboard-style card strip: compact parent (row 1), optional detailed group children (row 2),
 * optional full-width per-account summary table below. Same CSS grid as the home dashboard.
 */
export function PortfolioEntityCardsStrip({
  compactSlot,
  detailSlots,
  accountsTableSlot,
  wrapValueGroup = true,
  compactStripClassName,
}: PortfolioEntityCardsStripProps) {
  const hasDetails = detailSlots != null && detailSlots !== false;
  const hasAccountsTable = accountsTableSlot != null && accountsTableSlot !== false;
  const compactShell = cn(
    "portfolio-strip-compact",
    "card",
    "card--detail",
    "card--detail-compact",
    "card--detail-stretch",
    "card--dashboard-net-worth",
    compactStripClassName,
  );
  const cards = (
    <div className="cards">
      <div className={compactShell}>{compactSlot}</div>
      {hasDetails ? <div className="row-spacer" aria-hidden="true" /> : null}
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
