import { describe, expect, it } from "vitest";
import {
  dashboardAccountRowHasMaterialBalance,
  filterDashboardAccountRowsWithMaterialBalance,
} from "./dashboardAccountMaterialBalance.js";
import type { DashboardAccountStats } from "./brokerageAcciones.js";

function row(
  partial: Partial<DashboardAccountStats> & Pick<DashboardAccountStats, "account_id">
): DashboardAccountStats {
  return {
    name: partial.name ?? "Test",
    group_slug: "brokerage",
    group_label: "Brokerage",
    bucket_slug: "brokerage_acciones",
    bucket_label: "Acciones",
    dashboard_bucket_slug: "brokerage",
    deposits_clp: 0,
    current_value_clp: partial.current_value_clp ?? null,
    valuation_as_of: null,
    current_value_usd: partial.current_value_usd ?? null,
    notes: null,
    fx_clp_per_usd: null,
    fx_date_used: null,
    chart_inactive: partial.chart_inactive ?? false,
    sync_stale: partial.sync_stale ?? false,
    ...partial,
  };
}

describe("dashboardAccountRowHasMaterialBalance", () => {
  it("excludes zero CLP and chart-inactive rows", () => {
    expect(dashboardAccountRowHasMaterialBalance(row({ account_id: 1, current_value_clp: 0 }), false)).toBe(
      false
    );
    expect(
      dashboardAccountRowHasMaterialBalance(
        row({ account_id: 2, current_value_clp: 100, chart_inactive: true }),
        false
      )
    ).toBe(false);
    expect(
      dashboardAccountRowHasMaterialBalance(row({ account_id: 3, current_value_clp: 50_000 }), false)
    ).toBe(true);
  });

  it("uses USD balance when includeUsd", () => {
    expect(
      dashboardAccountRowHasMaterialBalance(
        row({ account_id: 4, current_value_clp: 0, current_value_usd: 100 }),
        true
      )
    ).toBe(true);
    expect(
      dashboardAccountRowHasMaterialBalance(
        row({ account_id: 5, current_value_clp: 1_000_000, current_value_usd: 0 }),
        true
      )
    ).toBe(false);
  });
});

describe("filterDashboardAccountRowsWithMaterialBalance", () => {
  it("keeps only material rows", () => {
    const rows = [
      row({ account_id: 1, current_value_clp: 0 }),
      row({ account_id: 2, current_value_clp: 1 }),
    ];
    expect(filterDashboardAccountRowsWithMaterialBalance(rows, false).map((r) => r.account_id)).toEqual([2]);
  });
});
