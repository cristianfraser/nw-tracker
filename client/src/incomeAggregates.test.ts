import { describe, expect, it, vi } from "vitest";
import { aggregateIncomeFromPayload } from "./incomeAggregates";
import type { FlowsIncomeResponse } from "./types";

describe("aggregateIncomeFromPayload", () => {
  it("aggregates cartola and manual rows by calendar month", () => {
    const data: FlowsIncomeResponse = {
      lines: [
        {
          movement_id: 1,
          account_id: 10,
          account_label: "Corriente",
          received_on: "2025-03-15",
          amount_clp: 2_000_000,
          amount_usd: null,
          description: "Sueldo",
          source: "checking",
        },
        {
          movement_id: 2,
          account_id: 10,
          account_label: "Corriente",
          received_on: "2025-03-20",
          amount_clp: 500_000,
          amount_usd: null,
          description: "Bono",
          source: "checking",
        },
      ],
      manual: [
        {
          id: 3,
          received_on: "2025-04-01",
          amount_clp: 100_000,
          amount_usd: null,
          source: "Freelance",
          note: null,
          origin: "manual",
        },
      ],
      monthly_totals: { "2025-03": 2_500_000 },
    };

    const view = aggregateIncomeFromPayload(data);
    expect(view.total).toBe(2_600_000);
    const withIncome = view.by_month.filter((m) => m.total_clp > 0);
    expect(withIncome).toHaveLength(2);
    expect(withIncome[0]?.period_month).toBe("2025-04");
    expect(withIncome[0]?.manual_clp).toBe(100_000);
    expect(withIncome[1]?.period_month).toBe("2025-03");
    expect(withIncome[1]?.cartola_clp).toBe(2_500_000);
    expect(view.chart_monthly.filter((p) => p.total > 0)).toHaveLength(2);
    expect(view.chart_yearly.filter((p) => p.total > 0)).toEqual([
      {
        as_of_date: "2025-12-31",
        cartola: 2_500_000,
        manual: 100_000,
        total: 2_600_000,
      },
    ]);
    expect(view.all_rows).toHaveLength(3);
  });

  it("extends monthly table rows through Chile today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00Z"));
    try {
    const data: FlowsIncomeResponse = {
      lines: [
        {
          movement_id: 1,
          account_id: 10,
          account_label: "Corriente",
          received_on: "2026-05-15",
          amount_clp: 100_000,
          amount_usd: null,
          description: "Sueldo",
          source: "checking",
        },
      ],
      manual: [],
      monthly_totals: { "2026-05": 100_000 },
    };

    const view = aggregateIncomeFromPayload(data);
    expect(view.by_month.map((r) => r.period_month)).toEqual(["2026-06", "2026-05"]);
    expect(view.by_month[0]).toMatchObject({
      period_month: "2026-06",
      cartola_clp: 0,
      manual_clp: 0,
      total_clp: 0,
      line_count: 0,
      cumulative_clp: 100_000,
    });
    } finally {
      vi.useRealTimers();
    }
  });
});
