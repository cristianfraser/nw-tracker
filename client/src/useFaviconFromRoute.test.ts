import { describe, expect, it } from "vitest";
import { faviconSvg } from "./favicon";
import { faviconSpecForRoute } from "./useFaviconFromRoute";
import type { NavTreeNodeDto } from "./types";

function navNode(partial: Partial<NavTreeNodeDto> & Pick<NavTreeNodeDto, "slug">): NavTreeNodeDto {
  return {
    node_id: partial.slug,
    slug: partial.slug,
    label: partial.slug,
    label_i18n_key: null,
    route_path: partial.route_path ?? "",
    active_prefix: partial.active_prefix ?? null,
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: partial.account_id ?? null,
    source_account_id: null,
    portfolio_group_id: partial.portfolio_group_id ?? 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: partial.asset_group_slug ?? null,
    api_group: partial.api_group ?? null,
    api_subgroup: partial.api_subgroup ?? null,
    color_rgb: partial.color_rgb ?? null,
    color: null,
    kind_slug: partial.kind_slug ?? null,
    dashboard_bucket_slug: partial.dashboard_bucket_slug ?? null,
    group_kind: partial.group_kind ?? "bucket",
    children: partial.children ?? [],
  };
}

const NAV: NavTreeNodeDto[] = [
  navNode({
    slug: "inversiones",
    route_path: "/inversiones",
    color_rgb: "148,163,184",
    children: [
      navNode({
        slug: "brokerage",
        route_path: "/inversiones/brokerage",
        color_rgb: "59,130,246",
        children: [navNode({ slug: "acct-7", route_path: "/account/7", account_id: 7, color_rgb: "34,197,94" })],
      }),
    ],
  }),
];

describe("faviconSpecForRoute", () => {
  it("maps flows sections to their fixed triangles, subroutes included", () => {
    expect(faviconSpecForRoute("/flows", NAV)).toEqual({
      kind: "triangle",
      direction: "up",
      color: "#ffffff",
    });
    expect(faviconSpecForRoute("/flows/deposits", NAV)).toMatchObject({
      direction: "up",
      color: "#38bdf8",
    });
    expect(faviconSpecForRoute("/flows/deposits/reconciliation", NAV)).toMatchObject({
      color: "#38bdf8",
    });
    expect(faviconSpecForRoute("/flows/expenses/real_estate/suecia", NAV)).toMatchObject({
      direction: "down",
      color: "#ef4444",
    });
    expect(faviconSpecForRoute("/flows/income", NAV)).toMatchObject({
      direction: "down",
      color: "#22c55e",
    });
    expect(faviconSpecForRoute("/flows/pl", NAV)).toMatchObject({
      direction: "up",
      color: "#22c55e",
    });
  });

  it("maps the fixed non-flows routes", () => {
    expect(faviconSpecForRoute("/wealth-percentile", NAV)).toEqual({
      kind: "corner-square",
      color: "#ffffff",
    });
    expect(faviconSpecForRoute("/projections", NAV)).toEqual({
      kind: "triangle",
      direction: "up-right",
      color: "#ffffff",
    });
    expect(faviconSpecForRoute("/panel/settings", NAV)).toEqual({
      kind: "circle",
      color: "#94a3b8",
    });
  });

  it("resolves bucket and account routes to a diagonal in the nav node color", () => {
    expect(faviconSpecForRoute("/inversiones/brokerage", NAV)).toEqual({
      kind: "diagonal",
      color: "#3b82f6",
    });
    expect(faviconSpecForRoute("/account/7", NAV)).toEqual({
      kind: "diagonal",
      color: "#22c55e",
    });
    // Trailing slash normalizes to the same node.
    expect(faviconSpecForRoute("/inversiones/brokerage/", NAV)).toEqual({
      kind: "diagonal",
      color: "#3b82f6",
    });
  });

  it("falls back to the plain square for home, unmatched routes, and missing nav", () => {
    expect(faviconSpecForRoute("/", NAV)).toEqual({ kind: "plain" });
    expect(faviconSpecForRoute("/rates", NAV)).toEqual({ kind: "plain" });
    expect(faviconSpecForRoute("/panel/accounts", NAV)).toEqual({ kind: "plain" });
    expect(faviconSpecForRoute("/inversiones/brokerage", undefined)).toEqual({ kind: "plain" });
  });
});

describe("faviconSvg", () => {
  it("renders the plain black rounded square with no overlay", () => {
    const svg = faviconSvg({ kind: "plain" });
    expect(svg).toContain('rx="6"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).not.toContain("<path");
  });

  it("renders one overlay shape per kind", () => {
    expect(faviconSvg({ kind: "diagonal", color: "#3b82f6" })).toContain('fill="#3b82f6"');
    expect(faviconSvg({ kind: "triangle", direction: "up", color: "#fff" })).toContain("M16 7");
    expect(faviconSvg({ kind: "triangle", direction: "down", color: "#fff" })).toContain("M6 7");
    expect(faviconSvg({ kind: "triangle", direction: "up-right", color: "#fff" })).toContain("M25 7");
    expect(faviconSvg({ kind: "corner-square", color: "#fff" })).toContain("<rect x=\"18\"");
    expect(faviconSvg({ kind: "circle", color: "#94a3b8" })).toContain("<circle");
  });
});
