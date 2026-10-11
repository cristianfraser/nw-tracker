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

  it("a frame in a container too small for a header gets none", () => {
    const placed: Placed<N>[] = layoutTreemap(tree, { x: 0, y: 0, w: 50, h: 30 }, acc, opts);
    expect(placed.find((p) => p.node.kids)!.header).toBe(0);
  });

  it("a root without children places nothing", () => {
    expect(layoutTreemap({ v: 1 }, { x: 0, y: 0, w: 10, h: 10 }, acc, opts)).toEqual([]);
  });
});

describe("frame minimum size", () => {
  it("grows a frame too small for its header at its siblings' expense", () => {
    // A tiny frame beside a huge tile: by value alone it would be ~10 px tall.
    const tree: N = { v: 100, kids: [{ v: 98 }, { v: 2, kids: [{ v: 1 }, { v: 1 }] }] };
    const placed = layoutTreemap(tree, { x: 0, y: 0, w: 200, h: 400 }, acc, opts);
    const frame = placed.find((p) => p.children.length > 0)!;
    expect(frame.rect.h).toBeGreaterThanOrEqual(opts.minHeaderHeight);
    expect(frame.rect.w).toBeGreaterThanOrEqual(opts.minHeaderWidth);
    expect(frame.header).toBe(opts.headerHeight);
    // the siblings still tile the container
    const total = placed.reduce((s, p) => s + area(p.rect), 0);
    expect(total).toBeCloseTo(200 * 400, 4);
  });
});

describe("nested frame minimum size", () => {
  it("grows a short parent frame so its child frames keep their headers", () => {
    const tree: N = {
      v: 100,
      kids: [
        { v: 96 },
        {
          v: 4,
          kids: [
            { v: 3, kids: [{ v: 2 }, { v: 1 }] },
            { v: 1, kids: [{ v: 0.5 }, { v: 0.5 }] },
          ],
        },
      ],
    };
    const placed = layoutTreemap(tree, { x: 0, y: 0, w: 800, h: 300 }, acc, opts);
    const parent = placed.find((p) => p.children.length > 0)!;
    expect(parent.header).toBe(opts.headerHeight);
    for (const child of parent.children) {
      expect(child.header).toBe(opts.headerHeight);
      expect(child.rect.h).toBeGreaterThanOrEqual(opts.minHeaderHeight);
    }
  });
});

describe("frame area accounting", () => {
  it("gives a tile inside a frame the same area per value as a tile outside it", () => {
    const tree: N = { v: 100, kids: [{ v: 50 }, { v: 50, kids: [{ v: 25 }, { v: 25 }] }] };
    const placed = layoutTreemap(tree, { x: 0, y: 0, w: 600, h: 400 }, acc, opts);
    const outside = placed.find((p) => p.children.length === 0)!;
    const frame = placed.find((p) => p.children.length > 0)!;
    const perValueOutside = area(outside.rect) / 50;
    for (const inner of frame.children) {
      expect(area(inner.rect) / 25).toBeCloseTo(perValueOutside, -1);
    }
  });
});
