import { describe, expect, it } from "vitest";
import { buildNavCardBreakdown } from "./navCardBreakdown";
import { navNodeFixture } from "./test/navNodeFixture";
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

describe("cash card breakdown", () => {
  const reserva = cashRow({
    account_id: 1,
    name: "Reserva",
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

  /**
   * The savings card goes through the generic nav builder (no cash special case). Its single
   * account still gets a line, and another account scoped to the same bucket must not.
   */
  it("savings nav card lists its own account only", () => {
    const savingsNode = navNodeFixture({
      slug: "cash_savings",
      label: "Ahorros y reservas",
      route_path: "/cash_eqs/savings",
      portfolio_group_id: 7,
      kind_slug: "cash_savings",
      asset_group_slug: "cash_eqs__cash_savings",
      children: [
        navNodeFixture({
          slug: "account_1",
          label: "Reserva",
          route_path: "/account/1",
          account_id: 1,
          children: [],
        }),
      ],
    });

    const lines = buildNavCardBreakdown(savingsNode, [reserva, checking]);

    expect(lines).not.toBeNull();
    expect(lines!.map((l) => l.label)).toEqual(["Reserva"]);
    expect(lines!.some((l) => l.clp === 300_000)).toBe(false);
  });
});
