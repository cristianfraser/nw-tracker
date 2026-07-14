import { describe, expect, it } from "vitest";
import { collectNavBucketCoverageKeys, stripChartBucketNavNodes } from "./navChartBuckets";
import type { NavTreeNodeDto } from "./types";
import { navNodeFixture } from "./test/navNodeFixture";

// The chart bucket SERIES are now aggregated server-side (see server/src/groupChartBuckets.ts).
// These retained client helpers are used only by nav card breakdown / coverage counting.

function groupNode(
  slug: string,
  children: NavTreeNodeDto[] = [],
  route = `/g/${slug}`
): NavTreeNodeDto {
  return navNodeFixture({
    slug,
    label: slug,
    route_path: route,
    portfolio_group_id: 1,
    api_group: "brokerage",
    children,
  });
}

describe("stripChartBucketNavNodes", () => {
  it("returns the strip group children (≥2)", () => {
    const brokerage = groupNode("brokerage", [
      groupNode("brokerage_mutual_funds", [], "/mf"),
      groupNode("brokerage_acciones", [], "/eq"),
      groupNode("brokerage_crypto", [], "/cr"),
    ]);
    expect(stripChartBucketNavNodes(brokerage).map((n) => n.slug)).toEqual([
      "brokerage_mutual_funds",
      "brokerage_acciones",
      "brokerage_crypto",
    ]);
  });

  it("drills into a sole group child with ≥2 inner groups", () => {
    const retirement = groupNode("retirement", [
      groupNode(
        "retirement_apv",
        [groupNode("retirement_apv_a", [], "/apv/apv-a"), groupNode("retirement_apv_b", [], "/apv/apv-b")],
        "/apv"
      ),
    ]);
    expect(stripChartBucketNavNodes(retirement).map((n) => n.slug)).toEqual([
      "retirement_apv_a",
      "retirement_apv_b",
    ]);
  });
});

describe("collectNavBucketCoverageKeys", () => {
  it("collects slugs + asset group slugs across the group subtree", () => {
    const node = navNodeFixture({
      slug: "retirement_apv",
      label: "APV",
      asset_group_slug: "retirement_apv",
      children: [
        navNodeFixture({ slug: "retirement_apv_a", label: "apv-a", asset_group_slug: "retirement_apv_a" }),
      ],
    });
    const keys = collectNavBucketCoverageKeys(node);
    expect(keys).toContain("retirement_apv");
    expect(keys).toContain("retirement_apv_a");
  });
});
