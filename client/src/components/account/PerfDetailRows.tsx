import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { cn } from "../../cn";
import styles from "./PerfDetailRows.module.css";

/** Money that moved in a period: in (→) or out (←); income and spending carry their colour. */
export type PerfDetailFlow = {
  key: string;
  direction: "in" | "out";
  /** The absolute amount, formatted. */
  amount: string;
  tone?: "positive" | "negative";
  /** The figure's name, shown on hover (the rows carry no column labels). */
  title: string;
};

export type PerfDetailRow = {
  key: string;
  period: string;
  closing: string;
  /** A second figure beside the closing (the mortgage's balance in UF). */
  closingNote?: { amount: string; title: string };
  /** Fixed slots, the same keys on every row of a list; a slot with nothing that period is null. */
  flows: readonly (PerfDetailFlow | null)[];
  /** The period's result: ▲ / ▼ by sign, the absolute amount and its % when there is one. */
  result: { sign: 1 | -1 | 0; amount: string; pct?: string; title: string } | null;
  /** Running totals, quieter: the year so far and all time. */
  totals: readonly { key: string; prefix: string; amount: string; title: string }[];
  dim?: boolean;
};

/**
 * The «Detalle por mes / año / día» rows, one rendering at every width (no desktop table beside
 * mobile cards), read by arrows, ▲ / ▼ and colour instead of column labels (each figure names
 * itself on hover). While every row fits its list on one line the rows share the list's columns
 * (a subgrid of it), so each kind of figure lines up down the list; when they do not, a row is
 * its period and closing over its flows and result, its running totals under the result — and
 * on a phone one thing per line. One line or wrapped is measured, not a breakpoint: the
 * columns as wide as their content, wider than the list = the rows wrap.
 */
export function PerfDetailRows({ rows, flowSlots }: { rows: readonly PerfDetailRow[]; flowSlots: number }) {
  const listRef = useRef<HTMLDivElement>(null);
  const totalSlots = rows[0]?.totals.length ?? 0;

  // No deps: the rows (and so the widest value) can change on any render.
  useLayoutEffect(() => {
    fitRows(listRef.current);
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    let lastWidth = list.clientWidth;
    const ro = new ResizeObserver(() => {
      if (list.clientWidth === lastWidth) return;
      lastWidth = list.clientWidth;
      fitRows(list);
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={listRef}
      role="list"
      className={styles.list}
      style={{ "--perf-flow-slots": flowSlots, "--perf-total-slots": totalSlots } as CSSProperties}
    >
      {rows.map((row) => (
        <div key={row.key} role="listitem" className={cn(styles.row, row.dim && styles.dim)}>
          <span className={cn("mono", styles.period)}>{row.period}</span>
          <span className={cn("mono", styles.closing)}>
            {row.closing}
            {row.closingNote ? (
              <span className={cn("muted", styles.closingNote)} title={row.closingNote.title}>
                {" "}
                {row.closingNote.amount}
              </span>
            ) : null}
          </span>
          <span className={styles.flows}>
            {row.flows.map((flow, i) => (
              <span
                key={flow?.key ?? `empty-${i}`}
                className={cn("mono", styles.flow, flow?.tone && styles[flow.tone])}
                title={flow?.title}
              >
                {flow ? (
                  <>
                    <span className={styles.arrow} aria-hidden="true">
                      {flow.direction === "in" ? "→" : "←"}
                    </span>
                    <span className="visually-hidden">{flow.title}: </span>
                    {flow.amount}
                  </>
                ) : null}
              </span>
            ))}
          </span>
          <span
            className={cn(
              "mono",
              styles.result,
              row.result?.sign === 1 && styles.positive,
              row.result?.sign === -1 && styles.negative
            )}
            title={row.result?.title}
          >
            {row.result ? (
              <>
                <span aria-hidden="true">{row.result.sign === 1 ? "▲" : row.result.sign === -1 ? "▼" : "·"}</span>
                <span className="visually-hidden">{row.result.title}: </span>
                {row.result.amount}
                {row.result.pct ? <span className={styles.pct}>{row.result.pct}</span> : null}
              </>
            ) : null}
          </span>
          <span className={styles.totals}>
            {row.totals.map((total) => (
              <span key={total.key} className={cn("mono muted", styles.total)} title={total.title}>
                <span className={styles.totalPrefix} aria-hidden="true">
                  {total.prefix}
                </span>
                <span className="visually-hidden">{total.title}: </span>
                {total.amount}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One line per row while the columns fit the list; wrapped rows otherwise. */
function fitRows(list: HTMLDivElement | null): void {
  if (!list) return;
  list.classList.remove(styles.wrapped!);
  if (list.scrollWidth > list.clientWidth + 0.5) list.classList.add(styles.wrapped!);
}
