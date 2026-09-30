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

  it("excludes the commission: a buy costs what was paid less it, a sale earns what was received plus it", () => {
    const rows = [
      { id: 1, occurred_on: "2030-01-10", amount: 100_000, units_delta: 0.02 },
      { id: 2, occurred_on: "2030-06-01", amount: -300_000, units_delta: -0.01 },
    ];
    const kinds = new Map<number, CryptoMovementKind>([
      [1, "buy"],
      [2, "sell"],
    ]);
    const detail = (movementId: number, feeAmount: number, feeCurrency: "clp" | "btc") => ({
      movementId,
      exchangeTradeId: `t${movementId}`,
      units: 0.02,
      price: 30_000_000,
      priceCurrency: "clp" as const,
      feeAmount,
      feeCurrency,
      createdAt: "2030-01-10T10:00:00",
    });
    // Buy: 1.200 pesos of commission; sale: 0,0001 coin × 30.000.000 = 3.000 pesos.
    const details = new Map([
      [1, detail(1, 1_200, "clp")],
      [2, detail(2, 0.0001, "btc")],
    ]);
    const events = cryptoTaxLotEventsFromRows(rows, kinds, { policy: "excluded", details });
    expect(events.map((e) => (e.kind === "acquire" ? e.cost : e.proceeds))).toEqual([98_800, 303_000]);
    expect(() => cryptoTaxLotEventsFromRows(rows, kinds, { policy: "excluded", details: new Map() })).toThrow(
      /no exchange record/
    );
  });
});
