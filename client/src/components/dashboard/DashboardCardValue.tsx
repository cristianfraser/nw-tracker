import { NumberFlowElement, NumberFlowGroup } from "@number-flow/react";
import { useEffect, useRef, type ReactNode } from "react";
import { adaptiveAccountingNumberFlowParts, roundCardValue } from "../../format";
import type { DisplayUnit } from "../../queries/keys";
import { useTranslation } from "../../i18n";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
import { cn } from "../../cn";
import styles from "./DashboardCardValue.module.css";

export type DashboardCardValueVariant = "main" | "breakdown";

const EASING = "cubic-bezier(0.33, 1, 0.68, 1)";

const VARIANT_TIMING: Record<
  DashboardCardValueVariant,
  { duration: number; transformTiming: { duration: number; easing: string }; spinTiming: { duration: number; easing: string } }
> = {
  main: {
    duration: 550,
    transformTiming: { duration: 550, easing: EASING },
    spinTiming: { duration: 550, easing: EASING },
  },
  breakdown: {
    duration: 320,
    transformTiming: { duration: 320, easing: EASING },
    spinTiming: { duration: 320, easing: EASING },
  },
};

const ALIGN_STYLE: Record<DashboardCardValueVariant, { id: string; css: string }> = {
  main: {
    id: "nw-number-flow-left-align",
    css: `
.number,
.number__inner {
  transform-origin: left top !important;
}
.section--justify-right,
.section--justify-left {
  transform-origin: left center !important;
}
.digit__num[inert] {
  left: 0 !important;
  right: auto !important;
  transform: translateX(0) translateY(var(--y)) !important;
}
.section--justify-right .symbol > [inert],
.section--justify-left .symbol > [inert] {
  left: 0 !important;
  right: auto !important;
}
`,
  },
  breakdown: {
    id: "nw-number-flow-right-align",
    css: `
.number,
.number__inner {
  transform-origin: right top !important;
}
.section--justify-right,
.section--justify-left {
  transform-origin: right center !important;
}
.digit__num[inert] {
  left: auto !important;
  right: 0 !important;
  transform: translateX(0) translateY(var(--y)) !important;
}
.section--justify-right .symbol > [inert],
.section--justify-left .symbol > [inert] {
  left: auto !important;
  right: 0 !important;
}
`,
  },
};

function injectAlignStyles(host: NumberFlowElement | null, variant: DashboardCardValueVariant) {
  const root = host?.shadowRoot;
  const { id, css } = ALIGN_STYLE[variant];
  if (!root || root.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  root.appendChild(style);
}

type Props = {
  /** The value in `unit`; null = none on file (an em dash, or `!` when `fxMissing`). */
  value: number | null;
  unit: DisplayUnit;
  animated?: boolean;
  variant?: DashboardCardValueVariant;
  /** When true and there is no value, show a conversion error instead of an em dash. */
  fxMissing?: boolean;
  /** Lower opacity when linked sync source(s) are stale. */
  syncStale?: boolean;
  /**
   * Fixed decimals for card sub-balance lists in a currency with minor units — parent passes the
   * max adaptive need across siblings so the column aligns. Omit → adaptive (main balances).
   */
  fractionDigits?: 0 | 1 | 2;
  /** Flash green/red when the value changes while the page is open (`AnimatedNumberFlow`); off = rolling digits. */
  flashOnChange?: boolean;
};

export function DashboardCardValue({
  value,
  unit,
  animated = true,
  variant = "main",
  fxMissing = false,
  syncStale = false,
  fractionDigits,
  flashOnChange,
}: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<NumberFlowElement | null>(null);
  // Sub-balance lists pin decimals so sibling rows align; main balances adapt to magnitude
  // (cents below 100, tenths below 1.000); a currency without minor units is whole.
  const target = value != null && Number.isFinite(value) ? roundCardValue(value, unit, fractionDigits) : null;
  const { transformTiming, spinTiming } = VARIANT_TIMING[variant];
  const isMain = variant === "main";

  useEffect(() => {
    injectAlignStyles(hostRef.current, variant);
  }, [variant]);

  const wrapClass = isMain
    ? `${styles.wrap} ${styles.wrapMain} dashboard-card-value dashboard-card-value--main${syncStale ? ` ${styles.syncStale}` : ""}`
    : `${styles.wrap} ${styles.wrapBreakdown} dashboard-card-value dashboard-card-value--breakdown${syncStale ? ` ${styles.syncStale}` : ""}`;
  const valueClass = isMain
    ? `${styles.value} ${styles.valueMain} mono`
    : `${styles.value} ${styles.valueBreakdown} mono`;

  return (
    <AnimatedNumberFlow
      ref={(el) => {
        hostRef.current = el;
        if (el) injectAlignStyles(el, variant);
      }}
      value={target}
      animated={animated}
      flashOnChange={flashOnChange}
      unit={unit}
      mapDisplayValue={(n) => adaptiveAccountingNumberFlowParts(n, unit, "bare", fractionDigits)}
      wrapClassName={wrapClass}
      className={valueClass}
      transformTiming={transformTiming}
      spinTiming={spinTiming}
      emptyFallback={
        fxMissing ? (
          <span
            className={cn(valueClass, styles.valueEmpty, "dashboard-card-value-empty", styles.valueFxError)}
            title={t("fxCoverage.cardMissingFx")}
          >
            !
          </span>
        ) : (
          <span className={cn(valueClass, styles.valueEmpty, "dashboard-card-value-empty")}>—</span>
        )
      }
    />
  );
}

export function DashboardCardsValueGroup({ children }: { children: ReactNode }) {
  return <NumberFlowGroup>{children}</NumberFlowGroup>;
}
