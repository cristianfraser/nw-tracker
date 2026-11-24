import { replaceEqualDeep } from "@tanstack/react-query";
import { useRef } from "react";

/**
 * Keeps a derived value's identity while its content is unchanged: the new value is shared
 * against the previous one with `replaceEqualDeep` (react-query's structural sharing), so equal
 * parts stay the same objects and an equal result returns the previous value itself. Charts
 * restart their animation on any new data array, and memos downstream re-run on any new object,
 * so a refetch or rebuild that changes nothing must hand down the same references.
 *
 * Only plain JSON shares (objects, arrays, primitives); functions, Dates and Maps compare by
 * reference, so keep them out of shared values.
 */
export function useStructuralValue<T>(value: T): T {
  const prev = useRef<{ value: T } | null>(null);
  const stable = prev.current == null ? value : replaceEqualDeep(prev.current.value, value);
  prev.current = { value: stable };
  return stable;
}
