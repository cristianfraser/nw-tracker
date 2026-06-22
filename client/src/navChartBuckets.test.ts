import { describe, expect, it } from "vitest";
import {
  buildNavChartBucketPlan,
  chartBucketKeyForAccountAssetSlug,
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
      group_kind: "nav_bucket",
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

  it("maps chart_inactive accounts into bucket via asset group slug", () => {
    const retirement = groupNode("retirement", [
      groupNode("retirement_afp_afc", [], "/afp"),
      groupNode(
        "retirement_apv",
        [groupNode("retirement_apv_a", [], "/apv/apv-a")],
        "/apv"
      ),
    ]);

    const bucketNodes = stripChartBucketNavNodes(retirement);
    expect(
      chartBucketKeyForAccountAssetSlug("retirement_apv_a__apv", bucketNodes)
    ).toBe("retirement_apv");

    const { idToBucket } = buildNavChartBucketPlan(retirement, true, [
      {
        id: 88,
        bucket_slug: "retirement_apv_a__apv",
        chart_inactive: true,
      },
    ]);
    expect(idToBucket(88)).toBe("retirement_apv");
    expect(idToBucket(46)).toBeNull();
  });

  it("maps chart_inactive pre-Fintual APV-a into inversiones retirement bucket", () => {
    const inversiones: NavTreeNodeDto = {
      slug: "inversiones",
      label: "Inversiones",
      group_kind: "nav_bucket",
      children: [
        groupNode("brokerage", [groupNode("brokerage_mutual_funds", [], "/mf")]),
        groupNode("retirement", [
          groupNode("retirement_apv", [
            groupNode("retirement_apv_a", [], "/apv/apv-a"),
          ]),
        ]),
      ],
    };

    const { idToBucket } = buildNavChartBucketPlan(inversiones, true, [
      {
        id: 88,
        bucket_slug: "retirement_apv_a__apv",
        chart_inactive: true,
      },
    ]);
    expect(idToBucket(88)).toBe("retirement");
  });
});
