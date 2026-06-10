import { useCallback, useEffect, useMemo, useState } from "react";

const LS_KEY = "nw-tracker.ccExpenseExcludedBigGroups";

function readStoredExcluded(): Set<string> | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((s): s is string => typeof s === "string" && s.length > 0));
  } catch {
    return null;
  }
}

function writeStoredExcluded(slugs: ReadonlySet<string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...slugs]));
  } catch {
    /* ignore */
  }
}

function defaultExcludedForActive(activeSlugs: readonly string[]): Set<string> {
  const stored = readStoredExcluded();
  if (!stored) return new Set(activeSlugs);
  const next = new Set<string>();
  for (const slug of activeSlugs) {
    if (stored.has(slug)) next.add(slug);
  }
  if (next.size === 0 && activeSlugs.length > 0) {
    return new Set(activeSlugs);
  }
  return next;
}

/** Per-group chart exclusion; default excludes all active big groups. */
export function useCcExpenseExcludedBigGroups(activeSlugs: readonly string[]): {
  excludedBigGroups: Set<string>;
  isExcluded: (slug: string) => boolean;
  toggleExcluded: (slug: string) => void;
} {
  const activeKey = useMemo(() => [...activeSlugs].sort().join("|"), [activeSlugs]);
  const [excluded, setExcluded] = useState<Set<string>>(() => defaultExcludedForActive(activeSlugs));

  useEffect(() => {
    setExcluded(defaultExcludedForActive(activeSlugs));
  }, [activeKey, activeSlugs]);

  const persist = useCallback((next: Set<string>) => {
    setExcluded(next);
    writeStoredExcluded(next);
  }, []);

  const isExcluded = useCallback((slug: string) => excluded.has(slug), [excluded]);

  const toggleExcluded = useCallback(
    (slug: string) => {
      const next = new Set(excluded);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      persist(next);
    },
    [excluded, persist]
  );

  return {
    excludedBigGroups: excluded,
    isExcluded,
    toggleExcluded,
  };
}
