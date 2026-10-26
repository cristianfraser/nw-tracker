import { describe, expect, it } from "vitest";
import { mainValueForNavChild } from "../portfolioNavDashboardCards";
import { dashPickForNavStrip } from "../queries/fetchers";
import { navNodeFixture } from "../test/navNodeFixture";
import {
  clpToUsdPlaceholder,
  resolveSnapshotFxRate,
  synthesizeMissingUsdOnDashboardNavContext,
  synthesizeMissingUsdOnNavSnapshot,
} from "./synthesizeMissingUsd";
import type { DashboardNavContext } from "../queries/fetchers";
import type {
  CachedDashboardNavSnapshot,
  DashboardAccountRow,
  DashboardNavSnapshotResponse,
} from "../types";

/** A bucket card whose main value is the bucket total (`mainValueForNavChild`). */
const brokerageCardNode = navNodeFixture({
  slug: "brokerage",
  label: "Brokerage",
  dashboard_bucket_slug: "brokerage",
});

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

describe("synthesizeMissingUsdOnNavSnapshot", () => {
  it("converts CLP fields to USD using row fx_clp_per_usd", () => {
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

  it("first USD visit on the CLP cache displays converted server bucket totals, not —", () => {
    // The row's own value disagrees with the bucket total: the card must show the server's.
    const clpCache: DashboardNavSnapshotResponse = {
      card_metrics_by_slug: {},
      accounts: [dashRow({ account_id: 1, name: "A", current_value_clp: 1_000_000 })],
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        net_worth_clp: 19_000_000,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 19_000_000,
        cash_eqs_clp: 0,
        prior_closes: {
          month_end: "2026-08-31",
          year_end: "2025-12-31",
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
    };

    const shown = synthesizeMissingUsdOnNavSnapshot(clpCache, {
      date: "2026-09-26",
      clp_per_usd: 950,
    });
    const dash = dashPickForNavStrip({ ...shown, overviewPoints: [] });

    expect(dash.totals.brokerage_usd).toBeCloseTo(20_000, 5);
    expect(dash.totals.net_worth_usd).toBeCloseTo(20_000, 5);
    // DashboardCardValue renders «—» only when apiUsd is null.
    expect(mainValueForNavChild(dash, brokerageCardNode, true).apiUsd).toBeCloseTo(20_000, 5);
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

  it("converts nw_bucket_totals to USD at the card metrics' rate; overviewPoints untouched", () => {
    const ctx = navCtx();
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx);
    // Rate from row A (950), the same resolveSnapshotFxRate the card metrics use.
    expect(synthesized.nw_bucket_totals.brokerage_usd).toBeCloseTo(12_000, 5);
    expect(synthesized.nw_bucket_totals.net_worth_usd).toBeCloseTo(12_000, 5);
    expect(synthesized.nw_bucket_totals.cash_eqs_usd).toBe(0);
    expect(synthesized.nw_bucket_totals.brokerage_clp).toBe(11_400_000);
    expect(synthesized.overviewPoints).toBe(ctx.overviewPoints);
  });

  it("keeps the server's USD bucket totals when the payload has them", () => {
    const ctx = navCtx();
    ctx.nw_bucket_totals = { ...ctx.nw_bucket_totals, brokerage_usd: 11_111, net_worth_usd: 11_111 };
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx);
    expect(synthesized.nw_bucket_totals.brokerage_usd).toBe(11_111);
    expect(synthesized.nw_bucket_totals.net_worth_usd).toBe(11_111);
  });

  it("CLP→USD placeholder displays converted server bucket totals, not —", () => {
    const dash = dashPickForNavStrip(synthesizeMissingUsdOnDashboardNavContext(navCtx()));
    expect(dash.totals.brokerage_usd).toBeCloseTo(12_000, 5);
    // DashboardCardValue renders «—» only when apiUsd is null.
    expect(mainValueForNavChild(dash, brokerageCardNode, true).apiUsd).toBeCloseTo(12_000, 5);
  });

  it("leaves USD absent when no rate is available", () => {
    const ctx = navCtx();
    ctx.accounts = [dashRow({ account_id: 3, name: "C", current_value_clp: 1_000_000 })];
    const synthesized = synthesizeMissingUsdOnDashboardNavContext(ctx);
    expect(synthesized.accounts[0]!.current_value_usd).toBeUndefined();
    expect(synthesized.liabilities_breakdown!.mortgage_usd).toBeUndefined();
    expect(synthesized.nw_bucket_totals.brokerage_usd).toBeUndefined();
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
