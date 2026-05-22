import { describe, expect, it } from "vitest";
import {
  pickRepresentativeMonthlyPerfRow,
  type MonthlyPerfPickRow,
} from "./accountPerformanceMonthPick.js";

function row(
  as_of_date: string,
  nominal_pl: number | null,
  net_capital_flow = 0
): MonthlyPerfPickRow {
  return { as_of_date, net_capital_flow, nominal_pl };
}

describe("pickRepresentativeMonthlyPerfRow", () => {
  it("keeps the only row when one snapshot exists in the month", () => {
    const r = row("2025-03-31", 5000);
    expect(pickRepresentativeMonthlyPerfRow([r], "2025-03").as_of_date).toBe("2025-03-31");
  });

  it("prefers the row with material P/L over a trailing zero-delta month-end duplicate", () => {
    const early = row("2025-02-15", 120_000, 0);
    const trailing = row("2025-02-28", 0, 0);
    const picked = pickRepresentativeMonthlyPerfRow([early, trailing], "2025-02");
    expect(picked.as_of_date).toBe("2025-02-15");
    expect(picked.nominal_pl).toBe(120_000);
  });
});
