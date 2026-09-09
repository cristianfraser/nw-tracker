import { describe, expect, it } from "vitest";
import { shouldUseLiveFxQuote } from "./fxLive.js";

describe("shouldUseLiveFxQuote", () => {
  it("is true while the fx day is open — NYSE hours, US holidays and Chilean holidays alike", () => {
    expect(shouldUseLiveFxQuote(new Date("2026-05-19T11:00:00-04:00"))).toBe(true);
    expect(shouldUseLiveFxQuote(new Date("2026-05-25T11:00:00-04:00"))).toBe(true); // Memorial Day
    expect(shouldUseLiveFxQuote(new Date("2026-05-21T11:00:00-04:00"))).toBe(true); // Glorias Navales
  });

  it("is false after 17:05 New York and on weekends", () => {
    expect(shouldUseLiveFxQuote(new Date("2026-05-19T17:10:00-04:00"))).toBe(false);
    expect(shouldUseLiveFxQuote(new Date("2026-05-23T11:00:00-04:00"))).toBe(false); // Saturday
  });
});
