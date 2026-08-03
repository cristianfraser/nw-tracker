import { describe, expect, it } from "vitest";
import { bandBreakIndices, bandEdges, hasBandableBarGroups } from "./chartBandEdges";

const OFFSET = { top: 0, left: 100, width: 900, height: 300 };

/** A Recharts band scale: category → left edge of its band, plus `bandwidth()`. */
function bandScale(categories: string[], left = OFFSET.left, width = OFFSET.width) {
  const step = width / categories.length;
  const scale = (v: unknown) => {
    const i = categories.indexOf(String(v));
    return i < 0 ? undefined : left + i * step;
  };
  scale.domain = () => [...categories];
  scale.bandwidth = () => step;
  return scale;
}

/** A point scale (bar-less charts): category → its center, no bandwidth. */
function pointScale(categories: string[], left = OFFSET.left, width = OFFSET.width) {
  const step = width / (categories.length - 1);
  const scale = (v: unknown) => {
    const i = categories.indexOf(String(v));
    return i < 0 ? undefined : left + i * step;
  };
  scale.domain = () => [...categories];
  return scale;
}

/** Month-end rows, the shape the period charts plot. */
function monthEnds(n: number, startYm = "2024-01"): string[] {
  let [y, m] = startYm.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, () => {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ymd = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    return ymd;
  });
}

/** Consecutive days from 2025-01-01. */
function days(n: number): string[] {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: n }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10)
  );
}

const bandCount = (categories: string[]) => bandBreakIndices(categories).length + 1;

describe("bandEdges", () => {
  it("puts a boundary midway between consecutive band centers, not on them", () => {
    const categories = monthEnds(6);
    const scale = bandScale(categories);
    const edges = bandEdges({ scale }, OFFSET);

    const step = OFFSET.width / categories.length;
    const centers = categories.map((_, i) => OFFSET.left + i * step + step / 2);
    expect(edges).toEqual([
      OFFSET.left,
      ...centers.slice(1).map((c, i) => (c + centers[i]!) / 2),
      OFFSET.left + OFFSET.width,
    ]);
    // Every center sits strictly inside a band, never on an edge.
    for (const c of centers) expect(edges).not.toContain(c);
  });

  it("handles a point scale, where the category is already the center", () => {
    const categories = monthEnds(5);
    const edges = bandEdges({ scale: pointScale(categories) }, OFFSET);
    const step = OFFSET.width / (categories.length - 1);
    expect(edges[1]).toBeCloseTo(OFFSET.left + step / 2, 6);
    expect(edges[0]).toBe(OFFSET.left);
    expect(edges[edges.length - 1]).toBe(OFFSET.left + OFFSET.width);
  });

  it("returns nothing without a usable scale", () => {
    expect(bandEdges({}, OFFSET)).toEqual([]);
    expect(bandEdges({ scale: bandScale([]) }, OFFSET)).toEqual([]);
  });
});

describe("bandBreakIndices", () => {
  it("bands each group while they stay wide enough", () => {
    expect(bandCount(monthEnds(13))).toBe(13); // 1y monthly — a band per month
  });

  it("steps up to quarters over three years of months", () => {
    const three = monthEnds(37);
    expect(bandCount(three)).toBe(13);
    // Breaks land on calendar quarter ends, never mid-quarter.
    for (const i of bandBreakIndices(three)) expect(Number(three[i]!.slice(5, 7)) % 3).toBe(0);
  });

  it("steps up again when quarters would still be too many", () => {
    expect(bandCount(monthEnds(61))).toBe(21); // 5y monthly — still quarters, 21 of them
    expect(bandCount(monthEnds(180))).toBe(15); // 15y monthly — years
  });

  it("bands a daily series by month, then by quarter", () => {
    expect(bandCount(days(366))).toBe(13);
    expect(bandCount(days(1096))).toBe(13);
  });

  it("keeps every band whole", () => {
    for (const categories of [monthEnds(37), monthEnds(61), days(366)]) {
      const breaks = bandBreakIndices(categories);
      expect([...breaks].sort((a, b) => a - b)).toEqual(breaks);
      expect(new Set(breaks).size).toBe(breaks.length);
      expect(breaks.every((i) => i >= 0 && i < categories.length - 1)).toBe(true);
    }
  });

  it("falls back to an even stride for categories that are not dates", () => {
    const labels = Array.from({ length: 100 }, (_, i) => `bucket ${i}`);
    expect(bandCount(labels)).toBeLessThanOrEqual(24);
    expect(bandCount(labels)).toBeGreaterThan(1);
  });
});

describe("hasBandableBarGroups", () => {
  it("bands only side-by-side bars", () => {
    expect(hasBandableBarGroups(4, 13)).toBe(true);
    // One column per tick — single or stacked — needs no bracketing.
    expect(hasBandableBarGroups(1, 13)).toBe(false);
    expect(hasBandableBarGroups(0, 13)).toBe(false);
  });

  it("needs more than one category", () => {
    expect(hasBandableBarGroups(4, 1)).toBe(false);
    expect(hasBandableBarGroups(4, 0)).toBe(false);
  });
});
