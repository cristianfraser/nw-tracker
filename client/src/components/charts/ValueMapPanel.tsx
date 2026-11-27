import { SurfaceControls } from "../ui/SurfaceControls";
import {
  useSurfacePrefs,
  type SurfaceCompositionView,
} from "../../surfaceDisplayPrefs";
import type { NavValueMapColorBounds, NavValueMapNodeDto } from "../../types";
import { ValueTreemap } from "./ValueTreemap";
import type { DisplayUnit } from "../../queries/keys";

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
  /** The composition chart's title: the map takes its place in the same panel ("" = untitled). */
  title: string;
  surfaceId: string;
  /** The Composición / Mapa switch; omitted where the map is the only view (investment pages). */
  view?: SurfaceCompositionView;
  onViewChange?: (v: SurfaceCompositionView) => void;
  /** null until the first payload for this page arrives (the panel renders empty). */
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  unit: DisplayUnit;
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
 * The subtree the page at `slug` draws, when it has one worth drawing: the page node must have
 * something to tile — sub-groups, or accounts of its own (a leaf group: Acciones holding only
 * stocks, Crypto holding one coin) — and the payload must carry the display unit's values.
 */
function valueMapRootForPage(
  valueMap: NavValueMapNodeDto | undefined,
  slug: string
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
  if (!node || !(node.children?.length || node.leaf_accounts?.length)) return null;
  if (node.value == null) return null;
  return node;
}

export type ValueMapView = {
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  /** The unit of the payload the map comes from (a payload held across a switch keeps its own). */
  unit: DisplayUnit;
};

/**
 * The map the page at `slug` draws from the payload on screen (this unit's, or the one held
 * across a switch, `heldUnitPayload.ts`, which does all the holding): its subtree and colour
 * bounds, or nothing to draw.
 */
export function valueMapView(
  valueMap: NavValueMapNodeDto | undefined,
  bounds: NavValueMapColorBounds | undefined,
  slug: string,
  unit: DisplayUnit
): ValueMapView {
  const root = valueMapRootForPage(valueMap, slug);
  return root && bounds ? { root, bounds, unit } : { root: null, bounds: null, unit };
}
