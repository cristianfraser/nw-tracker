import { describe, expect, it } from "vitest";
import { realizeTaxLots, taxLotTerm, type TaxLotEvent } from "./taxLots.js";

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

describe("short lots", () => {
  const open = (date: string, id: number, units: number, proceeds: number): TaxLotEvent => ({ kind: "open_short", date, movementId: id, units, proceeds });
  const close = (date: string, id: number, units: number, cost: number, assigned?: boolean): TaxLotEvent => ({
    kind: "close_short",
    date,
    movementId: id,
    units,
    cost,
    ...(assigned ? { assigned: true } : {}),
  });

  it("realizes proceeds at open less cost at close, partly and in FIFO order", () => {
    const events = [open("2026-01-05", 1, 2, 200), open("2026-01-20", 2, 2, 300), close("2026-02-01", 3, 3, 90), close("2026-02-10", 4, 1, 0)];
    const { shortCloses, openShortLots, disposals, openLots } = realizeTaxLots(events, "fifo");
    expect(disposals).toEqual([]);
    expect(openLots).toEqual([]);
    expect(shortCloses[0]).toMatchObject({ units: 3, proceeds: 200 + 150, cost: 90, gain: 260 });
    expect(shortCloses[0]!.slices).toEqual([
      { openedOn: "2026-01-05", openMovementId: 1, units: 2, proceeds: 200 },
      { openedOn: "2026-01-20", openMovementId: 2, units: 1, proceeds: 150 },
    ]);
    expect(shortCloses[1]).toMatchObject({ units: 1, proceeds: 150, cost: 0, gain: 150 });
    expect(openShortLots).toEqual([]);
  });

  it("closes the newest short first under LIFO and leaves the rest open", () => {
    const { shortCloses, openShortLots } = realizeTaxLots([open("2026-01-05", 1, 2, 200), open("2026-01-20", 2, 2, 300), close("2026-02-01", 3, 1, 10)], "lifo");
    expect(shortCloses[0]!.slices).toEqual([{ openedOn: "2026-01-20", openMovementId: 2, units: 1, proceeds: 150 }]);
    expect(openShortLots).toEqual([
      { openedOn: "2026-01-05", openMovementId: 1, units: 2, proceeds: 200 },
      { openedOn: "2026-01-20", openMovementId: 2, units: 1, proceeds: 150 },
    ]);
  });

  it("an assigned closing realizes no gain of its own and must cost nothing", () => {
    const { shortCloses } = realizeTaxLots([open("2026-01-05", 1, 1, 120), close("2026-03-01", 2, 1, 0, true)], "fifo");
    expect(shortCloses[0]).toMatchObject({ gain: 0, proceeds: 120, assigned: true });
    expect(() => realizeTaxLots([open("2026-01-05", 1, 1, 120), close("2026-03-01", 2, 1, 5, true)], "fifo")).toThrow(/must cost 0/);
  });

  it("throws on a closing with nothing open and never lets a sale go short", () => {
    expect(() => realizeTaxLots([close("2026-02-01", 1, 1, 10)], "fifo")).toThrow(/0 are open/);
    expect(() => realizeTaxLots([open("2026-01-05", 1, 1, 100), close("2026-02-01", 2, 2, 10)], "fifo")).toThrow(/closes 2 short units but 1 are open/);
    expect(() => realizeTaxLots([open("2026-01-05", 1, 1, 100), buy("2026-01-06", 2, 1, 10), sell("2026-02-01", 3, 2, 10)], "fifo")).toThrow(/but 1 are held/);
    expect(() => realizeTaxLots([open("2026-01-05", 1, 1, 100), sell("2026-02-01", 3, 1, 10)], "fifo")).toThrow(/but 0 are held/);
  });

  it("an exercised long disposal realizes nothing and keeps its premium as cost", () => {
    const { disposals } = realizeTaxLots(
      [buy("2026-01-01", 1, 1, 80), { kind: "dispose", date: "2026-03-01", movementId: 2, units: 1, proceeds: 0, exercised: true }],
      "fifo"
    );
    expect(disposals[0]).toMatchObject({ gain: 0, cost: 80, exercised: true });
  });

  it("terms: shorts are always short-term, longs need more than a year", () => {
    expect(taxLotTerm("2024-01-01", "2030-01-01", "short")).toBe("short_term");
    expect(taxLotTerm("2025-03-10", "2026-03-10", "long")).toBe("short_term");
    expect(taxLotTerm("2025-03-10", "2026-03-11", "long")).toBe("long_term");
  });
});
