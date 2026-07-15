import { describe, expect, it } from "vitest";
import { mainValueAndMetricsForNavChild } from "../portfolioNavDashboardCards";
import { dashPickForNavStrip } from "../queries/fetchers";
import {
  PERTURB_FACTOR_MAX,
  PERTURB_FACTOR_MIN,
  clpToUsdPlaceholder,
  perturbAccountValuesPreservingNavCardOrder,
  perturbCachedAmount,
  perturbCachedAmountsPreservingSortOrder,
  perturbDashboardNavSnapshot,
  randomPerturbFactor,
  reassignPerturbedKeysByOriginalRank,
  resolveSnapshotFxRate,
  synthesizeMissingUsdOnDashboardNavContext,
  synthesizeMissingUsdOnNavSnapshot,
} from "./perturbCachedAmount";
import type { DashboardNavContext } from "../queries/fetchers";
import type {
  CachedDashboardNavSnapshot,
  DashboardAccountRow,
  DashboardNavSnapshotResponse,
  NavTreeNodeDto,
} from "../types";

function dashRow(partial: Partial<DashboardAccountRow> & Pick<DashboardAccountRow, "account_id" | "name">): DashboardAccountRow {
  return {
    group_slug: "brokerage",
    group_label: "Brokerage",
    category_slug: "mutual_funds",
    category_label: "Mutual funds",
    deposits_clp: 0,
    current_value_clp: 0,
    valuation_as_of: null,
    ...partial,
  };
}

describe("randomPerturbFactor", () => {
  it("stays within [0.85, 0.95]", () => {
    for (let i = 0; i < 50; i++) {
      const factor = randomPerturbFactor();
      expect(factor).toBeGreaterThanOrEqual(PERTURB_FACTOR_MIN);
      expect(factor).toBeLessThanOrEqual(PERTURB_FACTOR_MAX);
    }
  });
});

describe("perturbCachedAmount", () => {
  const factor = 0.9;

  it("scales positive values by factor", () => {
    expect(perturbCachedAmount(5234, factor)).toBe(4711);
    expect(perturbCachedAmount(1234, factor)).toBe(1111);
    expect(perturbCachedAmount(123, factor)).toBe(111);
    expect(perturbCachedAmount(8, factor)).toBe(7);
  });

  it("scales negative values and keeps sign", () => {
    expect(perturbCachedAmount(-5234, factor)).toBe(-4711);
  });

  it("leaves zero unchanged", () => {
    expect(perturbCachedAmount(0, factor)).toBe(0);
  });

  it("random factor keeps output within [0.85S, 0.95S]", () => {
    for (let i = 0; i < 50; i++) {
      const f = randomPerturbFactor();
      const out = perturbCachedAmount(5234, f);
      expect(out).toBeGreaterThanOrEqual(Math.round(5234 * PERTURB_FACTOR_MIN));
      expect(out).toBeLessThanOrEqual(Math.round(5234 * PERTURB_FACTOR_MAX));
    }
  });
});

describe("reassignPerturbedKeysByOriginalRank", () => {
  it("permutes perturbed values to match original rank", () => {
    const original = [500, 200, 195, 80];
    const perturbed = [100, 450, 190, 70];
    const fixed = reassignPerturbedKeysByOriginalRank(original, perturbed);
    expect(fixed[0]).toBe(450);
    expect(fixed[1]).toBe(190);
    expect(fixed[2]).toBe(100);
    expect(fixed[3]).toBe(70);
    for (let i = 0; i < fixed.length - 1; i++) {
      expect(fixed[i]).toBeGreaterThan(fixed[i + 1]!);
    }
  });
});

describe("perturbCachedAmountsPreservingSortOrder", () => {
  it("keeps descending order", () => {
    const factor = 0.9;
    const original = [5100, 4900, 1200];
    const perturbed = perturbCachedAmountsPreservingSortOrder(original, factor);
    expect(perturbed[0]).toBeGreaterThan(perturbed[1]!);
    expect(perturbed[1]).toBeGreaterThan(perturbed[2]!);
  });
});

describe("perturbDashboardNavSnapshot", () => {
  it("perturbs account current_value_clp away from raw cache", () => {
    const raw: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({ account_id: 1, name: "A", current_value_clp: 5_000_000 }),
        dashRow({ account_id: 2, name: "B", current_value_clp: 2_000_000 }),
      ],
      liabilities_breakdown: {
        mortgage_clp: 100_000_000,
        credit_card_clp: 500_000,
      },
    };

    const perturbed = perturbDashboardNavSnapshot(raw);
    const rawSum = raw.accounts.reduce((s, a) => s + (a.current_value_clp ?? 0), 0);
    const perturbedSum = perturbed.accounts.reduce((s, a) => s + (a.current_value_clp ?? 0), 0);

    expect(perturbedSum).not.toBe(rawSum);
    expect(perturbedSum).toBeGreaterThanOrEqual(Math.round(rawSum * PERTURB_FACTOR_MIN));
    expect(perturbedSum).toBeLessThanOrEqual(Math.round(rawSum * PERTURB_FACTOR_MAX));
  });

  it("perturbs nw_bucket_totals away from raw cache", () => {
    const raw: DashboardNavSnapshotResponse = {
      card_metrics_by_slug: {},
      accounts: [dashRow({ account_id: 1, name: "A", current_value_clp: 5_000_000 })],
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        net_worth_clp: 270_525_274,
        real_estate_clp: 50_000_000,
        retirement_clp: 100_000_000,
        brokerage_clp: 80_000_000,
        cash_eqs_clp: 40_525_274,
        prior_closes: {
          month_end: "2026-05-31",
          year_end: "2025-12-31",
          month: {
            net_worth_clp: 268_000_000,
            real_estate_clp: 49_500_000,
            retirement_clp: 99_000_000,
            brokerage_clp: 79_500_000,
            cash_eqs_clp: 40_000_000,
          },
          year: {
            net_worth_clp: 250_000_000,
            real_estate_clp: 48_000_000,
            retirement_clp: 95_000_000,
            brokerage_clp: 75_000_000,
            cash_eqs_clp: 32_000_000,
          },
        },
      },
    };

    const perturbed = perturbDashboardNavSnapshot(raw);
    expect(perturbed.nw_bucket_totals!.net_worth_clp).not.toBe(raw.nw_bucket_totals!.net_worth_clp);
    expect(perturbed.nw_bucket_totals!.net_worth_clp).toBeGreaterThanOrEqual(
      Math.round(raw.nw_bucket_totals!.net_worth_clp * PERTURB_FACTOR_MIN)
    );
    expect(perturbed.nw_bucket_totals!.net_worth_clp).toBeLessThanOrEqual(
      Math.round(raw.nw_bucket_totals!.net_worth_clp * PERTURB_FACTOR_MAX)
    );
    expect(perturbed.nw_bucket_totals!.prior_closes!.month.net_worth_clp).not.toBe(
      raw.nw_bucket_totals!.prior_closes!.month.net_worth_clp
    );
  });
});

describe("synthesizeMissingUsdOnNavSnapshot", () => {
  it("converts CLP fields to USD using row fx_clp_per_usd before perturb", () => {
    const raw: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({
          account_id: 1,
          name: "A",
          current_value_clp: 9_500_000,
          fx_clp_per_usd: 950,
          delta_month_clp: 95_000,
        }),
      ],
      liabilities_breakdown: {
        mortgage_clp: 100_000_000,
        credit_card_clp: 500_000,
      },
    };

    const synthesized = synthesizeMissingUsdOnNavSnapshot(raw);
    expect(synthesized.accounts[0]!.current_value_usd).toBeCloseTo(10_000, 5);
    expect(synthesized.accounts[0]!.delta_month_usd).toBeCloseTo(100, 5);
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeCloseTo(
      100_000_000 / 950,
      5
    );
  });

  it("uses cached bundle fx for aggregates when row fx is missing", () => {
    const raw: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({ account_id: 1, name: "A", current_value_clp: 950_000 }),
      ],
      liabilities_breakdown: {
        mortgage_clp: 95_000,
        credit_card_clp: 0,
      },
    };

    const synthesized = synthesizeMissingUsdOnNavSnapshot(raw, {
      date: "2026-06-01",
      clp_per_usd: 950,
    });
    expect(synthesized.accounts[0]!.current_value_usd).toBeCloseTo(1000, 5);
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeCloseTo(100, 5);
  });

  it("leaves USD null when no fx rate is available", () => {
    const raw: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({ account_id: 1, name: "A", current_value_clp: 5_000_000 }),
      ],
    };

    const synthesized = synthesizeMissingUsdOnNavSnapshot(raw);
    expect(synthesized.accounts[0]!.current_value_usd).toBeUndefined();
  });

  it("perturbs synthesized USD away from the converted value", () => {
    const raw: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({
          account_id: 1,
          name: "A",
          current_value_clp: 9_500_000,
          fx_clp_per_usd: 950,
        }),
        dashRow({
          account_id: 2,
          name: "B",
          current_value_clp: 1_900_000,
          fx_clp_per_usd: 950,
        }),
      ],
    };

    const converted = 9_500_000 / 950;
    const perturbed = perturbDashboardNavSnapshot(synthesizeMissingUsdOnNavSnapshot(raw));
    expect(perturbed.accounts[0]!.current_value_usd).not.toBe(converted);
    expect(perturbed.accounts[0]!.current_value_usd!).toBeGreaterThanOrEqual(
      converted * PERTURB_FACTOR_MIN
    );
    expect(perturbed.accounts[0]!.current_value_usd!).toBeLessThanOrEqual(
      converted * PERTURB_FACTOR_MAX
    );
  });
});

describe("synthesizeMissingUsdOnDashboardNavContext", () => {
  function navCtx(): DashboardNavContext {
    return {
      card_metrics_by_slug: {},
      accounts: [
        dashRow({
          account_id: 1,
          name: "A",
          current_value_clp: 9_500_000,
          fx_clp_per_usd: 950,
          delta_month_clp: 95_000,
        }),
        dashRow({ account_id: 2, name: "B", current_value_clp: 1_900_000 }),
      ],
      liabilities_breakdown: {
        mortgage_clp: 95_000_000,
        credit_card_clp: 950_000,
      },
      dashboard_layout: [
        {
          slug: "cash_eqs",
          linked_balances: [{ slug: "credit_card", label: "CC", clp: -95_000 }],
        } as NonNullable<DashboardNavContext["dashboard_layout"]>[number],
      ],
      nw_bucket_totals: {
        net_worth_clp: 11_400_000,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 11_400_000,
        cash_eqs_clp: 0,
        prior_closes: {
          month_end: "",
          year_end: "",
          month: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
          year: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
        },
      },
      overviewPoints: [{ as_of_date: "2026-06-30", total_nw: 11_400_000 }],
    };
  }

  it("fills missing USD on accounts, liabilities and layout linked balances", () => {
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(navCtx());
    expect(synthesized.accounts[0]!.current_value_usd).toBeCloseTo(10_000, 5);
    expect(synthesized.accounts[0]!.delta_month_usd).toBeCloseTo(100, 5);
    // Row without its own fx falls back to the snapshot-level rate (from row A here).
    expect(synthesized.accounts[1]!.current_value_usd).toBeCloseTo(2_000, 5);
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeCloseTo(100_000, 5);
    expect(synthesized.liabilities_breakdown!.credit_card_usd).toBeCloseTo(1_000, 5);
    expect(synthesized.dashboard_layout![0]!.linked_balances![0]!.usd).toBeCloseTo(-100, 5);
  });

  it("prefers cached fx over row fx for aggregates and keeps existing USD values", () => {
    const ctx = navCtx();
    ctx.accounts[0]!.current_value_usd = 12_345;
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx, {
      date: "2026-06-01",
      clp_per_usd: 950,
    });
    expect(synthesized.accounts[0]!.current_value_usd).toBe(12_345);
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeCloseTo(100_000, 5);
  });

  it("leaves nw_bucket_totals, overviewPoints and inversiones_period_metrics untouched", () => {
    const ctx = navCtx();
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx);
    expect(synthesized.nw_bucket_totals).toBe(ctx.nw_bucket_totals);
    expect(synthesized.overviewPoints).toBe(ctx.overviewPoints);
    expect(synthesized.inversiones_period_metrics).toBe(ctx.inversiones_period_metrics);
  });

  it("leaves USD absent when no rate is available", () => {
    const ctx = navCtx();
    ctx.accounts = [dashRow({ account_id: 3, name: "C", current_value_clp: 1_000_000 })];
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx);
    expect(synthesized.accounts[0]!.current_value_usd).toBeUndefined();
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeUndefined();
  });
});

describe("clpToUsdPlaceholder and resolveSnapshotFxRate", () => {
  it("matches server clp / clp_per_usd", () => {
    expect(clpToUsdPlaceholder(950_000, 950)).toBe(1000);
  });

  it("resolveSnapshotFxRate prefers cached bundle fx", () => {
    expect(
      resolveSnapshotFxRate([], { date: "2026-06-01", clp_per_usd: 920 })
    ).toBe(920);
  });
});

function navBucketNode(opts: {
  slug: string;
  bucket: string;
  accountId: number;
  route: string;
}): NavTreeNodeDto {
  return {
    node_id: `n-${opts.slug}`,
    slug: opts.slug,
    label: opts.slug,
    label_i18n_key: null,
    route_path: opts.route,
    active_prefix: opts.route,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: 1,
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: opts.bucket,
    kind_slug: null,
    dashboard_bucket_slug: opts.bucket,
    api_group: opts.bucket,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children: [
      {
        node_id: `acc-${opts.accountId}`,
        slug: `acc-${opts.accountId}`,
        label: `acc-${opts.accountId}`,
        label_i18n_key: null,
        route_path: `/account/${opts.accountId}`,
        active_prefix: null,
        nav_end: true,
        show_leaf_hyphen: false,
        account_id: opts.accountId,
        portfolio_group_id: null,
        source_account_id: null,
        expense_account_id: null,
        expense_account_slug: null,
        asset_group_slug: opts.bucket,
        kind_slug: "checking",
        dashboard_bucket_slug: opts.bucket,
        api_group: null,
        api_subgroup: null,
        color_rgb: null,
        color: null,
        group_kind: "bucket",
        children: [],
      },
    ],
  };
}

describe("perturbAccountValuesPreservingNavCardOrder", () => {
  it("preserves dashboard home bucket card order (inmuebles > retiro > brokerage > cash)", () => {
    const netWorth: NavTreeNodeDto = {
      node_id: "nw",
      slug: "net_worth",
      label: "Patrimonio",
      label_i18n_key: null,
      route_path: "/",
      active_prefix: "/",
      nav_end: false,
      show_leaf_hyphen: false,
      account_id: null,
      portfolio_group_id: null,
      source_account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: "net_worth",
      kind_slug: null,
      dashboard_bucket_slug: "net_worth",
      api_group: null,
      api_subgroup: null,
      color_rgb: null,
      color: null,
      group_kind: "bucket",
      children: [
        navBucketNode({
          slug: "real_estate",
          bucket: "real_estate",
          accountId: 1,
          route: "/group/real_estate",
        }),
        navBucketNode({
          slug: "retirement",
          bucket: "retirement",
          accountId: 2,
          route: "/group/retirement",
        }),
        navBucketNode({
          slug: "brokerage",
          bucket: "brokerage",
          accountId: 3,
          route: "/group/brokerage",
        }),
        navBucketNode({
          slug: "cash_savings",
          bucket: "cash_eqs",
          accountId: 4,
          route: "/group/cash_savings",
        }),
      ],
    };

    const accounts: DashboardAccountRow[] = [
      dashRow({ account_id: 1, name: "RE", current_value_clp: 500_000_000, group_slug: "real_estate" }),
      dashRow({ account_id: 2, name: "Ret", current_value_clp: 200_000_000, group_slug: "retirement" }),
      dashRow({ account_id: 3, name: "Brk", current_value_clp: 195_000_000, group_slug: "brokerage" }),
      dashRow({ account_id: 4, name: "Cash", current_value_clp: 80_000_000, group_slug: "cash_savings" }),
    ];

    const zeroPeriod = {
      deposits_clp: 0,
      deposits_usd: null,
      delta_total_clp: null,
      delta_total_usd: null,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: null,
      delta_period_usd: null,
    };
    const zeroVariant = {
      month: zeroPeriod,
      year: zeroPeriod,
      title_delta: { month_clp: null, month_usd: null, year_clp: null, year_usd: null },
    };
    const zeroEntry = { child: zeroVariant, parent: zeroVariant };
    const snapshot: CachedDashboardNavSnapshot = {
      card_metrics_by_slug: {
        real_estate: zeroEntry,
        retirement: zeroEntry,
        brokerage: zeroEntry,
        cash_savings: zeroEntry,
      },
      accounts,
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 5_000_000 },
      dashboard_layout: [
        {
          slug: "cash_savings",
          label: "Ahorros",
          label_i18n_key: null,
          sort_order: 4,
          bucket_slug: "cash_eqs",
          card_css: null,
          linked_balances: [
            {
              slug: "credit_card",
              label: "CC",
              label_i18n_key: "liabilities.creditCard",
              clp: 5_000_000,
              route_path: "/liabilities/credit_card",
            },
          ],
        },
      ],
    };

    const stripChildren = netWorth.children ?? [];
    const originalDash = dashPickForNavStrip(
      { ...snapshot, overviewPoints: [] },
      netWorth
    );
    const originalOrder = stripChildren.map((child) =>
      mainValueAndMetricsForNavChild(originalDash, child, "month", false).clp
    );

    for (let run = 0; run < 50; run++) {
      const factor = randomPerturbFactor();
      const clpByAccount = new Map(accounts.map((a) => [a.account_id, a.current_value_clp!]));
      perturbAccountValuesPreservingNavCardOrder(clpByAccount, accounts, snapshot, [netWorth], factor);

      const perturbedAccounts = accounts.map((row) => ({
        ...row,
        current_value_clp: clpByAccount.get(row.account_id) ?? row.current_value_clp,
      }));
      const perturbedDash = dashPickForNavStrip(
        { ...snapshot, accounts: perturbedAccounts, overviewPoints: [] },
        netWorth
      );
      const perturbedOrder = stripChildren.map((child) =>
        mainValueAndMetricsForNavChild(perturbedDash, child, "month", false).clp
      );

      for (let i = 0; i < originalOrder.length - 1; i++) {
        expect(perturbedOrder[i]).toBeGreaterThan(perturbedOrder[i + 1]!);
      }
    }
  });
});
