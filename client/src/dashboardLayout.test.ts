import { describe, expect, it } from "vitest";
import {
  DASHBOARD_LAYOUT,
  DASHBOARD_TILE_ORDER,
  GRID,
  RAIL_TILES,
  dashboardTileOrder,
  type DashboardTileId,
  type TileRect,
} from "./dashboardLayout";

const ids = Object.keys(DASHBOARD_LAYOUT) as DashboardTileId[];

function overlaps(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("dashboard layout", () => {
  it("lists every tile once, in the one-stack reading order", () => {
    expect([...DASHBOARD_TILE_ORDER].sort()).toEqual([...ids].sort());
    // The render order below 1440 is the layout's `y` order: PageGridTile's `order` is `s.y`.
    const ys = DASHBOARD_TILE_ORDER.map((id) => dashboardTileOrder(id));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(ys.length);
    for (const id of ids) expect(DASHBOARD_LAYOUT[id].m.y).toBe(DASHBOARD_LAYOUT[id].s.y);
  });

  it("spans the whole content width on the one-stack tiers", () => {
    for (const id of ids) {
      expect(DASHBOARD_LAYOUT[id].s).toMatchObject({ x: 0, w: GRID.cols.s });
      expect(DASHBOARD_LAYOUT[id].m).toMatchObject({ x: 0, w: GRID.cols.m });
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
      expect(RAIL_TILES.includes(id)).toBe(placement === "rail");
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
