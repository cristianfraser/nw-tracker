import { describe, expect, it } from "vitest";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  mainValueAndMetricsForNavChild,
  inactiveAccountNavLeavesWithPeriodActivity,
  navChildCardHasPeriodActivity,
  navLeafAccountIdSet,
  navMetricsAccountIdSet,
  parentTitleBalanceDelta,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  portfolioNavParentTitleModeForNavNode,
} from "./portfolioNavDashboardCards";
import { resolveDashboardBucketFromNavNode, isPortfolioStripCardNode } from "./portfolioNavFromApi";
import type {
  DashboardAccountRow,
  DashboardResponse,
  NavCardMetricsDto,
  NavCardMetricsVariantDto,
  NavCardPeriodMetricsDto,
  NavTreeNodeDto,
} from "./types";
import { navNodeFixture } from "./test/navNodeFixture";

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
  return navNodeFixture({
    slug: `acc-${id}`,
    label: `Account ${id}`,
    route_path: `/accounts/${id}`,
    account_id: id,
    children: [],
  });
}

const zeroCardPeriodMetrics: NavCardPeriodMetricsDto = {
  deposits_clp: 0,
  deposits_usd: null,
  delta_total_clp: null,
  delta_total_usd: null,
  deposits_period_clp: 0,
  deposits_period_usd: null,
  delta_period_clp: null,
  delta_period_usd: null,
};

function cardMetricsVariantFixture(partial?: {
  day?: Partial<NavCardPeriodMetricsDto>;
  month?: Partial<NavCardPeriodMetricsDto>;
  year?: Partial<NavCardPeriodMetricsDto>;
  title?: Partial<NavCardMetricsVariantDto["title_delta"]>;
}): NavCardMetricsVariantDto {
  return {
    day: { ...zeroCardPeriodMetrics, ...partial?.day },
    month: { ...zeroCardPeriodMetrics, ...partial?.month },
    year: { ...zeroCardPeriodMetrics, ...partial?.year },
    title_delta: {
      month_clp: null,
      month_usd: null,
      year_clp: null,
      year_usd: null,
      day_clp: null,
      day_usd: null,
      ...partial?.title,
    },
  };
}

function cardMetricsEntryFixture(partial?: {
  child?: Parameters<typeof cardMetricsVariantFixture>[0];
  parent?: Parameters<typeof cardMetricsVariantFixture>[0];
}): NavCardMetricsDto {
  return {
    child: cardMetricsVariantFixture(partial?.child),
    parent: cardMetricsVariantFixture(partial?.parent),
  };
}

describe("navLeafAccountIdSet", () => {
  it("includes leaf account ids and excludes group-only nodes", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "retirement",
      label: "Retiro",
      route_path: "/retirement",
      children: [leafAccount(1), leafAccount(2)],
    });
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
    const accionesNode: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage_acciones",
      label: "Acciones",
      asset_group_slug: "brokerage__acciones",
      route_path: "/inversiones/brokerage/acciones",
      children: [navNodeFixture({ slug: "acc-spy", label: "SPY", account_id: 10, children: [] })],
    });
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

describe("resolveDashboardBucketFromNavNode cash_savings", () => {
  it("maps cash_savings nav node to cash_eqs API bucket", () => {
    expect(
      resolveDashboardBucketFromNavNode(
        navNodeFixture({
          slug: "cash_savings",
          label: "Ahorros y reservas",
          dashboard_bucket_slug: "cash_eqs",
          asset_group_slug: "cash_eqs__cash_savings",
          route_path: "/cash_eqs/savings",
          children: [],
        })
      )
    ).toBe("cash_eqs");
  });
});

describe("isPortfolioStripCardNode", () => {
  it("excludes liability_group roots from net-worth dashboard cards", () => {
    expect(
      isPortfolioStripCardNode(
        navNodeFixture({
          slug: "liabilities",
          label: "Pasivos",
          route_path: "/liabilities",
          asset_group_slug: "liabilities",
          group_kind: "liability_group",
          children: [],
        })
      )
    ).toBe(false);
    expect(
      isPortfolioStripCardNode(
        navNodeFixture({
          slug: "cash_savings",
          label: "Ahorros y reservas",
          route_path: "/cash_eqs/savings",
          portfolio_group_id: 1,
          dashboard_bucket_slug: "cash_eqs",
          asset_group_slug: "cash_eqs__cash_savings",
          group_kind: "bucket",
          children: [],
        })
      )
    ).toBe(true);
  });
});

describe("breakdownForNavChild real_estate", () => {
  const realEstateNode: NavTreeNodeDto = navNodeFixture({
    slug: "real_estate",
    label: "Inmuebles",
    asset_group_slug: "real_estate",
    route_path: "/real_estate",
    children: [],
  });

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

  it("omits valor and hipoteca without a paired mortgage account", () => {
    const br = breakdownForNavChild(realEstateNode, [propertyRow], {
      liabilities_breakdown: undefined,
    });
    const labels = br?.lines?.map((l) => l.label) ?? [];
    expect(labels).not.toContain("valor");
    expect(labels).not.toContain("hipoteca");
    expect(br?.lines?.[0]?.label).toBe("suecia");
  });

  it("synthesizes valor and hipoteca from a paired mortgage account without snapshot", () => {
    const demoProperty = {
      ...propertyRow,
      account_id: 12,
      name: "Casa propia · Demo",
      category_slug: undefined,
      bucket_slug: "real_estate__property",
      current_value_clp: 27_110_948,
    } as DashboardAccountRow;
    // Page-bundle rows have no category_slug; master + liability_view both appear.
    const demoMortgage = {
      account_id: 13,
      name: "Casa propia · Demo",
      group_slug: "liabilities__mortgage",
      group_label: "Mortgage",
      bucket_slug: "liabilities__mortgage",
      current_value_clp: 68_878_583,
      current_value_usd: null,
      deposits_clp: 0,
      exclude_from_group_totals: 0,
    } as DashboardAccountRow;
    const demoMortgageView = { ...demoMortgage, account_id: 14 } as DashboardAccountRow;
    const br = breakdownForNavChild(realEstateNode, [demoProperty], {
      liabilities_breakdown: undefined,
      accounts: [demoProperty, demoMortgage, demoMortgageView],
    });
    const lines = br?.lines ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]?.label).toBe("casa propia · demo");
    expect(lines[0]?.clp).toBe(27_110_948);
    expect(lines[1]?.label).toBe("valor");
    expect(lines[1]?.clp).toBe(27_110_948 + 68_878_583);
    expect(lines[2]?.label).toBe("hipoteca");
    expect(lines[2]?.clp).toBe(68_878_583);
  });

});

describe("breakdownForNavChild cash_savings", () => {
  it("builds savings account lines and linked tarjeta bottom row", () => {
    const dash = {
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
      navNodeFixture({
        slug: "cash_savings",
        label: "Ahorros",
        asset_group_slug: "cash_eqs__cash_savings",
        children: [leafAccount(1)],
      }),
      [dashRow(1, 2_000_000, "cash_eqs__fondo_reserva", "Reserva2")],
      dash
    );
    expect(br?.lines).toHaveLength(1);
    expect(br?.lines?.[0]?.clp).toBe(2_000_000);
    expect(br?.bottomLines?.[0]?.clp).toBe(500_000);
    expect(br?.pinBottom).toBe(true);
  });

  it("builds savings breakdown (not full cash hub) for savings nav node", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "cash_savings",
      label: "Ahorros y reservas",
      asset_group_slug: "cash_eqs__cash_savings",
      route_path: "/cash_eqs/savings",
      children: [leafAccount(1)],
    });
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
      { liabilities_breakdown: undefined }
    );
    expect(br?.lines.length).toBeGreaterThan(0);
    expect(br?.lines[0]?.clp).toBe(2_000_000);
  });
});

describe("portfolioNavParentTitleModeForNavNode", () => {
  it("uses dashboard_group for bucket page with portfolio subgroup strip children", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage",
      label: "Brokerage",
      asset_group_slug: "brokerage",
      route_path: "/inversiones/brokerage",
      children: [
        navNodeFixture({
          slug: "brokerage_mutual_funds",
          label: "MF",
          route_path: "/mf",
          portfolio_group_id: 1,
          api_subgroup: "mutual_funds",
          children: [],
        }),
        navNodeFixture({
          slug: "brokerage_acciones",
          label: "Acciones",
          route_path: "/acc",
          portfolio_group_id: 2,
          api_subgroup: "acciones",
          children: [],
        }),
      ],
    });
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({
      kind: "dashboard_group",
      group: "brokerage",
    });
  });

  it("uses subset_only when strip children map to a different dashboard bucket", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "cash_eqs",
      label: "Cash",
      asset_group_slug: "cash_eqs",
      route_path: "/cash_eqs",
      children: [
        navNodeFixture({
          slug: "real_estate",
          label: "Inmuebles",
          asset_group_slug: "real_estate",
          route_path: "/real_estate",
          children: [],
        }),
      ],
    });
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({ kind: "subset_only" });
  });

  it("uses dashboard_group for leaf bucket card without subgroup children", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "real_estate",
      label: "Inmuebles",
      asset_group_slug: "real_estate",
      route_path: "/real_estate",
      children: [],
    });
    expect(portfolioNavParentTitleModeForNavNode(node)).toEqual({
      kind: "dashboard_group",
      group: "real_estate",
    });
  });
});

describe("portfolioNavParentMainValue", () => {
  it("uses dashboard bucket totals for net_worth root (not raw cash savings accounts)", () => {
    const netWorthNode: NavTreeNodeDto = navNodeFixture({
      slug: "net_worth",
      label: "Patrimonio neto",
      asset_group_slug: "net_worth",
      children: [
        navNodeFixture({
          slug: "cash_savings",
          label: "Ahorros",
          asset_group_slug: "cash_eqs__cash_savings",
          children: [leafAccount(99)],
        }),
      ],
    });
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

  it("parent metrics and title Δ come from the served net_worth entry", () => {
    const netWorthNode: NavTreeNodeDto = navNodeFixture({
      slug: "net_worth",
      label: "Patrimonio neto",
      asset_group_slug: "net_worth",
      children: [],
    });
    const dash = {
      card_metrics_by_slug: {
        net_worth: cardMetricsEntryFixture({
          parent: {
            month: { deposits_clp: 300, delta_total_clp: 130, delta_period_clp: 30 },
            title: { month_clp: 41 },
          },
        }),
      },
    };
    const metrics = portfolioNavParentMetrics(dash, netWorthNode, "month");
    expect(metrics.deposits_clp).toBe(300);
    expect(metrics.delta_total_clp).toBe(130);
    expect(metrics.delta_period_clp).toBe(30);
    expect(parentTitleBalanceDelta(dash, netWorthNode, "month", false)).toBe(41);
    expect(parentTitleBalanceDelta(dash, netWorthNode, "month", true)).toBeNull();
  });

  it("hub parent metrics come from the served entry (consolidated period baked in server-side)", () => {
    const inversionesNode: NavTreeNodeDto = navNodeFixture({
      slug: "inversiones",
      label: "Inversiones",
      group_kind: "nav_bucket",
      route_path: "/inversiones",
      children: [],
    });
    const dash = {
      card_metrics_by_slug: {
        inversiones: cardMetricsEntryFixture({
          parent: {
            month: { deposits_clp: 300, deposits_period_clp: 5_100_000, delta_period_clp: 30 },
          },
        }),
      },
    };
    const metrics = portfolioNavParentMetrics(dash, inversionesNode, "month");
    expect(metrics.deposits_period_clp).toBe(5_100_000);
    expect(metrics.delta_period_clp).toBe(30);
    expect(metrics.deposits_clp).toBe(300);
  });

  it("throws on a missing entry instead of re-summing rows", () => {
    const node: NavTreeNodeDto = navNodeFixture({ slug: "brokerage", label: "B", children: [] });
    expect(() => portfolioNavParentMetrics({ card_metrics_by_slug: {} }, node, "month")).toThrow(
      /no entry for nav node/
    );
  });
});

describe("mainValueAndMetricsForNavChild", () => {
  it("sums nav subtree for brokerage subgroup strip card, not server bucket totals alone", () => {
    const mutualFundsNode: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      route_path: "/inversiones/mutual-funds",
      portfolio_group_id: 1,
      children: [leafAccount(1), leafAccount(2)],
    });
    const dash: Pick<
      DashboardResponse,
      "accounts" | "totals" | "dashboard_layout" | "card_metrics_by_slug"
    > = {
      card_metrics_by_slug: {
        brokerage_mutual_funds: cardMetricsEntryFixture({
          child: { year: { delta_period_clp: 2_300_000 } },
        }),
      },
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
    expect(
      mainValueAndMetricsForNavChild(dash, mutualFundsNode, "month", false).metrics
        .delta_period_clp
    ).toBeNull();
  });

  it("sums subtree accounts for brokerage subgroups, not the whole bucket", () => {
    const mutualFundsNode: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      children: [leafAccount(1)],
    });
    const dash: Pick<
      DashboardResponse,
      "accounts" | "totals" | "dashboard_layout" | "card_metrics_by_slug"
    > = {
      card_metrics_by_slug: {
        brokerage_mutual_funds: cardMetricsEntryFixture(),
      },
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


describe("navChildCardHasPeriodActivity", () => {
  /** Wound-down bucket: only account is chart-inactive at $0, activity only in the year window. */
  const inactiveMutualFundsNode: NavTreeNodeDto = navNodeFixture({
    slug: "brokerage_mutual_funds",
    label: "Mutual funds",
    route_path: "/inversiones/brokerage/mutual-funds",
    portfolio_group_id: 1,
    chart_inactive: true,
    children: [],
  });
  const dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "dashboard_layout" | "card_metrics_by_slug"
  > = {
    card_metrics_by_slug: {
      brokerage_mutual_funds: cardMetricsEntryFixture({
        child: {
          year: { deposits_period_clp: -21_000_000, delta_period_clp: 300_000 },
          title: { year_clp: -20_700_000 },
        },
      }),
    },
    accounts: [
      {
        ...dashRow(45, 0, "brokerage__mutual_funds"),
        chart_inactive: true,
        deposits_month_clp: 0,
        delta_month_clp: 0,
        prior_month_close_clp: 0,
        deposits_year_clp: -21_000_000,
        delta_year_clp: 300_000,
        prior_year_close_clp: 20_700_000,
      },
    ],
    dashboard_layout: [],
    totals: testTotals({
      net_worth_clp: 0,
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 0,
      cash_eqs_clp: 0,
    }),
  };

  it("reports no activity for the month view (zero balance, zero month flows)", () => {
    expect(navChildCardHasPeriodActivity(dash, inactiveMutualFundsNode, "month", false)).toBe(
      false
    );
  });

  it("reports activity for the year view (year flows and Δ nonzero)", () => {
    expect(navChildCardHasPeriodActivity(dash, inactiveMutualFundsNode, "year", false)).toBe(
      true
    );
  });
});

describe("inactiveAccountNavLeavesWithPeriodActivity", () => {
  const mutualFundsNode: NavTreeNodeDto = navNodeFixture({
    slug: "brokerage_mutual_funds",
    label: "Mutual funds",
    route_path: "/inversiones/brokerage/mutual-funds",
    portfolio_group_id: 1,
    chart_inactive: true,
    children: [],
  });
  const inactiveRow = {
    ...dashRow(45, 0, "brokerage__mutual_funds", "caca daca"),
    chart_inactive: true,
    deposits_month_clp: 0,
    delta_month_clp: 0,
    prior_month_close_clp: 0,
    deposits_year_clp: -21_000_000,
    delta_year_clp: 300_000,
    prior_year_close_clp: 20_700_000,
  };
  const dash = { accounts: [inactiveRow] };

  it("synthesizes a leaf card only for the period with activity", () => {
    expect(inactiveAccountNavLeavesWithPeriodActivity(dash, mutualFundsNode, [], "month")).toEqual(
      []
    );
    const year = inactiveAccountNavLeavesWithPeriodActivity(dash, mutualFundsNode, [], "year");
    expect(year.map((n) => n.account_id)).toEqual([45]);
    expect(year[0]!.route_path).toBe("/account/45");
    expect(year[0]!.chart_inactive).toBe(true);
  });

  it("skips rows already covered by a group-child detail card", () => {
    const brokerageNode: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage",
      label: "Brokerage",
      route_path: "/inversiones/brokerage",
      children: [mutualFundsNode],
    });
    expect(
      inactiveAccountNavLeavesWithPeriodActivity(dash, brokerageNode, [mutualFundsNode], "year")
    ).toEqual([]);
  });

  it("skips accounts that are still nav leaves (active)", () => {
    const parentWithLeaf: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      route_path: "/inversiones/brokerage/mutual-funds",
      children: [leafAccount(45)],
    });
    expect(
      inactiveAccountNavLeavesWithPeriodActivity(dash, parentWithLeaf, [], "year")
    ).toEqual([]);
  });
});
