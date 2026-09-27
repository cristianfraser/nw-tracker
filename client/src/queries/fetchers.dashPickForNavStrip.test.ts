import { describe, expect, it } from "vitest";
import { dashPickForNavStrip, type DashboardNavContext } from "./fetchers";
import type { DashboardAccountRow } from "../types";

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

/** `nw_bucket_totals` as the server sends it for a CLP request — no USD bucket fields. */
function clpOnlyBucketTotals(
  buckets: Pick<
    DashboardNavContext["nw_bucket_totals"],
    "real_estate_clp" | "retirement_clp" | "brokerage_clp" | "cash_eqs_clp"
  >
): DashboardNavContext["nw_bucket_totals"] {
  const net_worth_clp =
    buckets.real_estate_clp + buckets.retirement_clp + buckets.brokerage_clp + buckets.cash_eqs_clp;
  return {
    ...buckets,
    net_worth_clp,
    prior_closes: {
      month_end: "2026-08-31",
      year_end: "2025-12-31",
      month: { ...buckets, net_worth_clp },
      year: { ...buckets, net_worth_clp },
    },
  };
}

describe("dashPickForNavStrip bucket totals", () => {
  const brokerageRow = dashRow({
    account_id: 1,
    name: "Brk",
    group_slug: "brokerage",
    current_value_clp: 1_900_000,
    current_value_usd: 2000,
  });
  const cashRow = dashRow({
    account_id: 2,
    name: "Cash",
    group_slug: "cash_savings",
    current_value_clp: 950_000,
    current_value_usd: 1000,
  });

  it("picks the CLP totals and prior closes from nw_bucket_totals", () => {
    const nwBucketTotals = clpOnlyBucketTotals({
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 1_900_000,
      cash_eqs_clp: 850_000,
    });
    const dash = dashPickForNavStrip({
      card_metrics_by_slug: {},
      // Rows that don't add up to the server totals: the totals must not be re-summed.
      accounts: [dashRow({ account_id: 1, name: "Brk", group_slug: "brokerage", current_value_clp: 1 })],
      overviewPoints: [],
      nw_bucket_totals: nwBucketTotals,
    });

    expect(dash.totals.brokerage_clp).toBe(1_900_000);
    expect(dash.totals.cash_eqs_clp).toBe(850_000);
    expect(dash.totals.net_worth_clp).toBe(2_750_000);
    expect(dash.totals.prior_closes).toBe(nwBucketTotals.prior_closes);
  });

  it("picks the USD bucket totals from nw_bucket_totals, not from the rows", () => {
    const dash = dashPickForNavStrip({
      card_metrics_by_slug: {},
      accounts: [brokerageRow, cashRow],
      overviewPoints: [],
      nw_bucket_totals: {
        ...clpOnlyBucketTotals({
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 1_900_000,
          cash_eqs_clp: 850_000,
        }),
        brokerage_usd: 1999,
        cash_eqs_usd: 899,
        net_worth_usd: 2898,
      },
    });

    expect(dash.totals.brokerage_usd).toBe(1999);
    expect(dash.totals.cash_eqs_usd).toBe(899);
    expect(dash.totals.net_worth_usd).toBe(2898);
  });

  it("never sums account rows into bucket totals: a CLP-only payload has no USD totals", () => {
    // The placeholders convert a CLP payload shown in USD before it gets here
    // (`synthesizeMissingUsdOn…`); the strip itself only picks.
    const dash = dashPickForNavStrip({
      card_metrics_by_slug: {},
      accounts: [brokerageRow, cashRow],
      overviewPoints: [],
      nw_bucket_totals: clpOnlyBucketTotals({
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 1_900_000,
        cash_eqs_clp: 850_000,
      }),
    });

    expect(dash.totals.brokerage_usd).toBeUndefined();
    expect(dash.totals.cash_eqs_usd).toBeUndefined();
    expect(dash.totals.net_worth_usd).toBeUndefined();
  });
});
