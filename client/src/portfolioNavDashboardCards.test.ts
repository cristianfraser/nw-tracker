import { describe, expect, it } from "vitest";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  mainValueAndMetricsForNavChild,
  navLeafAccountIdSet,
  navMetricsAccountIdSet,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  portfolioNavParentTitleModeForNavNode,
  titleDeltaModelForNavChild,
} from "./portfolioNavDashboardCards";
import { sumCardGroupMetrics } from "./dashboardCardBreakdown";
import { resolveDashboardBucketFromNavNode, isPortfolioStripCardNode, portfolioStripGroupChildren } from "./portfolioNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

function testTotals(
  partial: Pick<
    DashboardResponse["totals"],
    | "net_worth_clp"
    | "real_estate_clp"
    | "retirement_clp"
    | "brokerage_clp"
    | "cash_eqs_clp"
  > &
    Partial<DashboardResponse["totals"]>,
  priorOverrides?: Partial<DashboardResponse["totals"]["prior_closes"]["month"]>
): DashboardResponse["totals"] {
  const defaultPrior = {
    net_worth_clp: partial.net_worth_clp - 1_000_000,
    real_estate_clp: partial.real_estate_clp - 100_000,
    retirement_clp: partial.retirement_clp - 200_000,
    brokerage_clp: partial.brokerage_clp - 300_000,
    cash_eqs_clp: partial.cash_eqs_clp - 400_000,
  };
  const month = { ...defaultPrior, ...priorOverrides };
  const year = { ...month, ...(partial.prior_closes?.year ?? {}) };
  return {
    deposits_clp: 0,
    liabilities_clp: 0,
    prior_closes: partial.prior_closes ?? {
      month_end: "2026-05-31",
      year_end: "2025-12-31",
      month,
      year,
    },
    ...partial,
  };
}

function leafAccount(id: number): NavTreeNodeDto {
  return {
    slug: `acc-${id}`,
    label: `Account ${id}`,
    route_path: `/accounts/${id}`,
    account_id: id,
    children: [],
  };
}

describe("navLeafAccountIdSet", () => {
  it("includes leaf account ids and excludes group-only nodes", () => {
    const node: NavTreeNodeDto = {
      slug: "retirement",
      label: "Retiro",
      route_path: "/retirement",
      children: [leafAccount(1), leafAccount(2)],
    };
    const ids = navLeafAccountIdSet(node);
    expect(ids.has(1)).toBe(true);
    expect(ids.has(2)).toBe(true);
    expect(ids.size).toBe(2);
  });
});

function dashRow(
  id: number,
  clp: number,
  bucketSlug: string,
  name = `Account ${id}`
): DashboardAccountRow {
  const kind = bucketSlug.includes("fondo_reserva") ? "fondo_reserva" : "mutual_fund";
  return {
    account_id: id,
    name,
    category_slug: kind,
    category_label: kind,
    group_slug: bucketSlug,
    group_label: bucketSlug,
    bucket_slug: bucketSlug,
    current_value_clp: clp,
    current_value_usd: null,
    deposits_clp: 0,
    exclude_from_group_totals: 0,
  } as DashboardAccountRow;
}

describe("navMetricsAccountIdSet", () => {
  it("includes chart-inactive accounts in the same portfolio bucket as the nav node", () => {
    const accionesNode: NavTreeNodeDto = {
      slug: "brokerage_acciones",
      label: "Acciones",
      asset_group_slug: "brokerage__acciones",
      route_path: "/inversiones/brokerage/acciones",
      children: [{ slug: "acc-spy", label: "SPY", account_id: 10, children: [] }],
    };
    const accounts: DashboardAccountRow[] = [
      { ...dashRow(10, 1_000_000, "brokerage__acciones", "SPY"), chart_inactive: false },
      {
        ...dashRow(99, 0, "brokerage__acciones", "OILK"),
        chart_inactive: true,
        current_value_clp: 0,
      },
    ];
    const leafOnly = navLeafAccountIdSet(accionesNode);
    expect(leafOnly.has(99)).toBe(false);
    const metrics = navMetricsAccountIdSet(accionesNode, accounts);
    expect(metrics.has(10)).toBe(true);
    expect(metrics.has(99)).toBe(true);
    const rows = dashboardRowsForNavSubtree(accounts, accionesNode);
    expect(rows.map((r) => r.account_id).sort()).toEqual([10, 99]);
  });
});

describe("titleDeltaModelForNavChild", () => {
  it("always uses nav subtree (subset) mode", () => {
    expect(
      titleDeltaModelForNavChild({
        slug: "brokerage",
        label: "Brokerage",
        asset_group_slug: "brokerage",
        children: [],
      }).mode
    ).toBe("subset");
    expect(
      titleDeltaModelForNavChild({
        slug: "brokerage_mutual_funds",
        label: "Mutual funds",
        api_group: "brokerage",
        api_subgroup: "mutual_funds",
        children: [leafAccount(10)],
      }).mode
    ).toBe("subset");
  });
});

describe("resolveDashboardBucketFromNavNode cash_savings", () => {
  it("maps cash_savings nav node to cash_eqs API bucket", () => {
    expect(
      resolveDashboardBucketFromNavNode({
        slug: "cash_savings",
        label: "Ahorros y reservas",
        dashboard_bucket_slug: "cash_eqs",
        asset_group_slug: "cash_eqs__cash_savings",
        route_path: "/cash_eqs/savings",
        children: [],
      })
    ).toBe("cash_eqs");
  });
});

describe("isPortfolioStripCardNode", () => {
  it("excludes liability_group roots from net-worth dashboard cards", () => {
    expect(
      isPortfolioStripCardNode({
        slug: "liabilities",
        label: "Pasivos",
        route_path: "/liabilities",
        asset_group_slug: "liabilities",
        group_kind: "liability_group",
        children: [],
      })
    ).toBe(false);
    expect(
      isPortfolioStripCardNode({
        slug: "cash_savings",
        label: "Ahorros y reservas",
        route_path: "/cash_eqs/savings",
        portfolio_group_id: 1,
        dashboard_bucket_slug: "cash_eqs",
        asset_group_slug: "cash_eqs__cash_savings",
        group_kind: "bucket",
        children: [],
      })
    ).toBe(true);
  });
});

describe("breakdownForNavChild real_estate", () => {
  const realEstateNode: NavTreeNodeDto = {
    slug: "real_estate",
    label: "Inmuebles",
    asset_group_slug: "real_estate",
    route_path: "/real_estate",
    children: [],
  };

  const propertyRow: DashboardAccountRow = {
    account_id: 10,
    name: "suecia",
    category_slug: "property",
    category_label: "property",
    group_slug: "real_estate",
    group_label: "Inmuebles",
    bucket_slug: "property",
    current_value_clp: 144_818_228,
    current_value_usd: null,
    deposits_clp: 0,
    exclude_from_group_totals: 0,
  } as DashboardAccountRow;

  it("omits valor and hipoteca without suecia_snapshot", () => {
    const br = breakdownForNavChild(realEstateNode, [propertyRow], {
      suecia_snapshot: null,
      liabilities_breakdown: undefined,
    });
    const labels = br?.lines?.map((l) => l.label) ?? [];
    expect(labels).not.toContain("valor");
    expect(labels).not.toContain("hipoteca");
    expect(br?.lines?.[0]?.label).toBe("suecia");
  });

  it("adds valor and hipoteca when suecia_snapshot is present", () => {
    const br = breakdownForNavChild(realEstateNode, [propertyRow], {
      suecia_snapshot: {
        valor_clp: 219_480_570,
        net_value_clp: 144_878_576,
        mortgage_clp: 74_601_994,
      },
      liabilities_breakdown: undefined,
    });
    expect(br?.lines).toHaveLength(3);
    expect(br?.lines?.[0]?.label).toBe("suecia");
    expect(br?.lines?.[1]?.label).toBe("valor");
    expect(br?.lines?.[1]?.clp).toBe(219_480_570);
    expect(br?.lines?.[2]?.label).toBe("hipoteca");
    expect(br?.lines?.[2]?.clp).toBe(74_601_994);
  });
});

describe("breakdownForNavChild cash_savings", () => {
  it("builds savings account lines and linked tarjeta bottom row", () => {
    const dash = {
      suecia_snapshot: null,
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 500_000 },
      dashboard_layout: [
        {
          slug: "cash_eqs",
          label: "Ahorros",
          label_i18n_key: null,
          sort_order: 40,
          bucket_slug: "cash_eqs",
          card_css: "cash",
          linked_balances: [
            {
              slug: "credit_card",
              label: "Tarjeta",
              label_i18n_key: "liabilities.creditCard",
              clp: 500_000,
              route_path: "/liabilities/credit_card",
            },
          ],
        },
      ],
    };
    const br = breakdownForNavChild(
      {
        slug: "cash_savings",
        label: "Ahorros",
        asset_group_slug: "cash_eqs__cash_savings",
        children: [leafAccount(1)],
      },
      [dashRow(1, 2_000_000, "cash_eqs__fondo_reserva", "Reserva2")],
      dash
    );
    expect(br?.lines).toHaveLength(1);
    expect(br?.lines?.[0]?.clp).toBe(2_000_000);
    expect(br?.bottomLines?.[0]?.clp).toBe(500_000);
    expect(br?.pinBottom).toBe(true);
  });

  it("builds savings breakdown (not full cash hub) for savings nav node", () => {
    const node: NavTreeNodeDto = {
      slug: "cash_savings",
      label: "Ahorros y reservas",
      asset_group_slug: "cash_eqs__cash_savings",
      route_path: "/cash_eqs/savings",
      children: [leafAccount(1)],
    };
    const br = breakdownForNavChild(
      node,
      [
        {
          account_id: 1,
          name: "Reserva",
          category_slug: "fondo_reserva",
          category_label: "Reserva",
          group_slug: "cash_eqs",
          group_label: "Cash",
          dashboard_bucket_slug: "cash_eqs",
          bucket_slug: "cash_eqs__fondo_reserva",
          current_value_clp: 2_000_000,
          current_value_usd: null,
          deposits_clp: 0,
          exclude_from_group_totals: 0,
        } as DashboardAccountRow,
      ],
      { suecia_snapshot: null, liabilities_breakdown: undefined }
    );
    expect(br?.lines.length).toBeGreaterThan(0);
    expect(br?.lines[0]?.clp).toBe(2_000_000);
  });
});

describe("portfolioNavParentTitleModeForNavNode", () => {
  it("uses dashboard_group for bucket page with portfolio subgroup strip children", () => {
    const node: NavTreeNodeDto = {
      slug: "brokerage",
      label: "Brokerage",
      asset_group_slug: "brokerage",
      route_path: "/inversiones/brokerage",
      children: [
        {
          slug: "brokerage_mutual_funds",
          label: "MF",
          route_path: "/mf",
          portfolio_group_id: 1,
          api_subgroup: "mutual_funds",
          children: [],
        },
        {
          slug: "brokerage_acciones",
          label: "Acciones",
          route_path: "/acc",
          portfolio_group_id: 2,
          api_subgroup: "acciones",
          children: [],
        },
      ],
    };
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({
      kind: "dashboard_group",
      group: "brokerage",
    });
  });

  it("uses subset_only when strip children map to a different dashboard bucket", () => {
    const node: NavTreeNodeDto = {
      slug: "cash_eqs",
      label: "Cash",
      asset_group_slug: "cash_eqs",
      route_path: "/cash_eqs",
      children: [
        {
          slug: "real_estate",
          label: "Inmuebles",
          asset_group_slug: "real_estate",
          route_path: "/real_estate",
          children: [],
        },
      ],
    };
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({ kind: "subset_only" });
  });

  it("uses dashboard_group for leaf bucket card without subgroup children", () => {
    const node: NavTreeNodeDto = {
      slug: "real_estate",
      label: "Inmuebles",
      asset_group_slug: "real_estate",
      route_path: "/real_estate",
      children: [],
    };
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({
      kind: "dashboard_group",
      group: "real_estate",
    });
  });
});

describe("portfolioNavParentMainValue", () => {
  it("uses dashboard bucket totals for net_worth root (not raw cash savings accounts)", () => {
    const netWorthNode: NavTreeNodeDto = {
      slug: "net_worth",
      label: "Patrimonio neto",
      asset_group_slug: "net_worth",
      children: [
        {
          slug: "cash_savings",
          label: "Ahorros",
          asset_group_slug: "cash_eqs__cash_savings",
          children: [leafAccount(99)],
        },
      ],
    };
    const dash: Pick<DashboardResponse, "totals"> = {
      totals: testTotals({
        net_worth_clp: 270_525_274,
        real_estate_clp: 144_818_228,
        retirement_clp: 95_651_400,
        brokerage_clp: 16_343_745,
        cash_eqs_clp: 13_711_901,
      }),
    };
    const mode = portfolioNavParentTitleModeForNavNode(netWorthNode);
    expect(mode.kind).toBe("sum_dashboard_groups");
    const parentRows = [
      {
        account_id: 99,
        name: "Reserva2",
        current_value_clp: 24_403_210,
        current_value_usd: null,
        exclude_from_group_totals: 0,
      } as DashboardAccountRow,
    ];
    const { clp } = portfolioNavParentMainValue(dash, mode, parentRows, false);
    expect(clp).toBe(270_525_274);
    expect(clp).not.toBe(144_818_228 + 95_651_400 + 16_343_745 + 24_403_210);
  });

  it("sums strip child metrics for net_worth deposit / period rows", () => {
    const netWorthNode: NavTreeNodeDto = {
      slug: "net_worth",
      label: "Patrimonio neto",
      asset_group_slug: "net_worth",
      children: [
        {
          slug: "real_estate",
          label: "Inmuebles",
          route_path: "/real_estate",
          portfolio_group_id: 1,
          children: [leafAccount(1)],
        },
        {
          slug: "cash_savings",
          label: "Ahorros",
          route_path: "/cash_eqs/savings",
          asset_group_slug: "cash_eqs__cash_savings",
          dashboard_bucket_slug: "cash_eqs",
          portfolio_group_id: 2,
          children: [leafAccount(2)],
        },
      ],
    };
    const row = (id: number, deposits: number, deltaTotal: number, deltaMonth: number): DashboardAccountRow =>
      ({
        account_id: id,
        name: `Account ${id}`,
        group_slug: id === 1 ? "real_estate" : "cash_eqs__fondo_reserva",
        group_label: "g",
        category_slug: id === 1 ? "property" : "fondo_reserva",
        category_label: "c",
        bucket_slug: id === 1 ? "real_estate" : "cash_eqs__fondo_reserva",
        dashboard_bucket_slug: id === 1 ? "real_estate" : "cash_eqs",
        deposits_clp: deposits,
        delta_total_clp: deltaTotal,
        delta_month_clp: deltaMonth,
        deposits_month_clp: 0,
        current_value_clp: deposits + deltaTotal,
        prior_month_close_clp: deposits + deltaTotal - deltaMonth,
        exclude_from_group_totals: 0,
      }) as DashboardAccountRow;
    const dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout"> = {
      accounts: [row(1, 100, 50, 10), row(2, 200, 80, 20)],
      dashboard_layout: [],
      totals: testTotals(
        {
          net_worth_clp: 430,
          real_estate_clp: 150,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 280,
        },
        {
          net_worth_clp: 400,
          real_estate_clp: 140,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 260,
        }
      ),
    };
    const mode = portfolioNavParentTitleModeForNavNode(netWorthNode);
    const metrics = portfolioNavParentMetrics(dash, mode, dash.accounts, "month", netWorthNode, false);
    const childMetrics = sumCardGroupMetrics(
      portfolioStripGroupChildren(netWorthNode).map((child) =>
        mainValueAndMetricsForNavChild(dash, child, "month", false).metrics
      )
    );
    expect(metrics.deposits_clp).toBe(childMetrics.deposits_clp);
    expect(metrics.deposits_clp).toBe(300);
    expect(metrics.delta_total_clp).toBe(130);
    expect(metrics.delta_period_clp).toBe(30);
  });

  it("uses canonical consolidated period metrics for inversiones nav hub", () => {
    const inversionesNode: NavTreeNodeDto = {
      slug: "inversiones",
      label: "Inversiones",
      group_kind: "nav_bucket",
      route_path: "/inversiones",
      children: [
        {
          slug: "brokerage",
          label: "Brokerage",
          route_path: "/inversiones/brokerage",
          dashboard_bucket_slug: "brokerage",
          portfolio_group_id: 1,
          children: [leafAccount(1)],
        },
        {
          slug: "retirement",
          label: "Retirement",
          route_path: "/inversiones/retirement",
          dashboard_bucket_slug: "retirement",
          portfolio_group_id: 2,
          children: [leafAccount(2)],
        },
      ],
    };
    const row = (id: number, deposits: number, deltaTotal: number, deltaMonth: number): DashboardAccountRow =>
      ({
        account_id: id,
        name: `Account ${id}`,
        group_slug: id === 1 ? "brokerage_acciones" : "retirement",
        group_label: "g",
        category_slug: id === 1 ? "acciones" : "afp",
        category_label: "c",
        bucket_slug: id === 1 ? "brokerage_acciones" : "afp",
        dashboard_bucket_slug: id === 1 ? "brokerage" : "retirement",
        deposits_clp: deposits,
        delta_total_clp: deltaTotal,
        delta_month_clp: deltaMonth,
        deposits_month_clp: id === 1 ? 5_000_000 : 100_000,
        current_value_clp: deposits + deltaTotal,
        prior_month_close_clp: deposits + deltaTotal - deltaMonth,
        exclude_from_group_totals: 0,
      }) as DashboardAccountRow;
    const dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout"> & {
      inversiones_period_metrics?: import("./portfolioNavDashboardCards").InversionesPeriodMetricsDto;
    } = {
      accounts: [row(1, 100, 50, 10), row(2, 200, 80, 20)],
      dashboard_layout: [],
      totals: testTotals({
        net_worth_clp: 430,
        real_estate_clp: 0,
        retirement_clp: 280,
        brokerage_clp: 150,
        cash_eqs_clp: 0,
      }),
      inversiones_period_metrics: {
        month: {
          closing_clp: 430,
          prior_closing_clp: 400,
          net_capital_flow_clp: 5_100_000,
          nominal_pl_clp: 30,
          balance_delta_clp: 30,
        },
        year: null,
      },
    };
    const mode = portfolioNavParentTitleModeForNavNode(inversionesNode);
    expect(mode.kind).toBe("sum_dashboard_groups");
    const metrics = portfolioNavParentMetrics(
      dash,
      mode,
      dash.accounts,
      "month",
      inversionesNode,
      false
    );
    expect(metrics.deposits_period_clp).toBe(5_100_000);
    expect(metrics.delta_period_clp).toBe(30);
    expect(metrics.deposits_clp).toBe(300);
  });
});

describe("mainValueAndMetricsForNavChild", () => {
  it("sums nav subtree for brokerage subgroup strip card, not server bucket totals alone", () => {
    const mutualFundsNode: NavTreeNodeDto = {
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      route_path: "/inversiones/mutual-funds",
      portfolio_group_id: 1,
      children: [leafAccount(1), leafAccount(2)],
    };
    const dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout"> = {
      accounts: [
        {
          ...dashRow(1, 10_000_000, "brokerage_mutual_funds"),
          prior_year_close_clp: 8_000_000,
          delta_year_clp: 1_500_000,
          deposits_year_clp: 500_000,
        },
        {
          ...dashRow(2, 6_000_000, "brokerage_crypto"),
          prior_year_close_clp: 5_000_000,
          delta_year_clp: 800_000,
          deposits_year_clp: 200_000,
        },
      ],
      dashboard_layout: [],
      totals: testTotals({
        net_worth_clp: 99_000_000,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 99_000_000,
        cash_eqs_clp: 0,
      }),
    };
    const { clp, metrics } = mainValueAndMetricsForNavChild(dash, mutualFundsNode, "year", false);
    expect(clp).toBe(16_000_000);
    expect(clp).not.toBe(dash.totals.brokerage_clp);
    expect(metrics.delta_period_clp).toBe(2_300_000);
  });

  it("sums subtree accounts for brokerage subgroups, not the whole bucket", () => {
    const mutualFundsNode: NavTreeNodeDto = {
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      children: [leafAccount(1)],
    };
    const dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout"> = {
      accounts: [dashRow(1, 10_000_000, "brokerage_mutual_funds"), dashRow(2, 5_000_000, "brokerage_crypto")],
      dashboard_layout: [],
      totals: testTotals({
        net_worth_clp: 15_000_000,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 15_000_000,
        cash_eqs_clp: 0,
      }),
    };
    const { clp } = mainValueAndMetricsForNavChild(dash, mutualFundsNode, "month", false);
    expect(clp).toBe(10_000_000);
  });
});

