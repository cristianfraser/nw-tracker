import { useMemo } from "react";
import type { ModalTitleNav } from "./components/ui/Modal";

/**
 * Rows adjacent to `selectedKey` in period order (newest-first). Input order is irrelevant —
 * rows are sorted internally by `keyOf` desc; a `selectedKey` not present in `rows` (or null)
 * yields no neighbors. Gaps in the period sequence are skipped naturally: nav only moves
 * through existing rows.
 */
export function adjacentPeriodRows<T>(
  rows: readonly T[],
  selectedKey: string | null,
  keyOf: (row: T) => string
): { older: T | null; newer: T | null } {
  if (selectedKey == null) return { older: null, newer: null };
  const sorted = [...rows].sort((a, b) => keyOf(b).localeCompare(keyOf(a)));
  const idx = sorted.findIndex((r) => keyOf(r) === selectedKey);
  if (idx < 0) return { older: null, newer: null };
  return {
    older: idx + 1 < sorted.length ? sorted[idx + 1] : null,
    newer: idx > 0 ? sorted[idx - 1] : null,
  };
}

/**
 * Prev/next-period nav for a period-detail Modal (`titleNav` prop). Navigates the FULL row
 * set (not the table's visible page); lookup is by period key, not object identity, so
 * refetch-recreated row arrays keep the neighbors stable while the modal is open.
 * `keyOf` should be referentially stable (module-level fn) to keep the memo effective.
 */
export function useModalPeriodNav<T>({
  rows,
  selectedKey,
  keyOf,
  onSelect,
  labels,
}: {
  rows: readonly T[];
  selectedKey: string | null;
  keyOf: (row: T) => string;
  onSelect: (row: T) => void;
  labels: { prev: string; next: string };
}): ModalTitleNav {
  const { older, newer } = useMemo(
    () => adjacentPeriodRows(rows, selectedKey, keyOf),
    [rows, selectedKey, keyOf]
  );
  return useMemo(
    () => ({
      onPrev: older ? () => onSelect(older) : null,
      onNext: newer ? () => onSelect(newer) : null,
      prevAriaLabel: labels.prev,
      nextAriaLabel: labels.next,
    }),
    [older, newer, onSelect, labels.prev, labels.next]
  );
}
