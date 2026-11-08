import { useCallback, useState } from "react";

/**
 * Per-viewer conveniences in localStorage (a remembered toggle, a chart's grouping): never state
 * that must persist reliably. Unavailable storage (private mode, quota) reads as nothing stored
 * and forgets writes.
 */
export function readPref(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* unavailable storage forgets the choice */
  }
}

/**
 * One remembered preference: `parse` turns the stored text (null = nothing stored) into the value,
 * a stored value it does not recognise included — that is the caller's default.
 */
export function usePersistedPref<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => parse(readPref(key)));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, serialize(next));
    },
    [key, serialize]
  );
  return [value, set];
}
