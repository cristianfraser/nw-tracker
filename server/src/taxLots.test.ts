import { describe, expect, it } from "vitest";
import { realizeTaxLots, type TaxLotEvent } from "./taxLots.js";

const buy = (date: string, movementId: number, units: number, cost: number): TaxLotEvent => ({
  kind: "acquire",
  date,
  movementId,
  units,
  cost,
});
const sell = (date: string, movementId: number, units: number, proceeds: number): TaxLotEvent => ({
  kind: "dispose",
  date,
  movementId,
  units,
  proceeds,
});

// Two purchases at different prices, then a sale that needs part of each.
const EVENTS = [buy("2024-01-10", 1, 10, 100), buy("2024-06-10", 2, 10, 200), sell("2025-01-10", 3, 15, 300)];

describe("realizeTaxLots", () => {
  it("FIFO consumes the oldest purchase first and splits a lot pro rata", () => {
    const { disposals, openLots } = realizeTaxLots(EVENTS, "fifo");
    expect(disposals).toEqual([
      {
        date: "2025-01-10",
        movementId: 3,
        units: 15,
        proceeds: 300,
        cost: 200,
        gain: 100,
        slices: [
          { acquiredOn: "2024-01-10", acquireMovementId: 1, units: 10, cost: 100 },
          { acquiredOn: "2024-06-10", acquireMovementId: 2, units: 5, cost: 100 },
        ],
      },
    ]);
    expect(openLots).toEqual([{ acquiredOn: "2024-06-10", acquireMovementId: 2, units: 5, cost: 100 }]);
  });

  it("LIFO consumes the newest purchase first", () => {
    const { disposals, openLots } = realizeTaxLots(EVENTS, "lifo");
    // Slices are listed oldest purchase first whatever the method.
    expect(disposals[0]!.slices).toEqual([
      { acquiredOn: "2024-01-10", acquireMovementId: 1, units: 5, cost: 50 },
      { acquiredOn: "2024-06-10", acquireMovementId: 2, units: 10, cost: 200 },
    ]);
    expect(disposals[0]!.gain).toBe(50);
    expect(openLots).toEqual([{ acquiredOn: "2024-01-10", acquireMovementId: 1, units: 5, cost: 50 }]);
  });

  it("average cost charges the pool's average and takes every lot pro rata", () => {
    const { disposals, openLots } = realizeTaxLots(EVENTS, "average");
    // Pool: 20 units for 300 → 15 per unit; 15 units cost 225.
    expect(disposals[0]!.cost).toBeCloseTo(225, 9);
    expect(disposals[0]!.gain).toBeCloseTo(75, 9);
    expect(disposals[0]!.slices.map((x) => [x.acquireMovementId, x.units])).toEqual([
      [1, 7.5],
      [2, 7.5],
    ]);
    expect(openLots.map((l) => [l.units, l.cost])).toEqual([
      [2.5, 25],
      [2.5, 50],
    ]);
  });

  it("takes a custom selector (specific identification), and checks what it returns", () => {
    const secondLotFirst = (lots: readonly { units: number }[], units: number) =>
      lots.map((l, i) => (i === 1 ? Math.min(units, l.units) : Math.max(0, units - lots[1]!.units) * (i === 0 ? 1 : 0)));
    expect(realizeTaxLots(EVENTS, secondLotFirst).disposals[0]!.cost).toBe(250);
    expect(() => realizeTaxLots(EVENTS, (lots) => lots.map(() => 1))).toThrow(/took 2 units/);
  });

  it("a reinvested dividend is an ordinary purchase, fractional units included", () => {
    const { disposals } = realizeTaxLots(
      [buy("2030-05-02", 1, 40.123456789, 2000), buy("2030-05-20", 2, 0.876543211, 50), sell("2030-06-01", 3, 41, 1800)],
      "fifo"
    );
    expect(disposals[0]!.cost).toBeCloseTo(2050, 6);
    expect(disposals[0]!.gain).toBeCloseTo(-250, 6);
    expect(disposals[0]!.slices).toHaveLength(2);
  });

  it("tolerates float noise in the share count but not a real oversell", () => {
    expect(() => realizeTaxLots([buy("2026-01-01", 1, 1, 10), sell("2026-02-01", 2, 1 + 1e-10, 12)], "fifo")).not.toThrow();
    expect(() => realizeTaxLots([buy("2026-01-01", 1, 1, 10), sell("2026-02-01", 2, 1.01, 12)], "fifo")).toThrow(
      /sells 1.01 units but 1 are held/
    );
  });

  it("zero-cost and zero-proceeds events are valid (a coin received for free, a coin lost as a fee)", () => {
    const { disposals } = realizeTaxLots([buy("2026-01-01", 1, 2, 0), sell("2026-02-01", 2, 1, 0)], "fifo");
    expect(disposals[0]).toMatchObject({ cost: 0, proceeds: 0, gain: 0 });
  });

  it("throws on events out of date order and on non-positive units", () => {
    expect(() => realizeTaxLots([buy("2026-02-01", 1, 1, 1), buy("2026-01-01", 2, 1, 1)], "fifo")).toThrow(/comes after/);
    expect(() => realizeTaxLots([buy("2026-01-01", 1, 0, 1)], "fifo")).toThrow(/0 units/);
  });
});
