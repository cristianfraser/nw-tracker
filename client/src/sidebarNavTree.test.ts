import { describe, expect, it } from "vitest";
import { buildSidebarNavFromApi } from "./sidebarNavFromApi";
import { sortNavTreeLeavesFirst } from "./sidebarNavTree";
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
      rates: navNode("rates", "rates"),
      net_worth: null,
    };
    const tree = buildSidebarNavFromApi(payload);
    const flows = tree.find((n) => n.id === "flows");
    expect(flows?.children?.map((c) => c.id)).toEqual(["ingresos", "depositos", "gastos"]);
  });
});
