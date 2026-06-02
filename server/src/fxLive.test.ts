import { describe, expect, it } from "vitest";
import { shouldUseLiveFxQuote } from "./fxLive.js";

describe("shouldUseLiveFxQuote", () => {
  it("is true during NYSE regular session", () => {
    const mid = new Date("2026-05-19T11:00:00-04:00");
    expect(shouldUseLiveFxQuote(mid)).toBe(true);
  });

  it("is false after NYSE close", () => {
    const after = new Date("2026-05-19T17:00:00-04:00");
    expect(shouldUseLiveFxQuote(after)).toBe(false);
  });
});
