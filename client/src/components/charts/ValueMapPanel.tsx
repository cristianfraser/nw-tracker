import { useState } from "react";
import { SurfaceControls } from "../ui/SurfaceControls";
import {
  useSurfacePrefs,
  type SurfaceCompositionView,
} from "../../surfaceDisplayPrefs";
import type { NavValueMapColorBounds, NavValueMapNodeDto } from "../../types";
import { ValueTreemap } from "./ValueTreemap";

/**
 * The value map in the composition chart's slot: Período (the return window, Día by default,
 * stored per page as `<pageKey>.map`) next to the Composición / Mapa switch. Rango does not
 * apply to a point-in-time map.
 */
export function ValueMapPanel({
  title,
  surfaceId,
  view,
  onViewChange,
  root,
  bounds,
  unit,
  loading,
}: {
  /** The composition chart's title: the map takes its place in the same panel. */
  title: string;
  surfaceId: string;
  view: SurfaceCompositionView;
  onViewChange: (v: SurfaceCompositionView) => void;
  /** null until the first payload for this page arrives (the panel renders empty). */
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  unit: "clp" | "usd";
  /** The payload is pending or held prior data: the map dims (empty box when `root` is null). */
  loading?: boolean;
}) {
  const prefs = useSurfacePrefs(surfaceId, "day", "total");
  return (
    <ValueTreemap
      title={title}
      controls={
        <SurfaceControls
          view={view}
          onViewChange={onViewChange}
          periodKind="return"
          period={prefs.period}
          onPeriodChange={prefs.setPeriod}
        />
      }
      root={root}
      bounds={bounds}
      period={prefs.period}
      unit={unit}
      loading={loading}
    />
  );
}

/**
 * The subtree the page at `slug` draws, when it has one worth drawing: the page node must be a
 * frame (group children) with tiles left, and the payload must carry the display unit's values.
 */
export function valueMapRootForPage(
  valueMap: NavValueMapNodeDto | undefined,
  slug: string,
  unit: "clp" | "usd"
): NavValueMapNodeDto | null {
  if (!valueMap) return null;
  const find = (n: NavValueMapNodeDto): NavValueMapNodeDto | null => {
    if (n.slug === slug && n.kind === "group") return n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(valueMap);
  if (!node || !node.frame || !node.children?.length) return null;
  if ((unit === "usd" ? node.value_usd : node.value_clp) == null) return null;
  return node;
}

export type HeldValueMap = {
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  /** The unit `root` was drawn in — the previous one while a unit switch is loading. */
  unit: "clp" | "usd";
};

/**
 * The map to draw: the current payload's when it carries the display unit, else the last one
 * this page drew (old unit, old data) until the new payload lands — never a chart-type swap.
 * Resets when the page (`scope`) changes.
 */
export function useHeldValueMap(
  scope: string,
  root: NavValueMapNodeDto | null,
  bounds: NavValueMapColorBounds | undefined,
  unit: "clp" | "usd"
): HeldValueMap {
  const [held, setHeld] = useState<(HeldValueMap & { scope: string }) | null>(null);
  if (root && bounds) {
    if (held?.scope !== scope || held.root !== root || held.unit !== unit || held.bounds !== bounds) {
      setHeld({ scope, root, bounds, unit });
    }
    return { root, bounds, unit };
  }
  if (held && held.scope === scope) return { root: held.root, bounds: held.bounds, unit: held.unit };
  return { root: null, bounds: null, unit };
}
