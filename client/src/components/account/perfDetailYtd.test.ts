import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDecimalSeparatorForFormatting } from "../../format";
import { perfDetailServesYtdPct, perfDetailYtdPct } from "./perfDetailYtd";

beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("the detalle's year-so-far %", () => {
  it("reads the server's fraction as a percent", () => {
    expect(perfDetailYtdPct({ ytd_pct: 0.0207 })).toBe("2,07%");
    expect(perfDetailYtdPct({ ytd_pct: -0.0098 })).toBe("-0,98%");
  });

  it("shows nothing when the scope serves none or the year has no return", () => {
    expect(perfDetailYtdPct({})).toBeUndefined();
    expect(perfDetailYtdPct({ ytd_pct: null })).toBeUndefined();
  });

  it("tells a scope that serves the % (even null) from one that keeps the one-step rule", () => {
    expect(perfDetailServesYtdPct({ ytd_pct: null })).toBe(true);
    expect(perfDetailServesYtdPct({ ytd_pct: 0.01 })).toBe(true);
    expect(perfDetailServesYtdPct({})).toBe(false);
  });
});
