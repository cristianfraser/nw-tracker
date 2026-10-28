import { describe, expect, it } from "vitest";
import i18n from "./i18n";
import {
  breakdownForNavChild,
  mainValueForNavChild,
  navChildCardHasActivity,
  navParentMainValue,
  requireNavCardMetrics,
} from "./portfolioNavDashboardCards";
import { resolveDashboardBucketFromNavNode, isPortfolioStripCardNode } from "./portfolioNavFromApi";
import type {
  DashboardAccountRow,
  DashboardResponse,
  NavCardAmountDto,
  NavCardMetricsDto,
  NavCardMetricsVariantDto,
  NavCardPeriodMetricsDto,
  NavTreeNodeDto,
} from "./types";
import { navNodeFixture } from "./test/navNodeFixture";

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
}): NavCardMetricsVariantDto {
  return {
    day: { ...zeroCardPeriodMetrics, ...partial?.day },
    month: { ...zeroCardPeriodMetrics, ...partial?.month },
    year: { ...zeroCardPeriodMetrics, ...partial?.year },
  };
}

function cardMetricsEntryFixture(partial?: {
  child?: Parameters<typeof cardMetricsVariantFixture>[0];
  parent?: Parameters<typeof cardMetricsVariantFixture>[0];
  value?: { child?: NavCardAmountDto; parent?: NavCardAmountDto; members?: NavCardAmountDto };
}): NavCardMetricsDto {
  const zero: NavCardAmountDto = { clp: 0, usd: null };
  return {
    value: {
      child: partial?.value?.child ?? zero,
      parent: partial?.value?.parent ?? zero,
      members: partial?.value?.members ?? partial?.value?.child ?? zero,
      fx_missing: false,
      sync_stale: false,
    },
    child: cardMetricsVariantFixture(partial?.child),
    parent: cardMetricsVariantFixture(partial?.parent),
    row_pct: { day: { clp: null, usd: null }, month: { clp: null, usd: null }, year: { clp: null, usd: null }, total: { clp: null, usd: null } },
    parent_pct: { day: { clp: null, usd: null }, month: { clp: null, usd: null }, year: { clp: null, usd: null }, total: { clp: null, usd: null } },
  };
}

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
    children: [leafAccount(10), leafAccount(12)],
  });

  const propertyRow: DashboardAccountRow = {
    account_id: 10,
    name: "depto",
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
    const br = breakdownForNavChild(realEstateNode, {
      accounts: [propertyRow],
      liabilities_breakdown: undefined,
      card_metrics_by_slug: {
        real_estate: cardMetricsEntryFixture({ value: { members: { clp: 144_818_228, usd: null } } }),
      },
    });
    const labels = br?.lines?.map((l) => l.label) ?? [];
    expect(labels).not.toContain("valor");
    expect(labels).not.toContain("hipoteca");
    expect(br?.lines?.[0]?.label).toBe("depto");
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
    // Page-bundle rows have no category_slug; the group_slug match finds the mortgage.
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
    const br = breakdownForNavChild(realEstateNode, {
      liabilities_breakdown: undefined,
      accounts: [demoProperty, demoMortgage],
      card_metrics_by_slug: {
        real_estate: cardMetricsEntryFixture({ value: { members: { clp: 27_110_948, usd: null } } }),
      },
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
  /**
   * The linked tarjeta row belongs to the home cash card only: the savings card's own total is
   * not CC-netted, so a card balance pinned under it explained nothing.
   */
  it("carries no linked tarjeta row, even when the layout declares one", () => {
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
      {
        ...dash,
        accounts: [dashRow(1, 2_000_000, "cash_eqs__fondo_reserva", "Reserva2")],
        card_metrics_by_slug: {},
      }
    );
    expect(br?.lines).toHaveLength(1);
    expect(br?.lines?.[0]?.clp).toBe(2_000_000);
    expect(br?.bottomLines).toBeUndefined();
  });

  it("builds savings breakdown (not full cash hub) for savings nav node", () => {
    const node: NavTreeNodeDto = navNodeFixture({
      slug: "cash_savings",
      label: "Ahorros y reservas",
      asset_group_slug: "cash_eqs__cash_savings",
      route_path: "/cash_eqs/savings",
      children: [leafAccount(1)],
    });
    const br = breakdownForNavChild(node, {
      card_metrics_by_slug: {},
      liabilities_breakdown: undefined,
      dashboard_layout: [],
      accounts: [
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
    });
    expect(br?.lines.length).toBeGreaterThan(0);
    expect(br?.lines[0]?.clp).toBe(2_000_000);
  });
});

describe("navParentMainValue", () => {
  it("picks the served parent balance (net worth: the bucket totals, never its rows)", () => {
    const netWorthNode: NavTreeNodeDto = navNodeFixture({
      slug: "net_worth",
      label: "Patrimonio neto",
      children: [leafAccount(99)],
    });
    const dash = {
      card_metrics_by_slug: {
        net_worth: cardMetricsEntryFixture({
          value: { parent: { clp: 270_525_274, usd: 290_000 } },
        }),
      },
    };
    expect(navParentMainValue(dash, netWorthNode, false)).toEqual({ clp: 270_525_274, apiUsd: null });
    expect(navParentMainValue(dash, netWorthNode, true)).toEqual({ clp: 270_525_274, apiUsd: 290_000 });
  });

  it("parent metrics come from the served net_worth entry", () => {
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
          },
        }),
      },
    };
    const metrics = requireNavCardMetrics(dash, netWorthNode).parent.month;
    expect(metrics.deposits_clp).toBe(300);
    expect(metrics.delta_total_clp).toBe(130);
    expect(metrics.delta_period_clp).toBe(30);
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
    const metrics = requireNavCardMetrics(dash, inversionesNode).parent.month;
    expect(metrics.deposits_period_clp).toBe(5_100_000);
    expect(metrics.delta_period_clp).toBe(30);
    expect(metrics.deposits_clp).toBe(300);
  });

  it("throws on a missing entry instead of re-summing rows", () => {
    const node: NavTreeNodeDto = navNodeFixture({ slug: "brokerage", label: "B", children: [] });
    expect(() => requireNavCardMetrics({ card_metrics_by_slug: {} }, node)).toThrow(
      /no entry for nav node/
    );
  });
});

describe("mainValueForNavChild", () => {
  it("picks the served child balance, never a Σ of the subtree rows", () => {
    const mutualFundsNode: NavTreeNodeDto = navNodeFixture({
      slug: "brokerage_mutual_funds",
      label: "Mutual funds",
      route_path: "/inversiones/mutual-funds",
      portfolio_group_id: 1,
      children: [leafAccount(1), leafAccount(2)],
    });
    const dash = {
      card_metrics_by_slug: {
        brokerage_mutual_funds: cardMetricsEntryFixture({
          child: { year: { delta_period_clp: 2_300_000 } },
          value: { child: { clp: 16_000_000, usd: 17_000 } },
        }),
      },
    };
    expect(mainValueForNavChild(dash, mutualFundsNode, false)).toEqual({ clp: 16_000_000, apiUsd: null });
    expect(mainValueForNavChild(dash, mutualFundsNode, true).apiUsd).toBe(17_000);
    const variant = requireNavCardMetrics(dash, mutualFundsNode).child;
    expect(variant.year.delta_period_clp).toBe(2_300_000);
    expect(variant.month.delta_period_clp).toBeNull();
  });
});

describe("navChildCardHasActivity", () => {
  /** Wound-down bucket: only account is chart-inactive at $0, activity only in the year window. */
  const inactiveMutualFundsNode: NavTreeNodeDto = navNodeFixture({
    slug: "brokerage_mutual_funds",
    label: "Mutual funds",
    route_path: "/inversiones/brokerage/mutual-funds",
    portfolio_group_id: 1,
    chart_inactive: true,
    children: [],
  });
  const dash: Pick<DashboardResponse, "accounts" | "dashboard_layout" | "card_metrics_by_slug"> = {
    card_metrics_by_slug: {
      brokerage_mutual_funds: cardMetricsEntryFixture({
        child: {
          year: { deposits_period_clp: -21_000_000, delta_period_clp: 300_000 },
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
  };

  it("reports activity when any period slice has flows or Δ (year-only here)", () => {
    expect(navChildCardHasActivity(dash, inactiveMutualFundsNode)).toBe(true);
  });

  it("reports activity from the served balance alone", () => {
    const funded = {
      card_metrics_by_slug: {
        brokerage_mutual_funds: cardMetricsEntryFixture({ value: { child: { clp: 5_000, usd: null } } }),
      },
    };
    expect(navChildCardHasActivity(funded, inactiveMutualFundsNode)).toBe(true);
  });

  it("reports no activity when balance and every period slice are zero", () => {
    const quietDash = {
      ...dash,
      card_metrics_by_slug: {
        brokerage_mutual_funds: cardMetricsEntryFixture(),
      },
      accounts: [
        {
          ...dashRow(45, 0, "brokerage__mutual_funds"),
          chart_inactive: true,
        },
      ],
    };
    expect(navChildCardHasActivity(quietDash, inactiveMutualFundsNode)).toBe(false);
  });
});

describe("breakdownForNavChild cash_eqs hub", () => {
  /** The hub lists its buckets with their accounts nested, like every other card, zeros hidden. */
  it("nests accounts under their buckets and pins the linked tarjeta line", () => {
    const hub = navNodeFixture({
      slug: "cash_eqs",
      label: "Efectivo",
      group_kind: "nav_bucket",
      dashboard_bucket_slug: "cash_eqs",
      route_path: "/cash_eqs",
      children: [
        navNodeFixture({
          slug: "cash_savings",
          label: "Ahorros y reservas",
          asset_group_slug: "cash_eqs__cash_savings",
          route_path: "/cash_eqs/savings",
          portfolio_group_id: 7,
          kind_slug: "cash_savings",
          children: [leafAccount(1), leafAccount(2)],
        }),
        navNodeFixture({
          slug: "checking_accounts",
          label: "Cuentas corrientes",
          asset_group_slug: "cash_eqs__checking_accounts",
          route_path: "/cash_eqs/checking",
          portfolio_group_id: 8,
          kind_slug: "checking_accounts",
          children: [leafAccount(3), leafAccount(4)],
        }),
      ],
    });
    const rows = [
      dashRow(1, 2_000_000, "cash_eqs__fondo_reserva", "Reserva"),
      dashRow(2, 0, "cash_eqs__fondo_reserva", "Fintual"),
      dashRow(3, 300_000, "cash_eqs__cuenta_corriente", "Cuenta corriente"),
      dashRow(4, 0, "cash_eqs__cuenta_vista", "Cuenta vista"),
    ];
    const br = breakdownForNavChild(hub, {
      accounts: rows,
      card_metrics_by_slug: {
        // The savings card is CC-netted (child); its breakdown line reads the raw members.
        cash_savings: cardMetricsEntryFixture({
          value: { child: { clp: 1_500_000, usd: null }, members: { clp: 2_000_000, usd: null } },
        }),
        checking_accounts: cardMetricsEntryFixture({ value: { child: { clp: 300_000, usd: null } } }),
      },
      liabilities_breakdown: undefined,
      dashboard_layout: [
        {
          slug: "cash_eqs",
          label: "Efectivo",
          label_i18n_key: null,
          sort_order: 40,
          bucket_slug: "cash_eqs",
          card_css: "cash",
          route_path: "/cash_eqs",
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
    });
    expect(br?.lines.map((l) => [l.label, l.depth, l.clp])).toEqual([
      ["Ahorros y reservas", 0, 2_000_000],
      ["Reserva", 1, 2_000_000],
      ["Cuentas corrientes", 0, 300_000],
      ["Cuenta corriente", 1, 300_000],
    ]);
    expect(br?.bottomLines?.map((l) => [l.label, l.clp])).toEqual([[i18n.t("liabilities.creditCard"), 500_000]]);
    expect(br?.pinBottom).toBe(true);
  });
});
