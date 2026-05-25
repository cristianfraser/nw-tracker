import type { ReactNode } from "react";
import { cn } from "../../cn";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

export type PortfolioEntityCardsStripProps = {
  /** Hero row (e.g. net worth `CompactEntityCard`). */
  compactSlot: ReactNode;
  /** Row 2: detailed group cards. Omitted when empty — no spacer for this row. */
  detailSlots?: ReactNode;
  /** Row 3: compact account-leaf cards. */
  accountCompactSlots?: ReactNode;
  /** When true, wraps in `DashboardCardsValueGroup` for shared number-flow context. */
  wrapValueGroup?: boolean;
  /** Extra classes on the compact strip shell (e.g. `card--cash`). */
  compactStripClassName?: string;
};

/**
 * Dashboard-style card strip: compact parent (row 1), optional detailed group children (row 2),
 * optional compact account leaves (row 3). Same CSS grid as the home dashboard.
 */
export function PortfolioEntityCardsStrip({
  compactSlot,
  detailSlots,
  accountCompactSlots,
  wrapValueGroup = true,
  compactStripClassName,
}: PortfolioEntityCardsStripProps) {
  const hasDetails = detailSlots != null && detailSlots !== false;
  const hasAccountCompacts =
    accountCompactSlots != null && accountCompactSlots !== false;
  const showRow1Spacer = hasDetails || hasAccountCompacts;
  const compactShell = cn(
    "portfolio-strip-compact",
    "card",
    "card--detail",
    "card--detail-compact",
    "card--detail-stretch",
    "card--dashboard-net-worth",
    compactStripClassName,
  );
  const inner = (
    <div className="cards">
      <div className={compactShell}>{compactSlot}</div>
      {showRow1Spacer ? <div className="row-spacer" aria-hidden="true" /> : null}
      {hasDetails ? detailSlots : null}
      {hasDetails && hasAccountCompacts ? (
        <div className="portfolio-strip-section-break" aria-hidden="true" />
      ) : null}
      {hasAccountCompacts ? accountCompactSlots : null}
    </div>
  );
  if (wrapValueGroup) return <DashboardCardsValueGroup>{inner}</DashboardCardsValueGroup>;
  return inner;
}
