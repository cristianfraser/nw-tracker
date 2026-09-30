import { describe, expect, it } from "vitest";
import { cryptoTradeFeeClp } from "./cryptoTradeDetails.js";

const base = { movementId: 1, exchangeTradeId: "x", units: 1, price: 2_000_000, createdAt: "2030-01-01T00:00:00" };

describe("cryptoTradeFeeClp", () => {
  it("values a peso fee as is, a coin fee at the trade price, a swap's fee at the row's pesos per unit", () => {
    expect(cryptoTradeFeeClp({ ...base, priceCurrency: "clp", feeAmount: 4_000, feeCurrency: "clp" }, 1, 1)).toBe(4_000);
    expect(cryptoTradeFeeClp({ ...base, priceCurrency: "clp", feeAmount: 0.01, feeCurrency: "eth" }, 1, 1)).toBe(20_000);
    // A swap priced in BTC: the ETH fee is worth the row's pesos per ETH (40.000 / 0,08).
    expect(cryptoTradeFeeClp({ ...base, price: 0.06, priceCurrency: "btc", feeAmount: 0.001, feeCurrency: "eth" }, 40_000, 0.08)).toBeCloseTo(500, 9);
  });
});
