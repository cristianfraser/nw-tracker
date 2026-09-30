import { describe, expect, it } from "vitest";
import { deduceCryptoMovementKinds, type CryptoCoinRow } from "./cryptoMovementKinds.js";

const BTC = 9001;
const ETH = 9002;
const coin = (id: number, account_id: number, occurred_on: string, amount: number, units_delta: number, flow_kind: string | null = null): CryptoCoinRow => ({
  id,
  account_id,
  occurred_on,
  amount,
  units_delta,
  flow_kind,
});

describe("deduceCryptoMovementKinds", () => {
  it("pairs trades with the buffer, finds swaps, and classifies the rest", () => {
    const kinds = deduceCryptoMovementKinds(
      [
        coin(1, BTC, "2030-01-10", 40_000, 0.01),
        coin(2, BTC, "2030-02-10", -500_000, -0.04),
        coin(3, BTC, "2030-03-01", -30_000, -0.004),
        coin(4, ETH, "2030-03-01", 30_000, 0.07),
        coin(5, ETH, "2030-03-01", 0, -0.001, "cash_fee"),
        coin(6, ETH, "2030-04-10", 0, 0.3, "savings_earnings"),
        coin(7, BTC, "2030-05-20", -20_000, -0.001),
      ],
      [
        { id: 100, occurred_on: "2030-01-10", amount: -40_000 },
        { id: 101, occurred_on: "2030-02-10", amount: 500_000 },
        // A deposit of other pesos the same day as the send: not its counterpart.
        { id: 102, occurred_on: "2030-05-20", amount: 100_000 },
      ]
    );
    expect(Object.fromEntries(kinds)).toEqual({
      1: "buy",
      2: "sell",
      3: "swap_out",
      4: "swap_in",
      5: "send_fee",
      6: "round_trip_return",
      7: "coin_out",
    });
  });

  it("pairs twin trades one to one", () => {
    const kinds = deduceCryptoMovementKinds(
      [coin(1, BTC, "2025-01-01", 1000, 0.1), coin(2, BTC, "2025-01-01", 1000, 0.1)],
      [
        { id: 100, occurred_on: "2025-01-01", amount: -1000 },
        { id: 101, occurred_on: "2025-01-01", amount: -1000 },
      ]
    );
    expect(Object.fromEntries(kinds)).toEqual({ 1: "buy", 2: "buy" });
  });

  it("throws on coin that arrives with nothing to explain it", () => {
    expect(() =>
      deduceCryptoMovementKinds([coin(1, BTC, "2025-01-01", 1000, 0.1), coin(2, BTC, "2025-01-01", 1000, 0.1)], [
        { id: 100, occurred_on: "2025-01-01", amount: -1000 },
      ])
    ).toThrow(/movement 2 adds 0.1 coin/);
    expect(() => deduceCryptoMovementKinds([coin(1, BTC, "2025-01-01", 0, 0.1, "cash_fee")], [])).toThrow(/adds coin/);
  });
});
