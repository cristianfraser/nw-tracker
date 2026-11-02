import NumberFlow, { type NumberFlowElement } from "@number-flow/react";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { NUMBER_FLOW_INT_FORMAT } from "../../format";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { NUMBER_CHANGE_FLASH_ENABLED } from "../../numberChangeEffect";
import styles from "./AnimatedNumberFlow.module.css";

/** Restarts the green/red flash on the wrapper: a change before the last one finished starts it over. */
function flash(el: HTMLElement, up: boolean): void {
  el.classList.remove(styles.flashUp!, styles.flashDown!);
  void el.offsetWidth;
  el.classList.add(up ? styles.flashUp! : styles.flashDown!);
}

const DEFAULT_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const DEFAULT_DIGIT_DURATION_MS = 320;

export type NumberFlowFormatOptions = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  signDisplay?: "auto" | "never" | "always" | "exceptZero";
};

export type AnimatedNumberFlowMapResult = {
  value: number;
  prefix?: string;
  suffix?: string;
  locales?: string;
  format?: typeof NUMBER_FLOW_INT_FORMAT | NumberFlowFormatOptions;
};

type NumberFlowPassthrough = Omit<
  ComponentPropsWithoutRef<typeof NumberFlow>,
  "value" | "animated" | "prefix" | "suffix" | "locales" | "format"
>;

export type AnimatedNumberFlowProps = NumberFlowPassthrough & {
  /**
   * Target value (signed). The first render paints it as it is — a cached placeholder shows
   * its stored number — and every later change spins the digits to the new value.
   */
  value: number | null;
  animated?: boolean;
  mapDisplayValue: (displayValue: number) => AnimatedNumberFlowMapResult;
  className?: string;
  wrapClassName?: string;
  emptyFallback?: ReactNode;
  /**
   * Flash instead of rolling when the value changes in the same display unit after a settled
   * render (`numberChangeEffect.ts`). A unit switch, or a render that was a dimmed placeholder
   * (`.is-loading` around it), keeps `animated`.
   */
  flashOnChange?: boolean;
};

export const AnimatedNumberFlow = forwardRef<NumberFlowElement, AnimatedNumberFlowProps>(
  function AnimatedNumberFlow(
    {
      value,
      animated = true,
      mapDisplayValue,
      className,
      wrapClassName,
      emptyFallback,
      transformTiming,
      spinTiming,
      flashOnChange = false,
      ...rest
    },
    ref
  ) {
    const hostRef = useRef<NumberFlowElement | null>(null);
    useImperativeHandle(ref, () => hostRef.current as NumberFlowElement);
    const wrapRef = useRef<HTMLSpanElement | null>(null);
    const { displayUnit } = useDisplayPreferences();
    const last = useRef<{ shown: string; value: number; unit: string; settled: boolean } | null>(null);

    const flow = value == null ? null : mapDisplayValue(value);
    const shown = flow ? `${flow.prefix ?? ""}|${flow.value}|${flow.suffix ?? ""}` : "";
    const prev = last.current;
    const flashChange =
      flashOnChange &&
      NUMBER_CHANGE_FLASH_ENABLED &&
      flow != null &&
      value != null &&
      prev != null &&
      prev.settled &&
      prev.unit === displayUnit &&
      prev.shown !== shown;

    useLayoutEffect(() => {
      const wrap = wrapRef.current;
      if (flashChange && wrap && prev && value != null) flash(wrap, value > prev.value);
      if (value != null) {
        last.current = { shown, value, unit: displayUnit, settled: wrap != null && wrap.closest(".is-loading") == null };
      }
    });

    const resolvedTransform = transformTiming ?? {
      duration: DEFAULT_DIGIT_DURATION_MS,
      easing: DEFAULT_EASING,
    };
    const resolvedSpin = spinTiming ?? { duration: DEFAULT_DIGIT_DURATION_MS, easing: DEFAULT_EASING };

    if (flow == null) {
      if (emptyFallback != null) return <>{emptyFallback}</>;
      return null;
    }

    return (
      <span ref={wrapRef} className={wrapClassName}>
        <NumberFlow
          ref={hostRef}
          className={className}
          value={flow.value}
          animated={flashChange ? false : animated}
          locales={flow.locales}
          format={flow.format}
          prefix={flow.prefix}
          suffix={flow.suffix}
          transformTiming={resolvedTransform}
          spinTiming={resolvedSpin}
          {...rest}
        />
      </span>
    );
  }
);
