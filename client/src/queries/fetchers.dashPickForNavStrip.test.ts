import { describe, expect, it } from "vitest";
import { dashPickForNavStrip, type DashboardNavContext } from "./fetchers";
import type { DashboardAccountRow, NavTreeNodeDto } from "../types";

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

function leafAccount(id: number, bucket: string): NavTreeNodeDto {
  return {
    node_id: `acc-${id}`,
    slug: `acc-${id}`,
    label: `acc-${id}`,
    label_i18n_key: null,
    route_path: `/account/${id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: false,
    account_id: id,
    portfolio_group_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: bucket,
    kind_slug: "checking",
    dashboard_bucket_slug: bucket,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children: [],
  };
}

function bucketNode(slug: string, bucket: string, accountId: number): NavTreeNodeDto {
  return {
    node_id: `n-${slug}`,
    slug,
    label: slug,
    label_i18n_key: null,
    route_path: `/group/${slug}`,
    active_prefix: `/group/${slug}`,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: bucket,
    kind_slug: null,
    dashboard_bucket_slug: bucket,
    api_group: bucket,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children: [leafAccount(accountId, bucket)],
  };
}

/**
 * `nw_bucket_totals` as the server sends it for a CLP request — no USD bucket fields. That is
 * the payload held as the placeholder of a CLP→USD switch.
 */
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
      bucketNode("brokerage", "brokerage", 1),
      {
        ...bucketNode("cash_savings", "cash_eqs", 2),
        slug: "cash_savings",
        children: [leafAccount(2, "cash_savings")],
      },
    ],
  };

  it("picks the CLP totals and prior closes from nw_bucket_totals", () => {
    const nwBucketTotals = clpOnlyBucketTotals({
      real_estate_clp: 0,
      retirement_clp: 0,
      brokerage_clp: 1_900_000,
      cash_eqs_clp: 850_000,
    });
    const dash = dashPickForNavStrip(
      {
        card_metrics_by_slug: {},
        // Rows that don't add up to the server totals: the totals must not be re-summed.
        accounts: [
          dashRow({ account_id: 1, name: "Brk", group_slug: "brokerage", current_value_clp: 1 }),
        ],
        overviewPoints: [],
        nw_bucket_totals: nwBucketTotals,
      },
      netWorth
    );

    expect(dash.totals.brokerage_clp).toBe(1_900_000);
    expect(dash.totals.cash_eqs_clp).toBe(850_000);
    expect(dash.totals.net_worth_clp).toBe(2_750_000);
    expect(dash.totals.prior_closes).toBe(nwBucketTotals.prior_closes);
  });

  it("prefers the server's USD bucket totals when the payload carries them", () => {
    const dash = dashPickForNavStrip(
      {
        card_metrics_by_slug: {},
        accounts: [
          dashRow({
            account_id: 1,
            name: "Brk",
            group_slug: "brokerage",
            current_value_clp: 1_900_000,
            current_value_usd: 2000,
          }),
        ],
        overviewPoints: [],
        nw_bucket_totals: {
          ...clpOnlyBucketTotals({
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 1_900_000,
            cash_eqs_clp: 0,
          }),
          brokerage_usd: 1999,
          net_worth_usd: 1999,
        },
      },
      netWorth
    );

    expect(dash.totals.brokerage_usd).toBe(1999);
    expect(dash.totals.net_worth_usd).toBe(1999);
  });

  it("derives USD bucket and net worth totals from account rows on a CLP payload", () => {
    const accounts = [
      dashRow({
        account_id: 1,
        name: "Brk",
        group_slug: "brokerage",
        current_value_clp: 1_900_000,
        current_value_usd: 2000,
      }),
      dashRow({
        account_id: 2,
        name: "Cash",
        group_slug: "cash_savings",
        current_value_clp: 950_000,
        current_value_usd: 1000,
      }),
    ];

    const dash = dashPickForNavStrip(
      {
        card_metrics_by_slug: {},
        accounts,
        overviewPoints: [],
        nw_bucket_totals: clpOnlyBucketTotals({
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 1_900_000,
          cash_eqs_clp: 850_000,
        }),
        dashboard_layout: [
          {
            // Matches the server payload: the cash card keeps the hub slug `cash_eqs`
            // (see getDashboardLayoutCards) — linked_balances lookups key on it.
            slug: "cash_eqs",
            label: "Ahorros",
            label_i18n_key: null,
            sort_order: 1,
            bucket_slug: "cash_eqs",
            card_css: null,
            linked_balances: [
              {
                slug: "credit_card",
                label: "CC",
                label_i18n_key: "liabilities.creditCard",
                clp: 100_000,
                usd: 100,
                route_path: "/liabilities/credit_card",
              },
            ],
          },
        ],
      },
      netWorth
    );

    expect(dash.totals.brokerage_usd).toBe(2000);
    expect(dash.totals.cash_eqs_usd).toBe(900);
    expect(dash.totals.net_worth_usd).toBe(2900);
  });

  it("counts a linked card total in credit toward cash USD, like the server's netting", () => {
    const dash = dashPickForNavStrip(
      {
        card_metrics_by_slug: {},
        nw_bucket_totals: clpOnlyBucketTotals({
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 0,
          cash_eqs_clp: 1_050_000,
        }),
        accounts: [
          dashRow({
            account_id: 2,
            name: "Cash",
            group_slug: "cash_savings",
            current_value_clp: 950_000,
            current_value_usd: 1000,
          }),
        ],
        overviewPoints: [],
        dashboard_layout: [
          {
            slug: "cash_eqs",
            label: "Ahorros",
            label_i18n_key: null,
            sort_order: 1,
            bucket_slug: "cash_eqs",
            card_css: null,
            // An overpaid card owes a negative amount: the bank holds money for you.
            linked_balances: [
              {
                slug: "credit_card",
                label: "CC",
                label_i18n_key: "liabilities.creditCard",
                clp: -100_000,
                usd: -100,
                route_path: "/liabilities/credit_card",
              },
            ],
          },
        ],
      },
      netWorth
    );

    expect(dash.totals.cash_eqs_usd).toBe(1100);
  });

  it("omits USD totals when accounts lack current_value_usd", () => {
    const dash = dashPickForNavStrip(
      {
        card_metrics_by_slug: {},
        accounts: [
          dashRow({
            account_id: 1,
            name: "Brk",
            current_value_clp: 1_900_000,
          }),
        ],
        overviewPoints: [],
        nw_bucket_totals: clpOnlyBucketTotals({
          real_estate_clp: 0,
          retirement_clp: 0,
          brokerage_clp: 1_900_000,
          cash_eqs_clp: 0,
        }),
      },
      netWorth
    );

    expect(dash.totals.brokerage_usd).toBeUndefined();
    expect(dash.totals.net_worth_usd).toBeUndefined();
  });
});
