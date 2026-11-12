import { describe, expect, it } from "vitest";
import {
  buildRealEstateCardBreakdown,
  cardMetricsByPeriodForAccountRow,
  roundedMetricDelta,
  roundedMetricDeposits,
} from "./dashboardCardBreakdown";
import type { DashboardAccountRow } from "./types";

function baseRow(overrides: Partial<DashboardAccountRow> & Pick<DashboardAccountRow, "account_id">): DashboardAccountRow {
  return {
    name: "Test",
    group_slug: "retirement",
    group_label: "Retiro",
    category_slug: "apv",
    category_label: "APV",
    deposits: 0,
    deposits_month: 0,
    deposits_year: 0,
    current_value: 0,
    valuation_as_of: null,
    ...overrides,
  };
}

describe("roundedMetricDelta cents", () => {
  const metrics = { deposits: 0, delta_total: 4.567, deposits_period: 0, delta_period: -54.327 };

  it("a currency with minor units keeps cents; pesos stay whole", () => {
    expect(roundedMetricDelta(metrics, "usd", "total")).toBe(4.57);
    expect(roundedMetricDelta(metrics, "usd", "period")).toBe(-54.33);
    expect(roundedMetricDelta({ ...metrics, delta_total: 772.444 }, "usd", "total")).toBe(772.44);
    expect(roundedMetricDelta({ ...metrics, delta_total: 4478.409 }, "eur", "total")).toBe(4478.41);
    expect(roundedMetricDelta({ ...metrics, delta_total: 772.4 }, "clp", "total")).toBe(772);
  });
});

/** Group metrics are the server's (dashboardNavCardMetrics.test.ts); one row is projected here. */
describe("cardMetricsByPeriodForAccountRow", () => {
  it("projects one row: a sold-out account keeps its deposits and lifetime P/L", () => {
    const soldOut = baseRow({
      account_id: 2,
      deposits: 1_000_000,
      delta_total: 968_035,
      deposits_month: -2_719_944,
      delta_month: -241_251,
      current_value: null,
    });
    const { month, day } = cardMetricsByPeriodForAccountRow(soldOut, "clp");
    expect(roundedMetricDeposits(month, "total")).toBe(1_000_000);
    expect(roundedMetricDeposits(month, "period")).toBe(-2_719_944);
    expect(roundedMetricDelta(month, "clp", "period")).toBe(-241_251);
    // no day fields on the row: deposits 0, P/L absent
    expect(day.deposits_period).toBe(0);
    expect(day.delta_period).toBeNull();
  });

  it("no row: zero deposits in pesos (absent elsewhere) and absent P/L", () => {
    const { year } = cardMetricsByPeriodForAccountRow(null, "clp");
    expect(year.deposits).toBe(0);
    expect(year.delta_total).toBeNull();
    expect(cardMetricsByPeriodForAccountRow(null, "usd").year.deposits).toBeNull();
  });
});

describe("buildRealEstateCardBreakdown", () => {
  const property = (id: number, name: string, value: number, loan: number) =>
    baseRow({
      account_id: id,
      name,
      group_slug: "real_estate",
      category_slug: "property",
      current_value: value,
      loan_account_id: loan,
    });
  const loan = (id: number, value: number) =>
    baseRow({ account_id: id, name: `loan ${id}`, group_slug: "liabilities", category_slug: "mortgage", current_value: value });
  const shape = (lines: ReturnType<typeof buildRealEstateCardBreakdown>) =>
    lines.map((l) => [l.depth, l.label, l.value, l.to]);
  // Vitest renders i18n in Spanish: «valor» / «hipoteca» are `realEstate.propertyValue` / `.mortgage`.

  it("one property: the head line is the property, valor and hipoteca under it", () => {
    const rows = [property(1, "Casa propia", 40, 11)];
    const lines = buildRealEstateCardBreakdown(rows, 40, "/real-estate", [...rows, loan(11, 60)]);
    expect(shape(lines)).toEqual([
      [0, "Casa propia", 40, "/account/1"],
      [1, "valor", 100, "/account/1"],
      [1, "hipoteca", 60, "/account/11"],
    ]);
  });

  it("several properties: no head line, each property at the first level with its own valor and hipoteca", () => {
    const rows = [property(1, "Centro", 40, 11), property(2, "Vitacura", 100, 12)];
    const all = [...rows, loan(11, 60), loan(12, 300)];
    const lines = buildRealEstateCardBreakdown(rows, 140, "/real-estate", all);
    expect(shape(lines)).toEqual([
      [0, "Centro", 40, "/account/1"],
      [1, "valor", 100, "/account/1"],
      [1, "hipoteca", 60, "/account/11"],
      [0, "Vitacura", 100, "/account/2"],
      [1, "valor", 400, "/account/2"],
      [1, "hipoteca", 300, "/account/12"],
    ]);
  });
});
