import { describe, expect, it } from "vitest";
import {
  navChartBucketNavNodes,
  navChartBucketNavNodesUngrouped,
  stripChartBucketNavNodes,
} from "./navChartBuckets";
import type { NavTreeNodeDto } from "./types";

function groupNode(
  slug: string,
  children: NavTreeNodeDto[] = [],
  route = `/g/${slug}`
): NavTreeNodeDto {
  return {
    slug,
    label: slug,
    route_path: route,
    portfolio_group_id: 1,
    api_group: "brokerage",
    children,
  };
}

describe("navChartBuckets", () => {
  it("agrupado uses strip children; sin agrupar drills one level", () => {
    const brokerage = groupNode("brokerage", [
      groupNode("brokerage_mutual_funds", [], "/mf"),
      groupNode("brokerage_acciones", [], "/eq"),
      groupNode("brokerage_crypto", [], "/cr"),
    ]);

    const grouped = stripChartBucketNavNodes(brokerage);
    expect(grouped.map((n) => n.slug)).toEqual([
      "brokerage_mutual_funds",
      "brokerage_acciones",
      "brokerage_crypto",
    ]);

    expect(navChartBucketNavNodes(brokerage, true).map((n) => n.slug)).toEqual(grouped.map((n) => n.slug));
    expect(navChartBucketNavNodes(brokerage, false).length).toBe(3);
  });

  it("ungrouped on inversiones hub expands brokerage and retirement", () => {
    const inversiones: NavTreeNodeDto = {
      slug: "inversiones",
      label: "Inversiones",
      group_kind: "nav_hub",
      children: [
        groupNode("brokerage", [
          groupNode("brokerage_mutual_funds", [], "/mf"),
          groupNode("brokerage_acciones", [], "/eq"),
        ]),
        groupNode(
          "retirement",
          [groupNode("retirement_afp_afc", [], "/afp"), groupNode("retirement_apv", [], "/apv")],
          "/ret"
        ),
      ],
    };

    const grouped = stripChartBucketNavNodes(inversiones);
    expect(grouped.map((n) => n.slug)).toEqual(["brokerage", "retirement"]);

    const ungrouped = navChartBucketNavNodesUngrouped(inversiones);
    expect(ungrouped.map((n) => n.slug)).toEqual([
      "brokerage_mutual_funds",
      "brokerage_acciones",
      "retirement_afp_afc",
      "retirement_apv",
    ]);
  });
});
