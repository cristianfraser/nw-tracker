import { describe, expect, it } from "vitest";
import {
  buildGroupPageShellFromNav,
  collectNavAccountLeaves,
  extractGroupPageShellFromReal,
} from "./groupPageShellFromNav";
import type { AccountListRow, DashboardAccountRow, NavTreeNodeDto } from "../types";

function navLeaf(partial: Partial<NavTreeNodeDto> & { account_id: number; slug: string }): NavTreeNodeDto {
  return {
    node_id: `n-${partial.account_id}`,
    label: partial.label ?? partial.slug,
    label_i18n_key: null,
    route_path: `/accounts/${partial.account_id}`,
    active_prefix: null,
    nav_end: true,
    show_leaf_hyphen: false,
    portfolio_group_id: null,
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: partial.asset_group_slug ?? "cash_savings",
    kind_slug: partial.kind_slug ?? "checking",
    dashboard_bucket_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children: [],
    ...partial,
  };
}

function groupRoot(children: NavTreeNodeDto[]): NavTreeNodeDto {
  return {
    node_id: "root",
    slug: "cash_savings",
    label: "Ahorros y reservas",
    label_i18n_key: null,
    route_path: "/groups/cash_savings",
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: null,
    portfolio_group_id: 1,
    source_account_id: null,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: "cash_savings",
    kind_slug: null,
    dashboard_bucket_slug: "cash_eqs",
    api_group: "cash_savings",
    api_subgroup: null,
    color_rgb: null,
    color: null,
    group_kind: "bucket",
    children,
  };
}

describe("collectNavAccountLeaves", () => {
  it("collects all account nodes under the group root", () => {
    const root = groupRoot([
      navLeaf({ account_id: 80, slug: "acc-80", label: "Cuenta 80" }),
      navLeaf({ account_id: 44, slug: "acc-44", label: "Reserva2" }),
    ]);
    const leaves = collectNavAccountLeaves(root);
    expect(leaves.map((l) => l.node.account_id).sort()).toEqual([44, 80]);
  });
});

describe("buildGroupPageShellFromNav", () => {
  it("builds matching account and dash rows", () => {
    const root = groupRoot([navLeaf({ account_id: 42, slug: "acc-42" })]);
    const shell = buildGroupPageShellFromNav(root, "clp");
    expect(shell.accounts).toHaveLength(1);
    expect(shell.dashAccounts).toHaveLength(1);
    expect(shell.accounts[0]?.id).toBe(42);
    expect(shell.dashAccounts[0]?.account_id).toBe(42);
    expect(shell.dashAccounts[0]?.current_value_clp).not.toBeNull();
    expect(Number.isFinite(shell.dashAccounts[0]?.current_value_clp)).toBe(true);
  });

  it("uses zero placeholder metrics for loading shell", () => {
    const root = groupRoot([navLeaf({ account_id: 99, slug: "acc-99" })]);
    const row = buildGroupPageShellFromNav(root, "clp").dashAccounts[0];
    expect(row?.current_value_clp).toBe(0);
    expect(row?.delta_month_clp).toBe(0);
    expect(row?.deposits_clp).toBe(0);
  });
});

describe("extractGroupPageShellFromReal", () => {
  it("keeps only accounts in the nav subtree", () => {
    const root = groupRoot([
      navLeaf({ account_id: 1, slug: "a1" }),
      navLeaf({ account_id: 2, slug: "a2" }),
    ]);
    const accounts: AccountListRow[] = [
      {
        id: 1,
        name: "One",
        notes: null,
        created_at: "2020-01-01",
        category_slug: "checking",
        category_label: "checking",
        group_slug: "cash_savings",
        group_label: "Cash",
      },
      {
        id: 2,
        name: "Two",
        notes: null,
        created_at: "2020-01-01",
        category_slug: "checking",
        category_label: "checking",
        group_slug: "cash_savings",
        group_label: "Cash",
      },
      {
        id: 99,
        name: "Other",
        notes: null,
        created_at: "2020-01-01",
        category_slug: "checking",
        category_label: "checking",
        group_slug: "brokerage",
        group_label: "Brokerage",
      },
    ];
    const dashAccounts: DashboardAccountRow[] = [
      {
        account_id: 1,
        name: "One",
        group_slug: "cash_savings",
        group_label: "Cash",
        category_slug: "checking",
        category_label: "checking",
        deposits_clp: 0,
        current_value_clp: 100,
        valuation_as_of: null,
      },
      {
        account_id: 99,
        name: "Other",
        group_slug: "brokerage",
        group_label: "Brokerage",
        category_slug: "checking",
        category_label: "checking",
        deposits_clp: 0,
        current_value_clp: 200,
        valuation_as_of: null,
      },
    ];
    const shell = extractGroupPageShellFromReal(accounts, dashAccounts, root);
    expect(shell.accounts.map((a) => a.id).sort()).toEqual([1, 2]);
    expect(shell.dashAccounts.map((a) => a.account_id)).toEqual([1]);
  });
});
