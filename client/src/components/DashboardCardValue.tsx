import { NumberFlowElement, NumberFlowGroup } from "@number-flow/react";
import { useEffect, useRef, type ReactNode } from "react";
import { accountingCurrencyNumberFlowParts } from "../format";
import { AnimatedNumberFlow } from "./AnimatedNumberFlow";
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

const MOUNT_DIGIT_RANGE: Record<DashboardCardValueVariant, [number, number]> = {
  main: [6, 9],
  breakdown: [5, 7],
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

function resolvedAmount(clp: number, apiUsd: number | null | undefined, showUsd: boolean): number | null {
  if (showUsd) {
    if (apiUsd != null && Number.isFinite(apiUsd)) return Math.round(apiUsd);
    return null;
  }
  return Math.round(clp);
}

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
  clp: number;
  apiUsd?: number | null;
  showUsd: boolean;
  animated?: boolean;
  variant?: DashboardCardValueVariant;
  mountSeedKey?: string;
};

export function DashboardCardValue({
  clp,
  apiUsd,
  showUsd,
  animated = true,
  variant = "main",
  mountSeedKey,
}: Props) {
  const hostRef = useRef<NumberFlowElement | null>(null);
  const target = resolvedAmount(clp, apiUsd, showUsd);
  const { duration, transformTiming, spinTiming } = VARIANT_TIMING[variant];
  const flowUnit = showUsd ? "usd" : "clp";
  const isMain = variant === "main";

  useEffect(() => {
    injectAlignStyles(hostRef.current, variant);
  }, [variant]);

  const mountProps = mountSeedKey
    ? { mountSeedDigitRange: MOUNT_DIGIT_RANGE[variant], mountSeedId: mountSeedKey }
    : {};

  const wrapClass = isMain
    ? `${styles.wrap} ${styles.wrapMain} dashboard-card-value dashboard-card-value--main`
    : `${styles.wrap} ${styles.wrapBreakdown} dashboard-card-value dashboard-card-value--breakdown`;
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
      {...mountProps}
      mapDisplayValue={(n) => accountingCurrencyNumberFlowParts(n, flowUnit, "$")}
      wrapClassName={wrapClass}
      className={valueClass}
      mountDuration={duration}
      transformTiming={transformTiming}
      spinTiming={spinTiming}
      emptyFallback={
        <span className={`${valueClass} ${styles.valueEmpty} dashboard-card-value-empty`}>—</span>
      }
    />
  );
}

export function DashboardCardsValueGroup({ children }: { children: ReactNode }) {
  return <NumberFlowGroup>{children}</NumberFlowGroup>;
}
