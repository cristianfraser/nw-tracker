import { describe, expect, it } from "vitest";
import {
  buildNavChartBucketPlan,
  navChartBucketNavNodes,
  navChartBucketNavNodesUngrouped,
  stripChartBucketNavNodes,
} from "./navChartBuckets";
import type { NavTreeNodeDto } from "./types";

function groupNode(
  slug: string,
  children: NavTreeNodeDto[] = [],
  route = `/g/${slug}`,
  color_rgb?: string | null
): NavTreeNodeDto {
  return {
    slug,
    label: slug,
    route_path: route,
    portfolio_group_id: 1,
    api_group: "brokerage",
    color_rgb: color_rgb ?? null,
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

  it("buildNavChartBucketPlan copies color_rgb from nav children", () => {
    const brokerage = groupNode("brokerage", [
      groupNode("brokerage_mutual_funds", [], "/mf", "120,80,200"),
      groupNode("brokerage_acciones", [], "/eq", "40,120,60"),
      groupNode("brokerage_crypto", [], "/cr", "200,50,50"),
    ]);

    const { meta } = buildNavChartBucketPlan(brokerage, true);
    expect(meta.brokerage_mutual_funds?.color_rgb).toBe("120,80,200");
    expect(meta.brokerage_acciones?.color_rgb).toBe("40,120,60");
    expect(meta.brokerage_crypto?.color_rgb).toBe("200,50,50");
  });
});
