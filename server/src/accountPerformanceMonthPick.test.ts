import { describe, expect, it, vi } from "vitest";

const chileToday = vi.hoisted(() => ({ ymd: "2026-06-01" }));

vi.mock("./chileDate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chileDate.js")>();
  return {
    ...actual,
    chileCalendarTodayYmd: () => chileToday.ymd,
  };
});

import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";

describe("pickRepresentativeMonthlyPerfRow", () => {
  it("prefers latest on-or-before-today row in the current month", () => {
    chileToday.ymd = "2026-06-01";

    const rows = [
      { as_of_date: "2026-06-01", net_capital_flow: 0, nominal_pl: 100 },
      { as_of_date: "2026-06-30", net_capital_flow: 0, nominal_pl: 0 },
    ];
    const picked = pickRepresentativeMonthlyPerfRow(rows, "2026-06");
    expect(picked.as_of_date).toBe("2026-06-01");
    expect(picked.nominal_pl).toBe(100);
  });
});
