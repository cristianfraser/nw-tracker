import type { ReactNode } from "react";
import { cn } from "../../cn";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

export type PortfolioEntityCardsStripProps = {
  /** Hero row (e.g. net worth `CompactEntityCard`); null when the accounts table carries it. */
  compactSlot: ReactNode | null;
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
  /** Hide the strip from assistive tech (the nameless placeholder strip). */
  ariaHidden?: boolean;
};

/** Shell of the row-1 summary cards (a `CompactEntityCard` renders inside). */
const SUMMARY_SHELL = cn("card", "card--detail", "card--detail-stretch");

/**
 * Dashboard-style card strip: one `.cards-strip` holding the summary block (row 1) over the
 * detail block (the detailed group children, present only when there are any) — two `.cards`
 * grids on the page's columns, separated by one hairline (`cards.css`) — then, as its own
 * sibling, the optional full-width per-account summary table. Same grid as the home dashboard.
 */
export function PortfolioEntityCardsStrip({
  compactSlot,
  summarySlots = [],
  detailSlots,
  accountsTableSlot,
  wrapValueGroup = true,
  compactStripClassName,
  ariaHidden = false,
}: PortfolioEntityCardsStripProps) {
  const hasDetails = detailSlots != null && detailSlots !== false;
  const hasAccountsTable = accountsTableSlot != null && accountsTableSlot !== false;
  const hasCompact = compactSlot != null && compactSlot !== false;
  const hasSummary = hasCompact || summarySlots.length > 0;
  const cards = !hasSummary && !hasDetails ? null : (
    <div className="cards-strip" aria-hidden={ariaHidden || undefined}>
      {hasSummary ? (
        <div className="cards cards--summary">
          {hasCompact ? (
            <div className={cn(SUMMARY_SHELL, compactStripClassName)}>{compactSlot}</div>
          ) : null}
          {summarySlots.map(({ key, slot }) => (
            <div key={key} className={SUMMARY_SHELL}>
              {slot}
            </div>
          ))}
        </div>
      ) : null}
      {hasDetails ? <div className="cards cards--detail">{detailSlots}</div> : null}
    </div>
  );
  // The table stays OUTSIDE the number-flow group: grouped flows animate in lockstep, and
  // the table's hidden parallel rendering (mobile twin) measures 0-width while coupled,
  // which collapsed zero-valued visible cells to empty digits.
  const table = hasAccountsTable ? (
    <div className="cards-strip__table">{accountsTableSlot}</div>
  ) : null;
  if (wrapValueGroup) {
    return (
      <>
        {cards ? <DashboardCardsValueGroup>{cards}</DashboardCardsValueGroup> : null}
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
