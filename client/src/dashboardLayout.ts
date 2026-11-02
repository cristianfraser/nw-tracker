/**
 * The dashboard's tiles on the page grid (docs/layout-grid-plan.md §C and §E).
 *
 * Every section of the home page is a tile with a stable id and, per tier, a rectangle in
 * grid units: `x` / `w` in columns of the content region (12 on both desktop tiers, 4 on a
 * phone), `y` / `h` in row units (`--row-unit`, 24px, the gutter between rows). The static CSS
 * renders `w` (and on the big-desktop tier `x`) through `PageGridTile`; `y` and `h` are the
 * reading order and the nominal height a future react-grid-layout step would start from — its
 * `Responsive` props are `GRID` below, verbatim. Rows are measured, never fixed: an auto-height
 * table stretches its rows, so `h` is a nominal value for the library step, not a constraint.
 *
 * Tier `l` (≥1440): a top band of the main column (8 wide, x 0) beside the rail (4 wide, x 8),
 * then the other charts in two equal columns (6 wide), then the wide tables, the export row and
 * the accounts tree across all 12. Tiers `s` and `m` are one stack in `y` order.
 */
export type DashboardTileId =
  | "title"
  | "strip"
  | "net-worth-chart"
  | "flows-periods"
  | "flows-chart"
  | "cc-upcoming"
  | "perf-combo"
  | "allocation"
  | "returns"
  | "detail"
  | "wealth-flows"
  | "latest-expenses"
  | "export"
  | "accounts";

export type TileRect = { x: number; y: number; w: number; h: number };
export type TileLayout = { l: TileRect; s: TileRect; m: TileRect };
export type LayoutTier = keyof TileLayout;

/** react-grid-layout `Responsive` props, should the bento step ever mount it. */
export const GRID = {
  cols: { l: 12, s: 12, m: 4 },
  breakpoints: { l: 1440, s: 880, m: 0 },
  rowHeight: 24,
  margin: { l: [24, 24], s: [16, 16], m: [16, 16] },
  containerPadding: [0, 0],
  compactType: "vertical",
} as const;

const stack = (order: readonly DashboardTileId[], cols: number, heights: Partial<Record<DashboardTileId, number>>) => {
  const out: Partial<Record<DashboardTileId, TileRect>> = {};
  let y = 0;
  for (const id of order) {
    const h = heights[id] ?? 4;
    out[id] = { x: 0, y, w: cols, h };
    y += h;
  }
  return out as Record<DashboardTileId, TileRect>;
};

const READING_ORDER: readonly DashboardTileId[] = [
  "title",
  "strip",
  "net-worth-chart",
  "flows-periods",
  "flows-chart",
  "cc-upcoming",
  "perf-combo",
  "allocation",
  "returns",
  "detail",
  "wealth-flows",
  "latest-expenses",
  "export",
  "accounts",
];

const NOMINAL_HEIGHTS: Partial<Record<DashboardTileId, number>> = {
  title: 1,
  strip: 8,
  "net-worth-chart": 10,
  "flows-periods": 6,
  "flows-chart": 10,
  "cc-upcoming": 4,
  "perf-combo": 10,
  allocation: 10,
  returns: 6,
  detail: 12,
  "wealth-flows": 12,
  "latest-expenses": 8,
  export: 1,
  accounts: 8,
};

const S = stack(READING_ORDER, 12, NOMINAL_HEIGHTS);
const M = stack(READING_ORDER, 4, NOMINAL_HEIGHTS);

/**
 * Big desktop: a top band of the main column (x 0, w 8: cards, net-worth chart) beside the rail
 * (x 8, w 4); below it tiles in two equal columns (w 6) or across all 12. The order of the tiles
 * below the band (`y`) differs from the one-stack order: returns sit between the chart pair and
 * the allocation | detail pair.
 */
const L: Record<DashboardTileId, TileRect> = {
  title: { x: 0, y: 0, w: 12, h: 1 },
  strip: { x: 0, y: 1, w: 8, h: 8 },
  "net-worth-chart": { x: 0, y: 9, w: 8, h: 21 },
  "flows-periods": { x: 8, y: 1, w: 4, h: 9 },
  "cc-upcoming": { x: 8, y: 10, w: 4, h: 6 },
  "latest-expenses": { x: 8, y: 16, w: 4, h: 14 },
  "flows-chart": { x: 0, y: 30, w: 6, h: 10 },
  "perf-combo": { x: 6, y: 30, w: 6, h: 10 },
  returns: { x: 0, y: 40, w: 12, h: 6 },
  allocation: { x: 0, y: 46, w: 6, h: 14 },
  detail: { x: 6, y: 46, w: 6, h: 14 },
  "wealth-flows": { x: 0, y: 60, w: 12, h: 12 },
  export: { x: 0, y: 72, w: 12, h: 1 },
  accounts: { x: 0, y: 73, w: 12, h: 10 },
};

export const DASHBOARD_LAYOUT: Record<DashboardTileId, TileLayout> = Object.fromEntries(
  READING_ORDER.map((id) => [id, { l: L[id], s: S[id], m: M[id] }])
) as Record<DashboardTileId, TileLayout>;

/** The tiles of the big-desktop rail, in their `y` order. */
export const RAIL_TILES: readonly DashboardTileId[] = READING_ORDER.filter(
  (id) => L[id].x === 8
).sort((a, b) => L[a].y - L[b].y);

/** Render order on the one-stack tiers equals the layout's `y` order (asserted by a unit test). */
export const DASHBOARD_TILE_ORDER = READING_ORDER;

/** A tile's place in the one-stack reading order (`PageGridTile`'s `order`). */
export function dashboardTileOrder(id: DashboardTileId): number {
  return DASHBOARD_LAYOUT[id].s.y;
}

/**
 * A tile below the big-desktop band: its order and column span there (`PageGridTile`'s `wide`).
 * The band's own tiles (main column, rail) are placed by their stack and get none.
 */
export function dashboardTileWide(id: DashboardTileId): { order: number; span: number } | undefined {
  const r = DASHBOARD_LAYOUT[id].l;
  return r.w === 6 || (r.w === 12 && r.y > 0) ? { order: r.y, span: r.w } : undefined;
}
