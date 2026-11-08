import { describe, expect, it } from "vitest";
import { pairOneToOne, rankByDistance } from "./pairing.js";

type Rec = { id: string; day: number; amount: number };
const rec = (id: string, day: number, amount = 100): Rec => ({ id, day, amount });
const base = {
  accepts: (l: Rec, r: Rec) => l.amount === r.amount && Math.abs(l.day - r.day) <= 3,
  distance: (l: Rec, r: Rec) => Math.abs(l.day - r.day),
};

describe("pairOneToOne — nearest", () => {
  it("pairs each left with the nearest day and uses a right once", () => {
    const lefts = [rec("a", 10), rec("b", 11)];
    const rights = [rec("x", 12), rec("y", 10)];
    const out = pairOneToOne(lefts, rights, { ...base, strategy: "nearest" });
    expect(out.pairs.map((p) => [p.left.id, p.right.id])).toEqual([["a", "y"], ["b", "x"]]);
    expect(out.unclaimed).toEqual([]);
  });

  it("reports two rights equally near instead of choosing", () => {
    const out = pairOneToOne([rec("a", 10)], [rec("x", 9), rec("y", 11)], { ...base, strategy: "nearest" });
    expect(out.pairs).toEqual([]);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]!.rights.map((r) => r.id)).toEqual(["x", "y"]);
    expect(out.unpaired).toEqual([]);
  });

  it("pairs identical twins in input order", () => {
    const twins = (a: Rec, b: Rec) => a.day === b.day && a.amount === b.amount;
    const out = pairOneToOne([rec("a", 10), rec("b", 10)], [rec("x", 9), rec("y", 9)], { ...base, strategy: "nearest", twins });
    expect(out.pairs.map((p) => [p.left.id, p.right.id])).toEqual([["a", "x"], ["b", "y"]]);
    expect(out.ambiguous).toEqual([]);
  });

  it("leaves a left with nothing in the window unpaired", () => {
    const out = pairOneToOne([rec("a", 10)], [rec("x", 20)], { ...base, strategy: "nearest" });
    expect(out.unpaired.map((l) => l.id)).toEqual(["a"]);
    expect(out.unclaimed.map((r) => r.id)).toEqual(["x"]);
  });
});

describe("pairOneToOne — first", () => {
  it("takes the first acceptable right in input order, not the nearest", () => {
    const out = pairOneToOne([rec("a", 10)], [rec("x", 13), rec("y", 10)], { ...base, strategy: "first" });
    expect(out.pairs.map((p) => p.right.id)).toEqual(["x"]);
    expect(out.ambiguous).toEqual([]);
  });
});

describe("pairOneToOne — unique", () => {
  it("reports several candidates as ambiguous whatever their distance", () => {
    const out = pairOneToOne([rec("a", 10)], [rec("x", 10), rec("y", 12)], { ...base, strategy: "unique" });
    expect(out.pairs).toEqual([]);
    expect(out.ambiguous).toHaveLength(1);
  });

  it("claims a right once: the second left finds none left", () => {
    const out = pairOneToOne([rec("a", 10), rec("b", 10)], [rec("x", 10)], { ...base, strategy: "unique" });
    expect(out.pairs.map((p) => p.left.id)).toEqual(["a"]);
    expect(out.unpaired.map((l) => l.id)).toEqual(["b"]);
  });
});

describe("pairOneToOne — nearest_global", () => {
  it("closest pairs claim first so same-amount peers do not strand each other", () => {
    // Left order would give a→x (gap 3) and strand b; globally b→x (gap 0) and a→y (gap 2).
    const out = pairOneToOne([rec("a", 10), rec("b", 13)], [rec("x", 13), rec("y", 12)], { ...base, strategy: "nearest_global" });
    expect(out.pairs.map((p) => [p.left.id, p.right.id]).sort()).toEqual([["a", "y"], ["b", "x"]]);
    expect(out.tied).toBe(0);
  });

  it("pairs a tie in the declared order and counts it", () => {
    const out = pairOneToOne([rec("a", 10)], [rec("x", 9), rec("y", 11)], {
      ...base,
      strategy: "nearest_global",
      tieBreak: (p, q) => q.right.day - p.right.day,
    });
    expect(out.pairs.map((p) => p.right.id)).toEqual(["y"]);
    expect(out.tied).toBe(1);
  });
});

describe("rankByDistance", () => {
  it("orders nearest first, stable, and flags a tie at the top", () => {
    const r = rankByDistance(["a", "b", "c"], (c) => ({ a: 2, b: 1, c: 1 })[c as "a"]!);
    expect(r.ranked.map((x) => x.item)).toEqual(["b", "c", "a"]);
    expect(r.tiedAtTop).toBe(true);
    expect(rankByDistance(["a"], () => 0).tiedAtTop).toBe(false);
  });
});
