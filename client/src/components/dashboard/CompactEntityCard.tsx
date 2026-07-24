import type { ReactNode } from "react";
import type { DashboardCardValueVariant } from "./DashboardCardValue";
import { DashboardCardValue } from "./DashboardCardValue";
import { DashboardCardTitleRow } from "./DashboardCardTitleRow";
import { cn } from "../../cn";
import styles from "./CompactEntityCard.module.css";

export type CompactEntityCardProps = {
  /** Omit to render only the Δ + value (e.g. the hero card, whose name repeats the page title). */
  label?: string;
  /** When set, label is rendered as a `Link`. */
  to?: string;
  balanceDelta?: number | null;
  showUsd: boolean;
  clp: number;
  apiUsd?: number | null;
  cardSlug: string;
  animated?: boolean;
  placeholderPhase?: boolean;
  fxMissing?: boolean;
  /** Lower opacity when linked sync source(s) are stale. */
  syncStale?: boolean;
  subtitle?: ReactNode;
  /** Deposits / Δ rows (e.g. `DashboardCardGroupMetrics`). */
  metrics?: ReactNode;
  /** `main` vs `breakdown`: number-flow alignment / animation (font size is shared). */
  valueVariant?: DashboardCardValueVariant;
  /** When true, no inner border/padding (parent is `portfolio-strip-compact`). */
  stripInner?: boolean;
  /** Optional account list / footer (e.g. cash bucket breakdown). */
  breakdown?: ReactNode;
};

/**
 * Compact summary card (sub-group or account on a class page): title + optional Δ, single value.
 */
export function CompactEntityCard({
  label,
  to,
  balanceDelta = null,
  showUsd,
  clp,
  apiUsd,
  cardSlug,
  animated = true,
  placeholderPhase = false,
  subtitle,
  metrics,
  valueVariant = "breakdown",
  stripInner = false,
  breakdown,
  fxMissing = false,
  syncStale = false,
}: CompactEntityCardProps) {
  return (
    <div
      className={cn(
        styles.root,
        stripInner && styles.rootStripInner,
        breakdown != null && breakdown !== false && styles.rootWithBreakdown
      )}
    >
      <DashboardCardTitleRow
        label={label}
        titleTo={to}
        balanceDelta={balanceDelta ?? null}
        showUsd={showUsd}
        cardSlug={cardSlug}
        animated={animated}
        placeholderPhase={placeholderPhase}
      />
      {subtitle ? <span className="muted" style={{ fontSize: "0.75rem" }}>{subtitle}</span> : null}
      <div className="value mono">
        <DashboardCardValue
          clp={clp}
          apiUsd={apiUsd}
          showUsd={showUsd}
          animated={animated}
          placeholderPhase={placeholderPhase}
          variant={valueVariant}
          mountSeedKey={`${cardSlug}:compact`}
          fxMissing={fxMissing}
          syncStale={syncStale}
        />
      </div>
      {metrics ? <div>{metrics}</div> : null}
      {breakdown}
    </div>
  );
}
