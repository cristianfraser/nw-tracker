import type { ReactNode } from "react";
import { DashboardCardsValueGroup } from "./DashboardCardValue";

export type PortfolioEntityCardsStripProps = {
  /** Hero row (e.g. net worth `CompactEntityCard`). */
  compactSlot: ReactNode;
  /** Second row: detailed cards (fragment or array). Omitted when empty — no spacer. */
  detailSlots?: ReactNode;
  /** When true, wraps in `DashboardCardsValueGroup` for shared number-flow context. */
  wrapValueGroup?: boolean;
};

/**
 * Dashboard-style two-row card strip: compact summary on row 1 (grid column 1), optional spacer,
 * then detail cards (same CSS grid as home dashboard).
 */
export function PortfolioEntityCardsStrip({
  compactSlot,
  detailSlots,
  wrapValueGroup = true,
}: PortfolioEntityCardsStripProps) {
  const hasDetails = detailSlots != null && detailSlots !== false;
  const inner = (
    <div className="dashboard-cards">
      <div className="portfolio-strip-compact card card--detail card--detail-compact card--detail-stretch card--dashboard-net-worth">
        {compactSlot}
      </div>
      {hasDetails ? (
        <>
          <div className="row-spacer" aria-hidden="true" />
          {detailSlots}
        </>
      ) : null}
    </div>
  );
  if (wrapValueGroup) return <DashboardCardsValueGroup>{inner}</DashboardCardsValueGroup>;
  return inner;
}
