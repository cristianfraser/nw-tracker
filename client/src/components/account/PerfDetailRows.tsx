import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../cn";
import styles from "./PerfDetailRows.module.css";

export type PerfDetailColumn<Row> = {
  key: string;
  label: string;
  value: (row: Row) => ReactNode;
};

/**
 * The «Detalle por mes / año / día» rows: one rendering at every width (no desktop table beside
 * mobile cards). Each row is one grid. While every row fits its list on one line, the rows share
 * their columns (a subgrid of the list) under one header row, so they read as a table; when they
 * do not, each row wraps: its period over its values, each value with its own label (the
 * header row goes). Which one applies is measured, not a breakpoint: the list's columns as wide as
 * their content, wider than the list = the rows wrap.
 */
export function PerfDetailRows<Row>({
  rows,
  rowKey,
  period,
  periodLabel,
  columns,
  dimRow,
}: {
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The row's period (month, year or day), its first column and its heading when it wraps. */
  period: (row: Row) => string;
  periodLabel: string;
  columns: readonly PerfDetailColumn<Row>[];
  /** A row shown dimmed (a day the account's market was closed). */
  dimRow?: (row: Row) => boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);

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
      className={styles.list}
      style={{ "--perf-value-cols": columns.length } as CSSProperties}
    >
      <div className={cn(styles.row, styles.header)} aria-hidden="true">
        <span className={styles.period}>{periodLabel}</span>
        {columns.map((c) => (
          <span key={c.key} className={styles.value}>
            {c.label}
          </span>
        ))}
      </div>
      <div role="list" className={styles.body}>
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            role="listitem"
            className={cn(styles.row, dimRow?.(row) && styles.dim)}
          >
            <span className={cn("mono", styles.period)}>{period(row)}</span>
            {columns.map((c) => (
              <span key={c.key} className={styles.cell}>
                <span className={styles.label}>{c.label}</span>
                <span className={cn("mono", styles.value)}>{c.value(row)}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One line per row while the columns fit the list; wrapped rows otherwise. */
function fitRows(list: HTMLDivElement | null): void {
  if (!list) return;
  list.classList.remove(styles.wrapped!);
  if (list.scrollWidth > list.clientWidth + 0.5) list.classList.add(styles.wrapped!);
}
