import NumberFlow, { type NumberFlowElement } from "@number-flow/react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { NUMBER_FLOW_INT_FORMAT } from "../../format";

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
      ...rest
    },
    ref
  ) {
    const hostRef = useRef<NumberFlowElement | null>(null);
    useImperativeHandle(ref, () => hostRef.current as NumberFlowElement);

    const resolvedTransform = transformTiming ?? {
      duration: DEFAULT_DIGIT_DURATION_MS,
      easing: DEFAULT_EASING,
    };
    const resolvedSpin = spinTiming ?? { duration: DEFAULT_DIGIT_DURATION_MS, easing: DEFAULT_EASING };

    if (value == null) {
      if (emptyFallback != null) return <>{emptyFallback}</>;
      return null;
    }

    const flow = mapDisplayValue(value);

    return (
      <span className={wrapClassName}>
        <NumberFlow
          ref={hostRef}
          className={className}
          value={flow.value}
          animated={animated}
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
