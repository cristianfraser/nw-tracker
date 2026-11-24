/**
 * The dashboard's tiles on the page grid (docs/layout-grid-plan.md §C and §E).
 *
 * Every section of the home page is a tile with a stable id and, per tier, a rectangle in
 * grid units: `x` / `w` in columns of the content region (12 on both desktop tiers, 4 on a
 * phone), `y` / `h` in row units (`--row-unit`, 24px, the gutter between rows). The static CSS
 * renders `w` through `PageGridTile`; `y` and `h` are the nominal reading order and height a
 * future react-grid-layout step would start from — its `Responsive` props are `GRID` below,
 * verbatim. Rows are measured, never fixed: an auto-height table stretches its rows, so `h` is a
 * nominal value for the library step, not a constraint.
 *
 * Nothing reorders tiles: the page draws them in DOM order at every width (focus and screen
 * readers follow what is drawn), and this table describes that order. Tier `l` (≥1440): a top
 * band of the main column (8 wide, x 0: cards, net-worth chart) beside the rail (4 wide, x 8),
 * then the flows chart | Δ by class, then the allocation column (allocation over Rentabilidad,
 * one stack) beside the detalle table, then the wide tables, the export row and the accounts
 * tree across all 12. Tier `s` (880–1439) is one stack in that order with the same two side by
 * side rows, half the columns each; tier `m` is one stack in the same order.
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
  | "latest-movements"
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

/**
 * The page's DOM order (`GroupInfoBase` with the dashboard's `rail`, `pairs` and `allocation`),
 * which is the stacked order below the big desktop: the main column's band (cards, net-worth
 * chart), the rail, then the tiles below the band — a stack (allocation over Rentabilidad) before
 * the tile beside it. The rail therefore sits right under the chart instead of after the tables.
 */
export const DASHBOARD_READING_ORDER: readonly DashboardTileId[] = [
  "title",
  "strip",
  "net-worth-chart",
  "flows-periods",
  "cc-upcoming",
  "latest-movements",
  "flows-chart",
  "perf-combo",
  "allocation",
  "returns",
  "detail",
  "wealth-flows",
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
  "latest-movements": 8,
  export: 1,
  accounts: 8,
};

/**
 * Small desktop: tiles that share a row, half the width each (the second takes the first's row) —
 * the tiles that sit side by side on the big desktop. Each pair is adjacent in the reading order,
 * and both tiles of a pair render together (a pair is never left with an empty half): the flows
 * chart takes the whole row when the Δ by class chart is not shown (`DashboardFlowsChart` `alone`).
 * Not here: «Flujos» and «Próximos pagos», which share one wrapper below the net-worth chart that
 * sets them in one row at any width where both fit, the periods at their own width (page-grid.css
 * `.dashboard-flows-pair`), so they pair on a wide phone too and stack in the rail.
 */
const SMALL_PAIRS: readonly (readonly [DashboardTileId, DashboardTileId])[] = [["flows-chart", "perf-combo"]];

/**
 * From 880: tiles stacked in one half-width column (`.dashboard-tile-stack`, its own column of
 * rows, so a tall neighbour never opens whitespace between them) beside the next tile in the
 * reading order. Allocation and detalle are both below the fold (`GroupInfoBase` `fold` drops
 * them together), so the column never stands beside an empty half; Rentabilidad is left out
 * when the server sends no returns, and the stack is then allocation alone.
 */
export const ALLOCATION_STACK: readonly DashboardTileId[] = ["allocation", "returns"];
const ALLOCATION_STACK_BESIDE: DashboardTileId = "detail";

const halves = (rects: Record<DashboardTileId, TileRect>, cols: number) => {
  const out = { ...rects };
  const half = cols / 2;
  for (const [a, b] of SMALL_PAIRS) {
    out[a] = { ...out[a], w: half };
    out[b] = { ...out[b], x: half, y: out[a].y, w: half };
  }
  const top = out[ALLOCATION_STACK[0]].y;
  for (const id of ALLOCATION_STACK) out[id] = { ...out[id], w: half };
  out[ALLOCATION_STACK_BESIDE] = {
    ...out[ALLOCATION_STACK_BESIDE],
    x: half,
    y: top,
    w: half,
    h: ALLOCATION_STACK.reduce((sum, id) => sum + out[id].h, 0),
  };
  return out;
};

const S = halves(stack(DASHBOARD_READING_ORDER, 12, NOMINAL_HEIGHTS), 12);
const M = stack(DASHBOARD_READING_ORDER, 4, NOMINAL_HEIGHTS);

/**
 * Big desktop: a top band of the main column (x 0, w 8: cards, net-worth chart) beside the rail
 * (x 8, w 4); below it tiles in two equal columns (w 6, the allocation stack one of them) or
 * across all 12.
 */
const L: Record<DashboardTileId, TileRect> = {
  title: { x: 0, y: 0, w: 12, h: 1 },
  strip: { x: 0, y: 1, w: 8, h: 8 },
  "net-worth-chart": { x: 0, y: 9, w: 8, h: 15 },
  "flows-periods": { x: 8, y: 1, w: 4, h: 5 },
  "cc-upcoming": { x: 8, y: 6, w: 4, h: 3 },
  "latest-movements": { x: 8, y: 9, w: 4, h: 21 },
  "flows-chart": { x: 0, y: 30, w: 6, h: 10 },
  "perf-combo": { x: 6, y: 30, w: 6, h: 10 },
  allocation: { x: 0, y: 40, w: 6, h: 14 },
  returns: { x: 0, y: 54, w: 6, h: 6 },
  detail: { x: 6, y: 40, w: 6, h: 20 },
  "wealth-flows": { x: 0, y: 60, w: 12, h: 12 },
  export: { x: 0, y: 72, w: 12, h: 1 },
  accounts: { x: 0, y: 73, w: 12, h: 10 },
};

export const DASHBOARD_LAYOUT: Record<DashboardTileId, TileLayout> = Object.fromEntries(
  DASHBOARD_READING_ORDER.map((id) => [id, { l: L[id], s: S[id], m: M[id] }])
) as Record<DashboardTileId, TileLayout>;

const inStack = (id: DashboardTileId) => ALLOCATION_STACK.includes(id);

/**
 * Small desktop: the columns a tile spans when it shares its row (`PageGridTile`'s `smallSpan`).
 * A stacked tile spans its stack, which takes this span itself (`dashboardAllocationStackSpans`).
 */
export function dashboardTileSmallSpan(id: DashboardTileId): number | undefined {
  const w = DASHBOARD_LAYOUT[id].s.w;
  return w < GRID.cols.s && !inStack(id) ? w : undefined;
}

/**
 * A tile below the big-desktop band: its column span there (`PageGridTile`'s `wideSpan`). The
 * band's own tiles (main column, rail) are placed by their stack and get none; so are the
 * allocation stack's, whose stack takes the span.
 */
export function dashboardTileWideSpan(id: DashboardTileId): number | undefined {
  const r = DASHBOARD_LAYOUT[id].l;
  return !inStack(id) && (r.w === 6 || (r.w === 12 && r.y > 0)) ? r.w : undefined;
}

/** The allocation stack's spans: below the band on the big desktop, and on the small desktop. */
export function dashboardAllocationStackSpans(): { wide: number; small: number } {
  const first = DASHBOARD_LAYOUT[ALLOCATION_STACK[0]];
  return { wide: first.l.w, small: first.s.w };
}
