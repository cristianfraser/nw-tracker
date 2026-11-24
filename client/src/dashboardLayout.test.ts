import { describe, expect, it } from "vitest";
import {
  ALLOCATION_STACK,
  DASHBOARD_LAYOUT,
  DASHBOARD_READING_ORDER,
  GRID,
  dashboardAllocationStackSpans,
  dashboardTileSmallSpan,
  dashboardTileWideSpan,
  type DashboardTileId,
  type TileRect,
} from "./dashboardLayout";

const ids = Object.keys(DASHBOARD_LAYOUT) as DashboardTileId[];

function overlaps(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("dashboard layout", () => {
  it("lists every tile once; the phone stacks them in the reading order", () => {
    expect(ids).toEqual(DASHBOARD_READING_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    const ys = ids.map((id) => DASHBOARD_LAYOUT[id].m.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("reads both desktop tiers column by column: the main band, the rail, then each row's columns", () => {
    // Big desktop: `.page-main`, `.page-rail`, then below the band each row left to right, the
    // stack's tiles (allocation over Rentabilidad) before the tile beside it; the small desktop
    // has no band, only the rows.
    for (const tier of ["l", "s"] as const) {
      const group = (r: TileRect) =>
        tier === "s" ? 0 : r.y === 0 ? 0 : r.x === 0 && r.w === 8 ? 1 : r.x === 8 && r.w === 4 ? 2 : 3;
      const rowTop = (id: DashboardTileId) =>
        DASHBOARD_LAYOUT[ALLOCATION_STACK.includes(id) ? ALLOCATION_STACK[0] : id][tier].y;
      const drawn = [...ids].sort((a, b) => {
        const ra = DASHBOARD_LAYOUT[a][tier];
        const rb = DASHBOARD_LAYOUT[b][tier];
        return group(ra) - group(rb) || rowTop(a) - rowTop(b) || ra.x - rb.x || ra.y - rb.y;
      });
      expect(drawn, tier).toEqual(DASHBOARD_READING_ORDER);
    }
  });

  it("puts Rentabilidad right under the allocation tile on every tier", () => {
    const [top, below] = ALLOCATION_STACK;
    expect([top, below]).toEqual(["allocation", "returns"]);
    for (const tier of ["l", "s", "m"] as const) {
      const a = DASHBOARD_LAYOUT[top][tier];
      const r = DASHBOARD_LAYOUT[below][tier];
      expect({ x: r.x, w: r.w, y: r.y }, tier).toEqual({ x: a.x, w: a.w, y: a.y + a.h });
    }
  });

  it("spans the whole content width on the phone, and on the small desktop but for half-width rows", () => {
    const stackSpans = dashboardAllocationStackSpans();
    expect(stackSpans).toEqual({ wide: 6, small: GRID.cols.s / 2 });
    for (const id of ids) {
      expect(DASHBOARD_LAYOUT[id].m).toMatchObject({ x: 0, w: GRID.cols.m });
      const r = DASHBOARD_LAYOUT[id].s;
      if (r.w === GRID.cols.s) {
        expect(r.x, id).toBe(0);
        expect(dashboardTileSmallSpan(id), id).toBeUndefined();
        continue;
      }
      expect(r.w, id).toBe(GRID.cols.s / 2);
      // Something fills the other half of its rows: a pair partner, or the stack beside it.
      const partner = ids.find((o) => o !== id && DASHBOARD_LAYOUT[o].s.w === r.w && DASHBOARD_LAYOUT[o].s.x !== r.x && overlaps(DASHBOARD_LAYOUT[o].s, { ...r, x: DASHBOARD_LAYOUT[o].s.x }));
      expect(partner, id).toBeDefined();
      expect(dashboardTileSmallSpan(id), id).toBe(ALLOCATION_STACK.includes(id) ? undefined : GRID.cols.s / 2);
    }
  });

  it("puts every big-desktop tile in the top band, a half-width column or across all columns, without overlap", () => {
    for (const id of ids) {
      const r = DASHBOARD_LAYOUT[id].l;
      const placement =
        r.x === 0 && r.w === 8
          ? "main"
          : r.x === 8 && r.w === 4
            ? "rail"
            : (r.x === 0 || r.x === 6) && r.w === 6
              ? "half"
              : r.x === 0 && r.w === 12
                ? "wide"
                : null;
      expect(placement, id).not.toBeNull();
      expect(dashboardTileWideSpan(id), id).toBe(
        (placement === "half" && !ALLOCATION_STACK.includes(id)) || (placement === "wide" && id !== "title") ? r.w : undefined
      );
    }
    for (const a of ids) for (const b of ids) if (a < b) expect(overlaps(DASHBOARD_LAYOUT[a].l, DASHBOARD_LAYOUT[b].l), `${a} / ${b}`).toBe(false);
    const bandEnd = Math.max(...ids.filter((id) => DASHBOARD_LAYOUT[id].l.w < 6 || DASHBOARD_LAYOUT[id].l.w === 8).map((id) => DASHBOARD_LAYOUT[id].l.y + DASHBOARD_LAYOUT[id].l.h));
    // Below the band a half-width column always has a neighbour in its rows.
    for (const id of ids) {
      const r = DASHBOARD_LAYOUT[id].l;
      if (r.w === 6) {
        expect(r.y, id).toBeGreaterThanOrEqual(bandEnd);
        const partner = ids.find((o) => o !== id && DASHBOARD_LAYOUT[o].l.w === 6 && DASHBOARD_LAYOUT[o].l.x !== r.x && overlaps(DASHBOARD_LAYOUT[o].l, { ...r, x: DASHBOARD_LAYOUT[o].l.x }));
        expect(partner, id).toBeDefined();
      }
      if (r.w === 12 && id !== "title") expect(r.y, id).toBeGreaterThanOrEqual(bandEnd);
    }
  });
});
