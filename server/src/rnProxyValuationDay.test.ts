import { afterEach, describe, expect, it, vi } from "vitest";
import {
  heldProxyValuationDayYmd,
  isFxOnlyProxyDay,
  priorProxyValuationDayYmd,
  proxyValuationDayOnOrBefore,
} from "./rnProxyValuationDay.js";
import { stubObservadoWindowFrom09 } from "./test/observadoWindowStub.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Risky Norris proxy valuation days", () => {
  it("treats a US holiday Chile works as a day of its own, and weekends as the day before", () => {
    expect(isFxOnlyProxyDay("2026-11-26")).toBe(true); // Thanksgiving, Chile business day
    expect(isFxOnlyProxyDay("2026-11-25")).toBe(false); // NYSE trades
    expect(isFxOnlyProxyDay("2026-11-28")).toBe(false); // Saturday
    expect(isFxOnlyProxyDay("2026-12-25")).toBe(false); // both markets closed
    expect(proxyValuationDayOnOrBefore("2026-11-26")).toBe("2026-11-26");
    expect(proxyValuationDayOnOrBefore("2026-11-29")).toBe("2026-11-27"); // Sunday → Friday's session
    expect(priorProxyValuationDayYmd("2026-11-27")).toBe("2026-11-26");
    expect(priorProxyValuationDayYmd("2026-11-26")).toBe("2026-11-25");
  });

  it("holds Thanksgiving from its first fx prints, through the next morning's pre-open", () => {
    // Chile UTC−3, New York EST UTC−5.
    stubObservadoWindowFrom09();
    const probes: [string, string][] = [
      ["2026-11-26T03:30:00Z", "2026-11-25"], // Thu 00:30 Chile, New York still on Wednesday
      ["2026-11-26T06:00:00Z", "2026-11-25"], // Thu 03:00 Chile: the holiday has no fx of its own yet
      ["2026-11-26T12:05:00Z", "2026-11-26"], // Thu 09:05 Chile: the fx window has prints
      ["2026-11-26T23:00:00Z", "2026-11-26"], // Thu 20:00 Chile
      ["2026-11-27T04:00:00Z", "2026-11-26"], // Fri 01:00 Chile, New York still on the holiday
      ["2026-11-27T12:00:00Z", "2026-11-26"], // Fri 09:00 Chile, pre-open
      ["2026-11-27T15:00:00Z", "2026-11-27"], // Fri 12:00 Chile: live session
      ["2026-11-28T15:00:00Z", "2026-11-27"], // Saturday
    ];
    for (const [iso, expected] of probes) {
      expect(heldProxyValuationDayYmd(new Date(iso)), iso).toBe(expected);
    }
  });
});
