import { describe, expect, it } from "vitest";
import { formatLiveInputs, parseLiveInputs } from "./liveInputs.js";

describe("X-Live-Inputs", () => {
  it("round-trips what the server writes", () => {
    const header = formatLiveInputs({ tickers: ["VEA", "BTC-USD"], fx: true, dimming: true });
    expect(header).toBe("$dimming,$fx,BTC-USD,VEA");
    expect(parseLiveInputs(header)).toEqual({ tickers: new Set(["BTC-USD", "VEA"]), fx: true, dimming: true });
  });

  it("reads none as no input and no header as unknown", () => {
    expect(formatLiveInputs({ tickers: [], fx: false, dimming: false })).toBe("none");
    expect(parseLiveInputs("none")).toEqual({ tickers: new Set(), fx: false, dimming: false });
    expect(parseLiveInputs(null)).toBeNull();
  });
});
