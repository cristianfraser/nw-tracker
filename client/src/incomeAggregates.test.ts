import { describe, expect, it, vi } from "vitest";
import { aggregateIncomeFromPayload } from "./incomeAggregates";
import type { FlowsIncomeResponse } from "./types";

const emptyWorkEarnings: Pick<
  FlowsIncomeResponse,
  | "work_earnings"
  | "income_kind_by_movement_id"
  | "payroll_period_by_movement_id"
  | "excluded_lines"
  | "filtered_lines"
> = {
  work_earnings: [],
  income_kind_by_movement_id: {},
  payroll_period_by_movement_id: {},
  excluded_lines: [],
  filtered_lines: [],
};

describe("aggregateIncomeFromPayload", () => {
  it("aggregates income rows by kind and calendar month", () => {
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
      ...emptyWorkEarnings,
      income_kind_by_movement_id: { 1: "salary" },
    };

    const view = aggregateIncomeFromPayload(data);
    expect(view.total).toBe(2_600_000);
    const withIncome = view.by_month.filter((m) => m.total_clp > 0);
    expect(withIncome).toHaveLength(2);
    expect(withIncome[0]?.period_month).toBe("2025-04");
    expect(withIncome[0]?.other_clp).toBe(100_000);
    expect(withIncome[1]?.period_month).toBe("2025-03");
    expect(withIncome[1]?.salary_clp).toBe(2_000_000);
    expect(withIncome[1]?.other_clp).toBe(500_000);
    expect(view.chart_monthly.filter((p) => p.total > 0)).toHaveLength(2);
    expect(view.chart_yearly.filter((p) => p.total > 0)).toEqual([
      {
        as_of_date: "2025-12-31",
        salary: 2_000_000,
        severance: 0,
        parent_gift: 0,
        other: 600_000,
        total: 2_600_000,
      },
    ]);
    expect(view.all_rows).toHaveLength(3);
    const salaryRow = view.all_rows.find((r) => r.kind === "checking" && r.movement_id === 1);
    expect(salaryRow?.kind === "checking" && salaryRow.income_kind).toBe("salary");
  });

  it("attributes linked salary to payroll period_month, not bank received_on", () => {
    const data: FlowsIncomeResponse = {
      lines: [
        {
          movement_id: 42,
          account_id: 10,
          account_label: "Vista",
          received_on: "2019-05-02",
          amount_clp: 2_122_917,
          amount_usd: null,
          description: "Transf. DEALSYTE CH",
          source: "checking",
        },
      ],
      manual: [],
      monthly_totals: { "2019-05": 2_122_917 },
      ...emptyWorkEarnings,
      income_kind_by_movement_id: { 42: "salary" },
      payroll_period_by_movement_id: { 42: "2019-04" },
    };

    const view = aggregateIncomeFromPayload(data);
    const withIncome = view.by_month.filter((m) => m.total_clp > 0);
    expect(withIncome).toHaveLength(1);
    expect(withIncome[0]?.period_month).toBe("2019-04");
    expect(withIncome[0]?.salary_clp).toBe(2_122_917);

    const row = view.all_rows.find((r) => r.kind === "checking" && r.movement_id === 42);
    expect(row?.kind === "checking" && row.payroll_period_month).toBe("2019-04");
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
        ...emptyWorkEarnings,
        income_kind_by_movement_id: { 1: "salary" },
      };

      const view = aggregateIncomeFromPayload(data);
      expect(view.by_month.map((r) => r.period_month)).toEqual(["2026-06", "2026-05"]);
      expect(view.by_month[0]).toMatchObject({
        period_month: "2026-06",
        salary_clp: 0,
        severance_clp: 0,
        parent_gift_clp: 0,
        other_clp: 0,
        total_clp: 0,
        line_count: 0,
        cumulative_clp: 100_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts USD synthetic work earnings as salary by period_month", () => {
    const data: FlowsIncomeResponse = {
      lines: [],
      manual: [],
      monthly_totals: {},
      work_earnings: [
        {
          id: 1,
          period_month: "2021-02",
          employer_name: "Deel (USD wire)",
          employer_rut: null,
          pay_period_label: "FEBRERO / 2021",
          earning_type: "salary",
          base_salary_clp: null,
          colacion_clp: null,
          movilizacion_clp: null,
          gratificacion_clp: null,
          total_imponible_clp: null,
          total_no_imponible_clp: null,
          total_haberes_clp: 3_200_000,
          desc_afp_clp: null,
          desc_health_clp: null,
          desc_tax_clp: null,
          desc_cesantia_clp: null,
          desc_apv_clp: null,
          desc_other_clp: 35_000,
          total_descuentos_clp: 35_000,
          liquido_clp: 3_165_000,
          liquido_usd: 4450,
          wire_received_on: "2021-02-08",
          uf_mes: null,
          utm_mes: null,
          tope_previsional_uf: null,
          tope_cesantia_uf: null,
          source_pdf: "synthetic:deel-usd|2021-02",
          movement_id: null,
          link_source: "manual",
          linked_received_on: null,
          linked_amount_clp: null,
          linked_account_label: null,
        },
      ],
      income_kind_by_movement_id: {},
      payroll_period_by_movement_id: {},
      excluded_lines: [],
      filtered_lines: [],
    };

    const clpView = aggregateIncomeFromPayload(data, "clp");
    expect(clpView.by_month.find((m) => m.period_month === "2021-02")?.salary_clp).toBe(3_165_000);

    const usdView = aggregateIncomeFromPayload(data, "usd");
    expect(usdView.by_month.find((m) => m.period_month === "2021-02")?.salary_clp).toBe(4450);
  });

  it("buckets parent_gift separately from other", () => {
    const data: FlowsIncomeResponse = {
      lines: [
        {
          movement_id: 99,
          account_id: 10,
          account_label: "Corriente",
          received_on: "2024-06-10",
          amount_clp: 500_000,
          amount_usd: null,
          description: "Transferencia papá",
          source: "checking",
        },
      ],
      manual: [],
      monthly_totals: {},
      ...emptyWorkEarnings,
      income_kind_by_movement_id: { 99: "parent_gift" },
    };

    const view = aggregateIncomeFromPayload(data);
    const june = view.by_month.find((m) => m.period_month === "2024-06");
    expect(june?.parent_gift_clp).toBe(500_000);
    expect(june?.other_clp).toBe(0);
  });
});
