import { describe, expect, it } from "vitest";
import { layoutTreemap, squarify, type Placed } from "./treemapLayout";

type N = { v: number; kids?: N[] };
const acc = { value: (n: N) => n.v, children: (n: N) => n.kids };
const opts = { headerHeight: 18, minHeaderWidth: 60, minHeaderHeight: 40, framePadding: 2 };
const area = (r: { w: number; h: number }) => r.w * r.h;

describe("squarify", () => {
  it("tiles the rectangle with areas proportional to the values", () => {
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rect = { x: 10, y: 20, w: 600, h: 400 };
    const rects = squarify(values, rect);
    const total = values.reduce((s, v) => s + v, 0);
    let sum = 0;
    rects.forEach((r, i) => {
      sum += area(r);
      expect(area(r) / area(rect)).toBeCloseTo(values[i]! / total, 6);
      expect(r.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(rect.y + rect.h + 1e-9);
    });
    expect(sum).toBeCloseTo(area(rect), 4);
  });

  it("a single value fills the rectangle", () => {
    expect(squarify([5], { x: 0, y: 0, w: 100, h: 50 })).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);
  });
});

describe("layoutTreemap", () => {
  const tree: N = {
    v: 100,
    kids: [
      { v: 60, kids: [{ v: 40 }, { v: 20 }] },
      { v: 30 },
      { v: 10 },
    ],
  };

  it("reserves a header in a frame that has room and lays its children inside the body", () => {
    const placed = layoutTreemap(tree, { x: 0, y: 0, w: 400, h: 300 }, acc, opts);
    const frame = placed.find((p) => p.node.kids)!;
    expect(frame.header).toBe(18);
    for (const c of frame.children) {
      expect(c.rect.y).toBeGreaterThanOrEqual(frame.rect.y + 18 - 1e-9);
      expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(frame.rect.x + frame.rect.w + 1e-9);
      expect(c.depth).toBe(1);
    }
  });

  it("a frame too small for a header gets none", () => {
    const placed: Placed<N>[] = layoutTreemap(tree, { x: 0, y: 0, w: 80, h: 40 }, acc, opts);
    expect(placed.find((p) => p.node.kids)!.header).toBe(0);
  });

  it("a root without children places nothing", () => {
    expect(layoutTreemap({ v: 1 }, { x: 0, y: 0, w: 10, h: 10 }, acc, opts)).toEqual([]);
  });
});
