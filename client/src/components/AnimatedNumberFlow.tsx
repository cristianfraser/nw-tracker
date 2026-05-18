import NumberFlow, { type NumberFlowElement } from "@number-flow/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { NUMBER_FLOW_INT_FORMAT } from "../format";

const MOUNT_STORAGE_PREFIX = "nw:numberFlowMount:";
const DEFAULT_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";

export type AnimatedNumberFlowMapResult = {
  value: number;
  prefix?: string;
  suffix?: string;
  locales?: string;
  format?: typeof NUMBER_FLOW_INT_FORMAT;
};

type NumberFlowPassthrough = Omit<
  ComponentPropsWithoutRef<typeof NumberFlow>,
  "value" | "animated" | "prefix" | "suffix" | "locales" | "format"
>;

type BaseProps = NumberFlowPassthrough & {
  /** Target value (signed); mount seed + localStorage use this number. */
  value: number | null;
  animated?: boolean;
  mapDisplayValue: (displayValue: number) => AnimatedNumberFlowMapResult;
  className?: string;
  wrapClassName?: string;
  /** Opacity fade duration on first mount reveal (ms). */
  mountDuration?: number;
  emptyFallback?: ReactNode;
};

type MountSeedProps =
  | {
      /** Inclusive min/max digit count for the random mount seed. Requires `mountSeedId`. */
      mountSeedDigitRange: [number, number];
      mountSeedId: string;
    }
  | {
      mountSeedDigitRange?: undefined;
      mountSeedId?: undefined;
    };

export type AnimatedNumberFlowProps = BaseProps & MountSeedProps;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomWithDigitCount(digits: number): number {
  const d = Math.max(1, Math.min(15, Math.trunc(digits)));
  const min = 10 ** (d - 1);
  const max = 10 ** d - 1;
  return randomInt(min, max);
}

function digitCountAbsRounded(n: number): number {
  const a = Math.abs(Math.round(n));
  if (a === 0) return 1;
  return String(a).length;
}

function readStoredMountValue(mountSeedId: string | undefined): number | null {
  if (!mountSeedId || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(MOUNT_STORAGE_PREFIX + mountSeedId);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function persistMountValue(mountSeedId: string | undefined, value: number): void {
  if (!mountSeedId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MOUNT_STORAGE_PREFIX + mountSeedId, String(Math.round(value)));
  } catch {
    /* quota / private mode */
  }
}

function mountSeedFresh(digitRange: [number, number]): number {
  const [minDigits, maxDigits] = digitRange;
  const lo = Math.max(1, Math.min(minDigits, maxDigits));
  const hi = Math.max(lo, maxDigits);
  return randomWithDigitCount(randomInt(lo, hi));
}

function mountSeedFromStorage(
  digitRange: [number, number],
  mountSeedId: string
): number {
  const prev = readStoredMountValue(mountSeedId);
  if (prev == null || !Number.isFinite(prev)) {
    return mountSeedFresh(digitRange);
  }

  const rounded = Math.round(prev);
  const sign = rounded < 0 ? -1 : 1;
  const a = Math.abs(rounded);
  if (a === 0) {
    return mountSeedFresh(digitRange);
  }

  const d = digitCountAbsRounded(rounded);
  const lb = 10 ** (d - 1);
  const ub = Math.min(10 ** d - 1, Math.max(lb, a - 1));
  if (ub >= lb) {
    const r = randomInt(lb, ub);
    if (r < a) {
      return sign * r;
    }
  }
  return mountSeedFresh(digitRange);
}

function useMountAnimation(
  target: number | null,
  animated: boolean,
  mountSeedDigitRange: [number, number] | undefined,
  mountSeedId: string | undefined
): { displayValue: number | null; opacity: number; mountDuration: number } {
  const mountSeed = useRef<number | null>(null);
  const mountDone = useRef(false);
  const useMountSeed = mountSeedDigitRange != null && mountSeedId != null;
  const mountDuration = 320;

  const initialDisplay = (): number | null => {
    if (target == null || !animated || !useMountSeed) return target;
    if (mountSeed.current == null) {
      mountSeed.current = mountSeedFromStorage(mountSeedDigitRange, mountSeedId);
    }
    return mountSeed.current;
  };

  const [displayValue, setDisplayValue] = useState<number | null>(initialDisplay);
  const [opacity, setOpacity] = useState(() =>
    target != null && animated && useMountSeed ? 0.2 : 1
  );

  useEffect(() => {
    if (useMountSeed && mountSeedId && target != null && Number.isFinite(target) && mountDone.current) {
      persistMountValue(mountSeedId, target);
    }
  }, [useMountSeed, mountSeedId, target]);

  useEffect(() => {
    if (target == null) {
      setDisplayValue(null);
      setOpacity(1);
      return;
    }
    if (!animated) {
      setDisplayValue(target);
      setOpacity(1);
      mountDone.current = true;
      if (useMountSeed && mountSeedId) persistMountValue(mountSeedId, target);
      return;
    }
    if (!useMountSeed) {
      setDisplayValue(target);
      setOpacity(1);
      return;
    }
    if (!mountDone.current) {
      if (mountSeed.current == null) {
        mountSeed.current = mountSeedFromStorage(mountSeedDigitRange!, mountSeedId!);
      }
      setDisplayValue(mountSeed.current);
      setOpacity(0.2);
      const frame = requestAnimationFrame(() => {
        setDisplayValue(target);
        setOpacity(1);
        mountDone.current = true;
        persistMountValue(mountSeedId!, target);
      });
      return () => cancelAnimationFrame(frame);
    }
    setDisplayValue(target);
  }, [target, animated, useMountSeed, mountSeedDigitRange, mountSeedId]);

  return { displayValue, opacity, mountDuration };
}

export const AnimatedNumberFlow = forwardRef<NumberFlowElement, AnimatedNumberFlowProps>(
  function AnimatedNumberFlow(
    {
      value: target,
      animated = true,
      mountSeedDigitRange,
      mountSeedId,
      mapDisplayValue,
      className,
      wrapClassName,
      mountDuration: mountDurationProp,
      emptyFallback,
      transformTiming,
      spinTiming,
      ...rest
    },
    ref
  ) {
    const hostRef = useRef<NumberFlowElement | null>(null);
    useImperativeHandle(ref, () => hostRef.current as NumberFlowElement);

    const { displayValue, opacity, mountDuration } = useMountAnimation(
      target,
      animated,
      mountSeedDigitRange,
      mountSeedId
    );
    const duration = mountDurationProp ?? mountDuration;
    const easing = DEFAULT_EASING;
    const resolvedTransform = transformTiming ?? { duration, easing };
    const resolvedSpin = spinTiming ?? { duration, easing };

    if (displayValue == null) {
      if (emptyFallback != null) return <>{emptyFallback}</>;
      return null;
    }

    const flow = mapDisplayValue(displayValue);

    return (
      <span
        className={wrapClassName}
        style={{
          opacity,
          transition: mountSeedDigitRange ? `opacity ${duration}ms ${easing}` : undefined,
        }}
      >
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
