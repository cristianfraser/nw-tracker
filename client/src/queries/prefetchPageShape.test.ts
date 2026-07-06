import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { prefetchPageShapeForPath } from "./prefetchPageShape";
import * as displayUnitQueries from "./displayUnitQueries";
import type { SidebarNavResponse } from "../types";

const minimalPayload: SidebarNavResponse = {
  dashboard: null,
  net_worth: null,
  flows: null,
  projections: null,
  rates: null,
  main: [
    {
      node_id: "inversiones",
      slug: "inversiones",
      label: "Inversiones",
      label_i18n_key: null,
      route_path: "/inversiones",
      active_prefix: "/inversiones",
      nav_end: false,
      show_leaf_hyphen: true,
      account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      color: null,
      portfolio_group_id: 1,
      asset_group_slug: "inversiones",
      dashboard_bucket_slug: null,
      api_group: null,
      api_subgroup: null,
      group_kind: "nav_bucket",
      kind_slug: null,
      color_rgb: null,
      chart_inactive: false,
      exclude_from_parent_total: false,
      source_account_id: null,
      children: [],
    },
  ],
};

describe("prefetchPageShapeForPath", () => {
  it("prefetches nav-snapshot and net_worth accounts on home", () => {
    const snap = vi.spyOn(displayUnitQueries, "prefetchDashboardNavSnapshot").mockResolvedValue();
    const accounts = vi
      .spyOn(displayUnitQueries, "prefetchAccountsByPortfolioGroup")
      .mockResolvedValue();
    const qc = new QueryClient();
    prefetchPageShapeForPath(qc, "clp", minimalPayload, "/");
    expect(snap).toHaveBeenCalledWith(qc, "clp");
    expect(accounts).toHaveBeenCalledWith(qc, "net_worth", "clp");
    snap.mockRestore();
    accounts.mockRestore();
  });

  it("prefetches accounts and nav-snapshot for group routes", () => {
    const snap = vi.spyOn(displayUnitQueries, "prefetchDashboardNavSnapshot").mockResolvedValue();
    const accounts = vi
      .spyOn(displayUnitQueries, "prefetchAccountsByPortfolioGroup")
      .mockResolvedValue();
    const qc = new QueryClient();
    prefetchPageShapeForPath(qc, "clp", minimalPayload, "/inversiones");
    expect(accounts).toHaveBeenCalledWith(qc, "inversiones", "clp");
    expect(snap).toHaveBeenCalledWith(qc, "clp");
    snap.mockRestore();
    accounts.mockRestore();
  });

  it("prefetches account detail bundle for account routes", () => {
    const detail = vi.spyOn(displayUnitQueries, "prefetchAccountDetailBundle").mockResolvedValue();
    const qc = new QueryClient();
    prefetchPageShapeForPath(qc, "clp", minimalPayload, "/account/42");
    expect(detail).toHaveBeenCalledWith(qc, 42, "clp");
    detail.mockRestore();
  });

  it("skips flows and panel routes", () => {
    const accounts = vi
      .spyOn(displayUnitQueries, "prefetchAccountsByPortfolioGroup")
      .mockResolvedValue();
    const snap = vi.spyOn(displayUnitQueries, "prefetchDashboardNavSnapshot").mockResolvedValue();
    const qc = new QueryClient();
    prefetchPageShapeForPath(qc, "clp", minimalPayload, "/flows/income");
    prefetchPageShapeForPath(qc, "clp", minimalPayload, "/panel/accounts");
    expect(accounts).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
    accounts.mockRestore();
    snap.mockRestore();
  });
});
