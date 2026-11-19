import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  applyBrokerPositions,
  brokerSymbolForFundName,
  registerBrokerPositionSymbols,
} from "./brokerInstruments.js";
import { tickerFromFundName } from "./fintualEmailImport.js";
import { receiveIngestPrepared } from "./ingestHandlers.js";

const READ_AT = "2097-11-19T17:49:08.000Z";
const NONE = { registered: [], unregistered: [] };

describe("brokerInstruments", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM broker_instruments WHERE symbol LIKE 'VTST%'`).run();
  });

  it("resolves a fund name to the symbol the broker printed beside it", () => {
    const details = applyBrokerPositions(
      { broker: "fintual", read_at: READ_AT, positions: [{ symbol: "VTSTA", name: "Vitest Example PBC", shares: "12.345678901" }] },
      NONE
    );
    expect(details.new_symbols).toEqual(["VTSTA"]);
    expect(brokerSymbolForFundName("fintual", "vitest  example pbc")).toBe("VTSTA");
    // The Fintual mail planner falls back to it for a name its own map lacks.
    expect(tickerFromFundName("Vitest Example PBC")).toBe("VTSTA");
    // Another broker's statement says nothing about this one.
    expect(brokerSymbolForFundName("racional", "Vitest Example PBC")).toBeNull();
    // A second read is not new, and the name follows the latest read.
    const again = applyBrokerPositions(
      { broker: "fintual", read_at: READ_AT, positions: [{ symbol: "VTSTA", name: "Vitest Example, PBC", shares: "35" }] },
      NONE
    );
    expect(again.new_symbols).toEqual([]);
    expect(brokerSymbolForFundName("fintual", "Vitest Example PBC")).toBeNull();
    expect(brokerSymbolForFundName("fintual", "Vitest Example, PBC")).toBe("VTSTA");
  });

  it("leaves a name two symbols share for a person", () => {
    applyBrokerPositions(
      {
        broker: "fintual",
        read_at: READ_AT,
        positions: [
          { symbol: "VTSTB", name: "Vitest Twin Fund", shares: "1" },
          { symbol: "VTSTC", name: "Vitest Twin Fund", shares: "2" },
        ],
      },
      NONE
    );
    expect(brokerSymbolForFundName("fintual", "Vitest Twin Fund")).toBeNull();
  });

  it("registers only symbols the registry lacks, and nothing on a dry run", async () => {
    const plan = await registerBrokerPositionSymbols(
      {
        broker: "fintual",
        read_at: READ_AT,
        positions: [
          { symbol: "SPY", name: "State Street SPDR S&P 500 ETF Trust", shares: "1" },
          { symbol: "VTSTD", name: "Vitest Unlisted", shares: "1" },
        ],
      },
      { dryRun: true }
    );
    expect(plan).toEqual({ registered: ["VTSTD"], unregistered: [] });
  });

  it("is a broker.positions document end to end (dry run rolls back)", async () => {
    const result = await receiveIngestPrepared(
      "broker.positions",
      { broker: "fintual", read_at: READ_AT, positions: [{ symbol: "SPY", name: "State Street SPDR S&P 500 ETF Trust", shares: "1" }] },
      { source: { channel: "web_session", ref: "vitest-positions" }, dryRun: true }
    );
    expect(result.status).toBe("applied");
    expect(result.details).toMatchObject({ broker: "fintual", positions: 1, registered: [], unregistered: [] });
  });
});
