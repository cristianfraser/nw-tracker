import { describe, expect, it } from "vitest";
import {
  DASHBOARD_LAYOUT,
  GRID,
  dashboardTileOrder,
  dashboardTileSmallSpan,
  type DashboardTileId,
  type TileRect,
} from "./dashboardLayout";

const ids = Object.keys(DASHBOARD_LAYOUT) as DashboardTileId[];

function overlaps(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("dashboard layout", () => {
  it("lists every tile once, in the one-stack reading order", () => {
    // The render order below 1440 is the reading order, which follows both stacked tiers' `y`.
    expect(ids.map((id) => dashboardTileOrder(id))).toEqual(ids.map((_, i) => i));
    for (const tier of ["s", "m"] as const) {
      const ys = ids.map((id) => DASHBOARD_LAYOUT[id][tier].y);
      expect(ys, tier).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it("spans the whole content width on the phone, and on the small desktop but for half-width pairs", () => {
    for (const id of ids) {
      expect(DASHBOARD_LAYOUT[id].m).toMatchObject({ x: 0, w: GRID.cols.m });
      const r = DASHBOARD_LAYOUT[id].s;
      if (r.w === GRID.cols.s) {
        expect(r.x, id).toBe(0);
        continue;
      }
      expect(r.w, id).toBe(GRID.cols.s / 2);
      const partner = ids.find((o) => o !== id && DASHBOARD_LAYOUT[o].s.y === r.y);
      expect(partner, id).toBeDefined();
      expect(DASHBOARD_LAYOUT[partner!].s.x + r.x, id).toBe(GRID.cols.s / 2);
      expect(dashboardTileSmallSpan(id)).toBe(GRID.cols.s / 2);
    }
  });

  it("puts every big-desktop tile in the top band, the chart pairs or across all columns, without overlap", () => {
    for (const id of ids) {
      const r = DASHBOARD_LAYOUT[id].l;
      const placement =
        r.x === 0 && r.w === 8
          ? "main"
          : r.x === 8 && r.w === 4
            ? "rail"
            : (r.x === 0 || r.x === 6) && r.w === 6
              ? "pair"
              : r.x === 0 && r.w === 12
                ? "wide"
                : null;
      expect(placement, id).not.toBeNull();
      expect((DASHBOARD_LAYOUT[id].l.x === 8)).toBe(placement === "rail");
    }
    for (const a of ids) for (const b of ids) if (a < b) expect(overlaps(DASHBOARD_LAYOUT[a].l, DASHBOARD_LAYOUT[b].l), `${a} / ${b}`).toBe(false);
    const bandEnd = Math.max(...ids.filter((id) => DASHBOARD_LAYOUT[id].l.w < 6 || DASHBOARD_LAYOUT[id].l.w === 8).map((id) => DASHBOARD_LAYOUT[id].l.y + DASHBOARD_LAYOUT[id].l.h));
    // Below the band every row is full: a pair shares its row, a 12-wide tile has it alone.
    for (const id of ids) {
      const r = DASHBOARD_LAYOUT[id].l;
      if (r.w === 6) {
        expect(r.y, id).toBeGreaterThanOrEqual(bandEnd);
        const partner = ids.find((o) => o !== id && DASHBOARD_LAYOUT[o].l.w === 6 && DASHBOARD_LAYOUT[o].l.y === r.y);
        expect(partner, id).toBeDefined();
      }
      if (r.w === 12 && id !== "title") expect(r.y, id).toBeGreaterThanOrEqual(bandEnd);
    }
  });
});
