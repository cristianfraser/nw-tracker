import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../../cn";
import { useChartStyle } from "../charts/chartStyle";
// The hand-drawn chart styles colour a pill in with a scribble instead of a flat fill. Imported
// directly, not lazily: a lazy load painted every pill bare on a page load until its chunk
// arrived (the sketch code it needs already ships with the first page load).
import PillScribble from "../charts/PillScribble";
import styles from "./Pill.module.css";

export type PillSize = "default" | "small" | "icon";

export type PillProps = {
  /** Primary text (ignored when `children` is set). */
  label?: string;
  children?: ReactNode;
  /** Optional prefix (e.g. single-letter badge). Hidden when `size="small"`. */
  leading?: ReactNode;
  size?: PillSize;
  /** When true, label uses uppercase (default for non-icon sizes). */
  uppercase?: boolean;
  backgroundColor?: string;
  hoverBackgroundColor?: string;
  textColor?: string;
  className?: string;
  /** Shows an × on hover (decorative); use `onClick` on the pill to handle the action. */
  clearable?: boolean;
  onMouseEnter?: (e: MouseEvent<HTMLSpanElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLSpanElement>) => void;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

/**
 * Compact inline label badge. Supports optional leading glyph, custom colors, and hover tint.
 */
export function Pill({
  label,
  children,
  leading,
  size = "default",
  uppercase,
  backgroundColor,
  hoverBackgroundColor,
  textColor,
  className,
  style,
  clearable,
  onClick,
  onMouseEnter,
  onMouseLeave,
  ...rest
}: PillProps) {
  const sketched = useChartStyle() !== "plain";
  const ref = useRef<HTMLSpanElement | null>(null);
  const [sketch, setSketch] = useState<{ w: number; h: number; color: string } | null>(null);

  // Measure the pill and take its colour (the prop, else the CSS --pill-bg it would paint).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!sketched || !el) {
      setSketch(null);
      return;
    }
    const read = () => {
      const color =
        backgroundColor ||
        getComputedStyle(el).getPropertyValue("--pill-bg").trim() ||
        getComputedStyle(document.documentElement).getPropertyValue("--surface2").trim() ||
        "#475569";
      setSketch({ w: el.offsetWidth, h: el.offsetHeight, color });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sketched, backgroundColor]);

  const hoverable = Boolean(onMouseEnter || hoverBackgroundColor || onClick);
  const showLeading = leading != null && size !== "small";
  const showLabel = size !== "icon" && (children != null || label != null);
  const isUppercase = uppercase ?? size !== "icon";

  const baseStyle: CSSProperties = {
    ...style,
    ...(backgroundColor && !sketched ? { backgroundColor } : null),
    ...(textColor ? { color: textColor } : null),
  };

  return (
    <span
      {...rest}
      ref={ref}
      className={cn(
        styles.pill,
        sketched && styles.sketched,
        styles[size],
        isUppercase && styles.uppercase,
        hoverable && styles.hoverable,
        onClick && styles.clickable,
        className
      )}
      style={baseStyle}
      // Stays a <span> (pills render inside links/labels where <button> nesting is invalid),
      // so clickable pills need explicit button semantics for keyboard/screen-reader users.
      role={onClick ? (rest.role ?? "button") : rest.role}
      tabIndex={onClick ? (rest.tabIndex ?? 0) : rest.tabIndex}
      onKeyDown={(e) => {
        rest.onKeyDown?.(e);
        if (!onClick || e.defaultPrevented) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick(e as unknown as MouseEvent<HTMLSpanElement>);
        }
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (hoverBackgroundColor && !sketched) {
          e.currentTarget.style.backgroundColor = hoverBackgroundColor;
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hoverBackgroundColor && backgroundColor && !sketched) {
          e.currentTarget.style.backgroundColor = backgroundColor;
        }
        onMouseLeave?.(e);
      }}
    >
      {sketched && sketch ? (
        <PillScribble w={sketch.w} h={sketch.h} color={sketch.color} />
      ) : null}
      {showLeading ? (
        <span className={cn(styles.leading, showLabel && styles.leadingWithLabel)}>{leading}</span>
      ) : null}
      {showLabel ? <span>{children ?? label}</span> : null}
      {clearable ? (
        <span className={styles.clearAction} aria-hidden>
          ×
        </span>
      ) : null}
    </span>
  );
}
