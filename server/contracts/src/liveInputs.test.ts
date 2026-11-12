import { describe, expect, it } from "vitest";
import { formatLiveInputs, parseLiveInputs } from "./liveInputs.js";

describe("X-Live-Inputs", () => {
  it("round-trips what the server writes", () => {
    const header = formatLiveInputs({ tickers: ["VEA", "BTC-USD"], fx: ["USD_CLP"], dimming: true });
    expect(header).toBe("$dimming,$fx,BTC-USD,VEA");
    expect(parseLiveInputs(header)).toEqual({ tickers: new Set(["BTC-USD", "VEA"]), fx: new Set(["USD_CLP"]), dimming: true });
  });

  it("names every live rate by its pair, the dollar first", () => {
    const header = formatLiveInputs({ tickers: ["SPY"], fx: ["EUR_USD", "USD_CLP"], dimming: false });
    expect(header).toBe("$fx,$fx:EUR_USD,SPY");
    expect(parseLiveInputs(header)?.fx).toEqual(new Set(["USD_CLP", "EUR_USD"]));
    expect(formatLiveInputs({ tickers: [], fx: ["EUR_USD"], dimming: false })).toBe("$fx:EUR_USD");
  });

  it("reads none as no input and no header as unknown", () => {
    expect(formatLiveInputs({ tickers: [], fx: [], dimming: false })).toBe("none");
    expect(parseLiveInputs("none")).toEqual({ tickers: new Set(), fx: new Set(), dimming: false });
    expect(parseLiveInputs(null)).toBeNull();
  });
});
