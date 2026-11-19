import { describe, expect, it } from "vitest";
import { decodeFintualPositions } from "./positions.js";

describe("decodeFintualPositions", () => {
  it("reads each line's symbol, Fintual's name and the shares", () => {
    expect(
      decodeFintualPositions({
        stocksPositionsV2: {
          positions: [
            { id: "1", shares: 12.345678901, asset: { id: "1", symbol: "XYZ", name: "Example Holdings PBC" } },
            { id: "2", shares: 2e-7, asset: { id: "2", symbol: "abc", name: " Another Fund " } },
          ],
        },
      })
    ).toEqual([
      { symbol: "XYZ", name: "Example Holdings PBC", shares: "12.345678901" },
      { symbol: "ABC", name: "Another Fund", shares: "0.0000002" },
    ]);
  });

  it("throws on a changed shape", () => {
    expect(() => decodeFintualPositions({ stocksPositionsV2: {} })).toThrow(/positions missing/);
    expect(() => decodeFintualPositions({ stocksPositionsV2: { positions: [{ shares: 1, asset: { name: "x" } }] } })).toThrow(/without a symbol/);
  });
});
