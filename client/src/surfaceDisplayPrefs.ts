import { useCallback, useState } from "react";
import { readPref, writePref } from "./usePersistedPref";
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
export type StoredSurfacePrefs = {
  period?: SurfacePeriod;
  range?: TimeRange;
  benchmark?: string;
  /** Composition panels: `map` swaps the share chart for the value treemap. */
  view?: SurfaceCompositionView;
  /** P/L combo charts with a cumulative area: this year's running sum or the full-history one. */
  area?: SurfaceAreaMode;
  /** P/L combo charts that can show returns instead of money: `true` = the % view. */
  percent?: boolean;
  /** An accounts table's «Liquidadas» row group, opened. */
  liquidatedOpen?: boolean;
};

export type SurfaceCompositionView = "composition" | "map";

export type SurfaceAreaMode = "ytd" | "total";

/**
 * M/Y-only surfaces (flow tables, the CC financing chart and detalle table): a stored `day`
 * — a key written while the surface still offered Diario — reads as month. The stored value
 * is left as is; the next explicit pick overwrites it.
 */
export function monthYearSurfacePeriod(period: SurfacePeriod): "month" | "year" {
  return period === "year" ? "year" : "month";
}

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
  if (typeof rec.benchmark === "string" && rec.benchmark !== "") out.benchmark = rec.benchmark;
  if (rec.view === "composition" || rec.view === "map") out.view = rec.view;
  if (rec.area === "ytd" || rec.area === "total") out.area = rec.area;
  if (typeof rec.percent === "boolean") out.percent = rec.percent;
  if (typeof rec.liquidatedOpen === "boolean") out.liquidatedOpen = rec.liquidatedOpen;
  return out;
}

export function readStoredSurfacePrefs(surfaceId: string): StoredSurfacePrefs {
  return parseStoredSurfacePrefs(readPref(SURFACE_PREFS_LS_PREFIX + surfaceId));
}

/** Merge `patch` over the currently stored fields and persist; returns the merged value. */
export function writeStoredSurfacePref(
  surfaceId: string,
  patch: StoredSurfacePrefs
): StoredSurfacePrefs {
  const merged = { ...readStoredSurfacePrefs(surfaceId), ...patch };
  writePref(SURFACE_PREFS_LS_PREFIX + surfaceId, JSON.stringify(merged));
  return merged;
}

/**
 * One surface's stored fields and a writer. `surfaceId` null = the page does not know which
 * surface yet (its group has not resolved): nothing is read or written, every field is the
 * caller's default. A `surfaceId` change on a mounted component (route param swap, e.g.
 * `group.<slug>.valuation` across group pages) re-seeds from storage during render.
 */
function useStoredSurface(surfaceId: string | null): [StoredSurfacePrefs, (patch: StoredSurfacePrefs) => void] {
  const [state, setState] = useState(() => ({
    surfaceId,
    stored: surfaceId == null ? {} : readStoredSurfacePrefs(surfaceId),
  }));
  let stored = state.stored;
  if (state.surfaceId !== surfaceId) {
    stored = surfaceId == null ? {} : readStoredSurfacePrefs(surfaceId);
    setState({ surfaceId, stored });
  }
  const write = useCallback(
    (patch: StoredSurfacePrefs) => {
      if (surfaceId == null) return;
      setState({ surfaceId, stored: writeStoredSurfacePref(surfaceId, patch) });
    },
    [surfaceId]
  );
  return [stored, write];
}

export type SurfacePrefsValue = {
  period: SurfacePeriod;
  range: TimeRange;
  setPeriod: (p: SurfacePeriod) => void;
  setRange: (r: TimeRange) => void;
};

/**
 * Per-surface Período/Rango state. Defaults are primitives (stable deps); surfaces that
 * only use one of the pair pass any default for the other and ignore it.
 */
export function useSurfacePrefs(
  surfaceId: string | null,
  defaultPeriod: SurfacePeriod,
  defaultRange: TimeRange
): SurfacePrefsValue {
  const [stored, write] = useStoredSurface(surfaceId);
  const setPeriod = useCallback((p: SurfacePeriod) => write({ period: p }), [write]);
  const setRange = useCallback((r: TimeRange) => write({ range: r }), [write]);
  return {
    period: stored.period ?? defaultPeriod,
    range: stored.range ?? defaultRange,
    setPeriod,
    setRange,
  };
}

/**
 * The benchmark a Rentabilidad table compares against, per surface (`<pageKey>.returns`).
 * The stored slug is only a preference: the caller checks it against the listed benchmarks.
 */
export function useSurfaceBenchmark(
  surfaceId: string | null,
  defaultBenchmark: string
): { benchmark: string; setBenchmark: (slug: string) => void } {
  const [stored, write] = useStoredSurface(surfaceId);
  const setBenchmark = useCallback((slug: string) => write({ benchmark: slug }), [write]);
  return { benchmark: stored.benchmark ?? defaultBenchmark, setBenchmark };
}

/** Money or % view of a return combo (`<pageKey>.perf`-style surface). Default money (`false`). */
export function useSurfacePercentMode(surfaceId: string | null): {
  percent: boolean;
  setPercent: (on: boolean) => void;
} {
  const [stored, write] = useStoredSurface(surfaceId);
  const setPercent = useCallback((on: boolean) => write({ percent: on }), [write]);
  return { percent: stored.percent ?? false, setPercent };
}

/**
 * Composition panel view (`<pageKey>.proportional`): the share chart or the value
 * treemap (default). Stored beside that surface's Período/Rango, which only the share chart uses.
 */
export function useSurfaceCompositionView(surfaceId: string | null): {
  view: SurfaceCompositionView;
  setView: (v: SurfaceCompositionView) => void;
} {
  const [stored, write] = useStoredSurface(surfaceId);
  const setView = useCallback((v: SurfaceCompositionView) => write({ view: v }), [write]);
  return { view: stored.view ?? "map", setView };
}

/**
 * Cumulative-area mode of a P/L combo chart (`<pageKey>.<surfaceKey>`): `ytd` (default) runs
 * the sum within each year, `total` over the whole history. Stored beside the chart's
 * Período/Rango.
 */
export function useSurfaceAreaMode(surfaceId: string | null): {
  area: SurfaceAreaMode;
  setArea: (a: SurfaceAreaMode) => void;
} {
  const [stored, write] = useStoredSurface(surfaceId);
  const setArea = useCallback((a: SurfaceAreaMode) => write({ area: a }), [write]);
  return { area: stored.area ?? "ytd", setArea };
}

/** An accounts table's «Liquidadas» group, opened or not (`<pageKey>.accounts`). */
export function useSurfaceLiquidatedOpen(surfaceId: string | null): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [stored, write] = useStoredSurface(surfaceId);
  const setOpen = useCallback((open: boolean) => write({ liquidatedOpen: open }), [write]);
  return { open: stored.liquidatedOpen ?? false, setOpen };
}
