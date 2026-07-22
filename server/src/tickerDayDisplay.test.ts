import { describe, expect, it } from "vitest";
import {
  displayDayPct,
  equityTickerDayCalendar,
  tickerMarketOpenOnYmd,
} from "./tickerDayDisplay.js";

describe("equityTickerDayCalendar", () => {
  it("maps market kinds to display calendars", () => {
    expect(equityTickerDayCalendar("SPY")).toBe("nyse");
    expect(equityTickerDayCalendar("CFIETFIPSA.SN")).toBe("chile");
    expect(equityTickerDayCalendar("BTC-USD")).toBe("always");
  });
});

describe("tickerMarketOpenOnYmd", () => {
  it("weekend closes everything except always-open", () => {
    const sat = "2026-03-21";
    expect(tickerMarketOpenOnYmd("nyse", sat)).toBe(false);
    expect(tickerMarketOpenOnYmd("chile", sat)).toBe(false);
    expect(tickerMarketOpenOnYmd("weekday", sat)).toBe(false);
    expect(tickerMarketOpenOnYmd("always", sat)).toBe(true);
  });

  it("US holiday closes NYSE only; Chilean holiday closes Chile only", () => {
    // 2025-07-04 (Fri): NYSE holiday, ordinary Chilean business day, fx trades.
    expect(tickerMarketOpenOnYmd("nyse", "2025-07-04")).toBe(false);
    expect(tickerMarketOpenOnYmd("chile", "2025-07-04")).toBe(true);
    expect(tickerMarketOpenOnYmd("weekday", "2025-07-04")).toBe(true);
    // 2026-06-29 (Mon): Chilean holiday (San Pedro y San Pablo), NYSE trades.
    expect(tickerMarketOpenOnYmd("chile", "2026-06-29")).toBe(false);
    expect(tickerMarketOpenOnYmd("nyse", "2026-06-29")).toBe(true);
  });
});

describe("displayDayPct", () => {
  it("passes the real change through on open days, hard-0 on closed days, null through", () => {
    expect(displayDayPct("nyse", "2026-03-25", 1.23)).toBe(1.23); // Wednesday
    expect(displayDayPct("nyse", "2026-03-21", 1.23)).toBe(0); // Saturday
    expect(displayDayPct("always", "2026-03-21", -0.4)).toBe(-0.4);
    expect(displayDayPct("nyse", "2026-03-21", null)).toBeNull();
  });
});
