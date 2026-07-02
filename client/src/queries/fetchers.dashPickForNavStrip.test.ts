import { describe, expect, it } from "vitest";
import { dashPickForNavStrip } from "./fetchers";
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
    source_account_id: null,
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
    source_account_id: null,
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

describe("dashPickForNavStrip USD totals", () => {
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
      bucketNode("brokerage", "brokerage", 1),
      {
        ...bucketNode("cash_savings", "cash_eqs", 2),
        slug: "cash_savings",
        children: [leafAccount(2, "cash_savings")],
      },
    ],
  };

  it("derives bucket and net worth USD totals from account rows", () => {
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
        accounts,
        overviewPoints: [],
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

  it("omits USD totals when accounts lack current_value_usd", () => {
    const dash = dashPickForNavStrip(
      {
        accounts: [
          dashRow({
            account_id: 1,
            name: "Brk",
            current_value_clp: 1_900_000,
          }),
        ],
        overviewPoints: [],
      },
      netWorth
    );

    expect(dash.totals.brokerage_usd).toBeUndefined();
    expect(dash.totals.net_worth_usd).toBeUndefined();
  });
});
