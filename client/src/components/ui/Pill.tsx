import {
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../../cn";
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
  const hoverable = Boolean(onMouseEnter || hoverBackgroundColor || onClick);
  const showLeading = leading != null && size !== "small";
  const showLabel = size !== "icon" && (children != null || label != null);
  const isUppercase = uppercase ?? size !== "icon";

  const baseStyle: CSSProperties = {
    ...style,
    ...(backgroundColor ? { backgroundColor } : null),
    ...(textColor ? { color: textColor } : null),
  };

  return (
    <span
      {...rest}
      className={cn(
        styles.pill,
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
        if (hoverBackgroundColor) {
          e.currentTarget.style.backgroundColor = hoverBackgroundColor;
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hoverBackgroundColor && backgroundColor) {
          e.currentTarget.style.backgroundColor = backgroundColor;
        }
        onMouseLeave?.(e);
      }}
    >
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
