import { replaceEqualDeep } from "@tanstack/react-query";
import { useRef } from "react";

/**
 * Keeps a chart's rows across rebuilds: an unchanged row stays the same object, and a rebuild
 * that changes nothing returns the previous array itself, so the chart gets new data only when a
 * value moved (a live price refetch rebuilt every row of the net-worth chart twice per change).
 */
export function useStableChartRows<T>(rows: T[]): T[] {
  const prev = useRef<T[] | null>(null);
  const stable = prev.current == null ? rows : replaceEqualDeep(prev.current, rows);
  prev.current = stable;
  return stable;
}
