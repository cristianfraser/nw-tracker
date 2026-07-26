import { useCallback, useState } from "react";
import { parseTimeRange, type TimeRange } from "./timeRange";

/**
 * Per-surface display preferences (Período + Rango) — one setting per chart/table per
 * page instance, replacing the global toolbar pair.
 *
 * Storage: localStorage `nw-tracker.surface.<surfaceId>` holding PARTIAL JSON
 * (`{"period":"day"}`) — a missing field means "use the caller's default", so a future
 * default change reaches every surface the user never touched. Garbage stored values
 * resolve to the default (UI-pref tolerance, same class as the readStored* guards in
 * DisplayPreferencesContext — not a business-logic fallback). Deliberately NO cross-tab
 * sync, unlike the global unit/decimal/language prefs: per-surface prefs are page-local
 * ergonomics and re-seed from storage on the next mount.
 *
 * Surface id convention: `<pageKey>.<surfaceKey>` — e.g. `home.overview`, `home.combos`,
 * `group.<slug>.valuation`, `group.<slug>.detalle`, `account.<id>.combos`,
 * `cc.<id>.charts`, `liab.<slug>.valuation`, `flows.<page>.chart`, `rates.range`,
 * `<pageKey>.proportional`.
 */

export const SURFACE_PREFS_LS_PREFIX = "nw-tracker.surface.";

export type SurfacePeriod = "day" | "month" | "year";

/** Stored shape: only the fields the user has explicitly set on this surface. */
export type StoredSurfacePrefs = { period?: SurfacePeriod; range?: TimeRange };

export function parseSurfacePeriod(raw: unknown): SurfacePeriod | null {
  return raw === "day" || raw === "month" || raw === "year" ? raw : null;
}

/** Tolerant parse of one surface's stored JSON; anything invalid drops to `{}` fields. */
export function parseStoredSurfacePrefs(raw: string | null): StoredSurfacePrefs {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof obj !== "object" || obj == null || Array.isArray(obj)) return {};
  const rec = obj as Record<string, unknown>;
  const out: StoredSurfacePrefs = {};
  const period = parseSurfacePeriod(rec.period);
  if (period != null) out.period = period;
  const range = parseTimeRange(typeof rec.range === "string" ? rec.range : null);
  if (range != null) out.range = range;
  return out;
}

function lsGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore (private mode / quota) */
  }
}

export function readStoredSurfacePrefs(surfaceId: string): StoredSurfacePrefs {
  return parseStoredSurfacePrefs(lsGet(SURFACE_PREFS_LS_PREFIX + surfaceId));
}

/** Merge `patch` over the currently stored fields and persist; returns the merged value. */
export function writeStoredSurfacePref(
  surfaceId: string,
  patch: StoredSurfacePrefs
): StoredSurfacePrefs {
  const merged = { ...readStoredSurfacePrefs(surfaceId), ...patch };
  lsSet(SURFACE_PREFS_LS_PREFIX + surfaceId, JSON.stringify(merged));
  return merged;
}

export type SurfacePrefsValue = {
  period: SurfacePeriod;
  range: TimeRange;
  setPeriod: (p: SurfacePeriod) => void;
  setRange: (r: TimeRange) => void;
};

/**
 * Per-surface Período/Rango state. Defaults are primitives (stable deps); surfaces that
 * only use one of the pair pass any default for the other and ignore it. A `surfaceId`
 * change on a mounted component (route param swap, e.g. `group.<slug>.valuation` across
 * group pages) re-seeds from storage during render.
 */
export function useSurfacePrefs(
  surfaceId: string,
  defaultPeriod: SurfacePeriod,
  defaultRange: TimeRange
): SurfacePrefsValue {
  const [state, setState] = useState(() => ({
    surfaceId,
    stored: readStoredSurfacePrefs(surfaceId),
  }));

  let stored = state.stored;
  if (state.surfaceId !== surfaceId) {
    stored = readStoredSurfacePrefs(surfaceId);
    setState({ surfaceId, stored });
  }

  const setPeriod = useCallback(
    (p: SurfacePeriod) => {
      setState({ surfaceId, stored: writeStoredSurfacePref(surfaceId, { period: p }) });
    },
    [surfaceId]
  );

  const setRange = useCallback(
    (r: TimeRange) => {
      setState({ surfaceId, stored: writeStoredSurfacePref(surfaceId, { range: r }) });
    },
    [surfaceId]
  );

  return {
    period: stored.period ?? defaultPeriod,
    range: stored.range ?? defaultRange,
    setPeriod,
    setRange,
  };
}
