import { cn } from "../../cn";
import styles from "./FlowPeriodRows.module.css";

/** One stretch of a bar around zero: `amount` is its size (positive). */
export type ZeroBarSegment = { key: string; color: string; amount: number };

/**
 * Signed parts split around zero in the order given: a negative part to the left, a positive one
 * to the right, a zero left out. Segments run outward from zero.
 */
export function zeroBarSides(parts: readonly { key: string; color: string; value: number }[]): {
  left: ZeroBarSegment[];
  right: ZeroBarSegment[];
} {
  const left: ZeroBarSegment[] = [];
  const right: ZeroBarSegment[] = [];
  for (const p of parts) {
    if (p.value < 0) left.push({ key: p.key, color: p.color, amount: -p.value });
    else if (p.value > 0) right.push({ key: p.key, color: p.color, amount: p.value });
  }
  return { left, right };
}

/** How far a bar reaches from zero on its longer side, its mark (a signed value) included. */
export function zeroBarExtent(sides: { left: readonly ZeroBarSegment[]; right: readonly ZeroBarSegment[] }, mark = 0): number {
  const sum = (list: readonly ZeroBarSegment[]) => list.reduce((acc, s) => acc + s.amount, 0);
  return Math.max(sum(sides.left), sum(sides.right), Math.abs(mark));
}

/**
 * A bar around zero at its middle, on a scale shared by a list's rows (`scale` = the longest side
 * drawn): what went out or was lost to the left, what came in or was gained to the right. `mark`
 * is a line across the bar at a signed value (a chart's line series), on the side of its sign.
 */
export function ZeroBar({
  left,
  right,
  mark,
  scale,
  className,
}: {
  left: readonly ZeroBarSegment[];
  right: readonly ZeroBarSegment[];
  mark?: { value: number; color: string };
  scale: number;
  className?: string;
}) {
  const pct = (amount: number) => `${(amount / scale) * 100}%`;
  const segments = (list: readonly ZeroBarSegment[]) =>
    scale > 0 ? list.map((s) => <i key={s.key} style={{ width: pct(s.amount), background: s.color }} />) : null;
  // The mark stays inside the bar at its far end.
  const markAt = mark && scale > 0 && mark.value !== 0 ? `min(${pct(Math.abs(mark.value))}, 100% - 1px)` : null;
  return (
    <span className={cn(styles.bar, className)} aria-hidden>
      <span className={cn(styles.side, styles.out)}>
        {segments(left)}
        {markAt && mark!.value < 0 ? (
          <i className={cn(styles.mark, styles.markOut)} style={{ right: markAt, background: mark!.color }} />
        ) : null}
      </span>
      <span className={cn(styles.side, styles.in)}>
        {segments(right)}
        {markAt && mark!.value > 0 ? (
          <i className={cn(styles.mark, styles.markIn)} style={{ left: markAt, background: mark!.color }} />
        ) : null}
      </span>
    </span>
  );
}
