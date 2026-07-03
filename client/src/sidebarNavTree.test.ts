import { describe, expect, it } from "vitest";
import { buildSidebarNavFromApi } from "./sidebarNavFromApi";
import {
  sidebarNodeMatchesPath,
  sidebarNodeSubtreeContainsPath,
  sortNavTreeLeavesFirst,
  type SidebarNavNode,
} from "./sidebarNavTree";
import type { NavTreeNodeDto, SidebarNavResponse } from "./types";

function navNode(
  node_id: string,
  slug: string,
  children: NavTreeNodeDto[] = []
): NavTreeNodeDto {
  return {
    node_id,
    slug,
    label: slug,
    route_path: `/${slug}`,
    children,
  } as NavTreeNodeDto;
}

describe("sidebar active path", () => {
  const parent: SidebarNavNode = {
    id: "inversiones",
    label: "Inversiones",
    to: "/groups/inversiones",
    children: [
      {
        id: "brokerage",
        label: "Brokerage",
        to: "/groups/inversiones/brokerage",
        children: [
          {
            id: "mutual_funds",
            label: "Mutual funds",
            to: "/groups/inversiones/brokerage/mutual_funds",
          },
        ],
      },
    ],
  };

  it("highlights only the exact route match", () => {
    const leafPath = "/groups/inversiones/brokerage/mutual_funds";
    expect(sidebarNodeMatchesPath(leafPath, parent.children![0]!.children![0]!)).toBe(true);
    expect(sidebarNodeMatchesPath(leafPath, parent.children![0]!)).toBe(false);
    expect(sidebarNodeMatchesPath(leafPath, parent)).toBe(false);
  });

  it("still treats subtree for expand-only checks", () => {
    const leafPath = "/groups/inversiones/brokerage/mutual_funds";
    expect(sidebarNodeSubtreeContainsPath(leafPath, parent)).toBe(true);
    expect(sidebarNodeSubtreeContainsPath(leafPath, parent.children![0]!)).toBe(true);
  });
});

describe("sortNavTreeLeavesFirst", () => {
  it("places leaves before branches", () => {
    const sorted = sortNavTreeLeavesFirst([
      { children: [{ id: 1 }] },
      { children: [] },
      { children: [{ id: 1 }, { id: 2 }] },
      {},
    ]);
    expect(sorted.map((n) => (n.children?.length ?? 0) > 0)).toEqual([false, false, true, true]);
  });
});

describe("buildSidebarNavFromApi", () => {
  it("sorts flows children with leaves before expandable gastos", () => {
    const payload: SidebarNavResponse = {
      dashboard: navNode("dash", "dashboard"),
      main: [],
      flows: navNode("flows", "flows", [
        navNode("gastos", "gastos", [navNode("depto", "depto_inmuebles")]),
        navNode("ingresos", "ingresos"),
        navNode("depositos", "depositos"),
      ]),
      search: null,
      rates: navNode("rates", "rates"),
      net_worth: null,
    };
    const tree = buildSidebarNavFromApi(payload);
    const flows = tree.find((n) => n.id === "flows");
    expect(flows?.children?.map((c) => c.id)).toEqual(["ingresos", "depositos", "gastos"]);
  });

  it("hides chart_inactive buckets from the sidebar at any depth", () => {
    const mutualFunds = { ...navNode("mutual_funds", "brokerage_mutual_funds"), chart_inactive: true };
    const acciones = navNode("acciones", "brokerage_acciones", [navNode("acc.1", "account_1")]);
    const inactiveRoot = { ...navNode("dead_root", "dead_root"), chart_inactive: true };
    const payload: SidebarNavResponse = {
      dashboard: null,
      main: [
        navNode("inversiones", "inversiones", [
          navNode("brokerage", "brokerage", [mutualFunds, acciones]),
        ]),
        inactiveRoot,
      ],
      flows: null,
      search: null,
      rates: null,
      net_worth: null,
    };
    const tree = buildSidebarNavFromApi(payload);
    expect(tree.map((n) => n.id)).toEqual(["inversiones"]);
    const brokerage = tree[0]?.children?.find((c) => c.id === "brokerage");
    expect(brokerage?.children?.map((c) => c.id)).toEqual(["acciones"]);
  });
});
