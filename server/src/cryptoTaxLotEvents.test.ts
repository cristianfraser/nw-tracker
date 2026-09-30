import { describe, expect, it } from "vitest";
import { cryptoTaxLotEventsFromRows } from "./cryptoTaxLotEvents.js";
import type { CryptoMovementKind } from "./cryptoMovementKinds.js";

describe("cryptoTaxLotEventsFromRows", () => {
  it("maps each kind to its lot treatment", () => {
    const rows = [
      { id: 1, occurred_on: "2030-01-10", amount: 40_000, units_delta: 0.01 },
      { id: 2, occurred_on: "2030-03-01", amount: 0, units_delta: -0.001 },
      { id: 3, occurred_on: "2030-04-10", amount: 0, units_delta: 0.4 },
      { id: 4, occurred_on: "2030-05-20", amount: -20_000, units_delta: -0.001 },
      { id: 5, occurred_on: "2030-06-01", amount: -2_000_000, units_delta: -1 },
    ];
    const kinds = new Map<number, CryptoMovementKind>([
      [1, "buy"],
      [2, "send_fee"],
      [3, "round_trip_return"],
      [4, "coin_out"],
      [5, "sell"],
    ]);
    expect(cryptoTaxLotEventsFromRows(rows, kinds)).toEqual([
      { kind: "acquire", date: "2030-01-10", movementId: 1, units: 0.01, cost: 40_000 },
      { kind: "dispose", date: "2030-03-01", movementId: 2, units: 0.001, proceeds: 0 },
      { kind: "acquire", date: "2030-04-10", movementId: 3, units: 0.4, cost: 0 },
      { kind: "dispose", date: "2030-05-20", movementId: 4, units: 0.001, proceeds: 20_000 },
      { kind: "dispose", date: "2030-06-01", movementId: 5, units: 1, proceeds: 2_000_000 },
    ]);
  });

  it("throws when the units move against the kind", () => {
    expect(() =>
      cryptoTaxLotEventsFromRows([{ id: 1, occurred_on: "2025-01-01", amount: 100, units_delta: 1 }], new Map([[1, "sell"]]))
    ).toThrow(/\(sell\) moves 1 units/);
  });
});
