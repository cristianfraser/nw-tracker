import { describe, expect, it } from "vitest";
import { attributeToCard, gapBillingMonths, itemsWithLumpInBucket, monthDistance, shrinkLumpsByItems } from "./cardLinesFromReceipts.js";

describe("gapBillingMonths", () => {
  it("lists the months before the first statement, the holes between statements and the rebuilt ones", () => {
    const gaps = gapBillingMonths(["2090-04", "2090-05", "2090-07", "2090-08"], ["2090-07"], "2090-01");
    expect(gaps).toEqual([
      { month: "2090-01", kind: "before_first" },
      { month: "2090-02", kind: "before_first" },
      { month: "2090-03", kind: "before_first" },
      { month: "2090-06", kind: "between" },
      { month: "2090-07", kind: "rebuilt" },
    ]);
    expect(gapBillingMonths(["2090-04"], [], "2090-04")).toEqual([]);
    expect(gapBillingMonths([], [], "2090-01")).toEqual([]);
    expect(() => gapBillingMonths(["2090-04"], [], "2090")).toThrow(/YYYY-MM/);
  });
});

describe("attributeToCard", () => {
  it("picks the card that carried the merchant nearest in time, and refuses a tie", () => {
    expect(monthDistance("2090-01", "2090-04")).toBe(3);
    expect(attributeToCard("2090-06", [
      { account_id: 1, merchant_months: ["2090-01", "2090-09"] },
      { account_id: 2, merchant_months: ["2090-04"] },
    ])).toEqual({ kind: "card", account_id: 2, distance_months: 2 });
    expect(attributeToCard("2090-06", [
      { account_id: 1, merchant_months: ["2090-08"] },
      { account_id: 2, merchant_months: ["2090-04"] },
    ])).toEqual({ kind: "ambiguous", account_ids: [1, 2] });
    expect(attributeToCard("2090-06", [{ account_id: 1, merchant_months: [] }])).toEqual({ kind: "none" });
  });
});

describe("shrinkLumpsByItems", () => {
  const lumps = [
    { date: "2090-08-03", amount: 100_000 },
    { date: "2090-08-10", amount: 100_000 },
    { date: "2090-08-17", amount: 100_000 },
  ];
  it("takes each item out of a lump of its own month: the first on or after it, else the month's last", () => {
    expect(shrinkLumpsByItems(lumps, [
      { date: "2090-08-01", amount: 10_000 },
      { date: "2090-08-10", amount: 20_000 },
      { date: "2090-08-20", amount: 30_000 },
    ])).toEqual([
      { date: "2090-08-03", amount: 90_000 },
      { date: "2090-08-10", amount: 80_000 },
      { date: "2090-08-17", amount: 70_000 },
    ]);
    // A July item stays in July (the month-end anchor between the two must not move); an item in a
    // month with no lump is refused, and the caller sets it aside first.
    const twoMonths = [{ date: "2090-07-27", amount: 50_000 }, ...lumps];
    expect(shrinkLumpsByItems(twoMonths, [{ date: "2090-07-29", amount: 5_000 }])[0]).toEqual({ date: "2090-07-27", amount: 45_000 });
    expect(() => shrinkLumpsByItems(twoMonths, [{ date: "2090-06-30", amount: 1_000 }])).toThrow(/no estimated lump in the bucket/);
    const byCloseSide = (d: string) => `${d.slice(0, 7)}|${d <= "2090-07-25" ? "before" : "after"}`;
    const split = itemsWithLumpInBucket([{ date: "2090-07-25", amount: 1 }], [{ date: "2090-07-24" }, { date: "2090-07-30" }], byCloseSide);
    expect(split.itemizable.map((i) => i.date)).toEqual(["2090-07-24"]);
    expect(split.stranded.map((i) => i.date)).toEqual(["2090-07-30"]);
  });
  it("refuses an item the lump cannot cover", () => {
    expect(() => shrinkLumpsByItems(lumps, [{ date: "2090-08-01", amount: 100_000 }])).toThrow(/does not cover/);
    expect(() => shrinkLumpsByItems([], [{ date: "2090-08-01", amount: 1 }])).toThrow(/no estimated lump/);
  });
});
