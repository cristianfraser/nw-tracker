import { describe, expect, it } from "vitest";
import {
  buildCashEqsCardBreakdown,
  buildCashSavingsCardBreakdown,
  CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG,
} from "./dashboardCardBreakdown";
import type { DashboardAccountRow } from "./types";

function cashRow(
  partial: Partial<DashboardAccountRow> & Pick<DashboardAccountRow, "account_id" | "current_value_clp">
): DashboardAccountRow {
  return {
    name: "Account",
    group_slug: "cash_eqs",
    group_label: "Cash",
    dashboard_bucket_slug: "cash_eqs",
    deposits_clp: 0,
    exclude_from_group_totals: 0,
    ...partial,
  } as DashboardAccountRow;
}

describe("cash card breakdown CC link", () => {
  const shortfall = cashRow({
    account_id: -950_000_001,
    category_slug: CASH_SAVINGS_CC_SHORTFALL_CATEGORY_SLUG,
    bucket_slug: "cash_eqs__cash_savings",
    current_value_clp: -500_000,
  });
  const reserva = cashRow({
    account_id: 1,
    category_slug: "fondo_reserva",
    bucket_slug: "cash_eqs__fondo_reserva",
    current_value_clp: 2_000_000,
  });
  const checking = cashRow({
    account_id: 2,
    category_slug: "cuenta_corriente",
    bucket_slug: "cash_eqs__cuenta_corriente",
    current_value_clp: 300_000,
  });

  it("omits shortfall from cash_eqs hub breakdown (no credit_card link)", () => {
    const lines = buildCashEqsCardBreakdown([reserva, checking, shortfall]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => !l.to?.includes("credit_card"))).toBe(true);
  });

  it("savings breakdown lists subtree accounts except shortfall (linked tarjeta is bottomLines)", () => {
    const lines = buildCashSavingsCardBreakdown([reserva, shortfall]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.clp).toBe(2_000_000);
    expect(lines.some((l) => l.clp === -500_000)).toBe(false);
    expect(lines.some((l) => l.clp === 300_000)).toBe(false);
  });
});
