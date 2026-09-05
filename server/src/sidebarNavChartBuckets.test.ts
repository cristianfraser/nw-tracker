import { describe, expect, it } from "vitest";
import {
  buildLiabilitiesChartBucketPlan,
  buildNavChartBucketPlan,
  chartBucketsDtoForNavNode,
  isLiabilitiesChartNavNode,
  shouldAggregateLiabilitiesCharts,
  shouldAggregateNavCharts,
} from "./groupChartBuckets.js";
import { getNavChartGroupNodeBySlug, getSidebarNavPayload } from "./navTree.js";
import { annotateSidebarNavChartBuckets } from "./sidebarNavChartBuckets.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import type { NavTreeNodeDto } from "./navTree.js";

function collectAnnotated(nodes: NavTreeNodeDto[]): NavTreeNodeDto[] {
  const out: NavTreeNodeDto[] = [];
  const visit = (n: NavTreeNodeDto) => {
    if (n.chart_buckets) out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

describe("annotateSidebarNavChartBuckets", () => {
  it("annotation presence and bucket lines mirror the real grouped-block emission", () => {
    const main = annotateSidebarNavChartBuckets(getSidebarNavPayload().main);
    const annotated = collectAnnotated(main);
    expect(annotated.length).toBeGreaterThan(0);

    for (const node of annotated) {
      // The real payload resolves its plan node the same way (getNavChartGroupNodeBySlug).
      const full = getNavChartGroupNodeBySlug(node.slug);
      expect(full, `plan node for ${node.slug}`).toBeTruthy();
      const cb = node.chart_buckets!;

      if (isLiabilitiesChartNavNode(full!)) {
        expect(shouldAggregateLiabilitiesCharts(full!)).toBe(true);
        const plan = buildLiabilitiesChartBucketPlan(full!);
        expect(cb.liab?.map((b) => b.data_key)).toEqual(
          plan.orderedKeys.map((k) => plan.meta[k]!.dataKey)
        );
        expect(cb.grouped).toBeUndefined();
        expect(cb.ungrouped).toBeUndefined();
      } else {
        for (const grouped of [true, false] as const) {
          const mode = grouped ? "grouped" : "ungrouped";
          if (!shouldAggregateNavCharts(full!, grouped)) {
            expect(cb[mode], `${node.slug} ${mode}`).toBeUndefined();
            continue;
          }
          const plan = buildNavChartBucketPlan(full!, grouped);
          expect(cb[mode]?.map((b) => b.data_key), `${node.slug} ${mode}`).toEqual(
            plan.orderedKeys.map((k) => plan.meta[k]!.dataKey)
          );
          expect(cb[mode]?.map((b) => b.account_id)).toEqual(
            plan.orderedKeys.map((k) => plan.meta[k]!.accountId)
          );
        }
      }
    }
  });

  it("chartBucketsDtoForNavNode returns null when no mode aggregates", () => {
    const leaf: NavTreeNodeDto = {
      node_id: "x",
      slug: "x",
      label: "X",
      label_i18n_key: null,
      route_path: "/x",
      active_prefix: null,
      nav_end: true,
      show_leaf_hyphen: false,
      account_id: null,
      portfolio_group_id: 1,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: null,
      api_group: null,
      api_subgroup: null,
      color_rgb: null,
      color: null,
      kind_slug: null,
      dashboard_bucket_slug: null,
      exclude_from_parent_total: false,
      group_kind: "bucket",
      children: [],
    };
    expect(chartBucketsDtoForNavNode(leaf)).toBeNull();
  });
});

describe("group-tab bucket-major ordering", () => {
  it("orders rows bucket-major per the node's grouped plan", () => {
    const main = annotateSidebarNavChartBuckets(getSidebarNavPayload().main);
    const annotated = collectAnnotated(main).filter((n) => !n.chart_buckets!.liab);
    expect(annotated.length).toBeGreaterThan(0);

    for (const node of annotated) {
      const full = getNavChartGroupNodeBySlug(node.slug)!;
      const plan = buildNavChartBucketPlan(full, true);
      const bucketIndex = new Map(plan.orderedKeys.map((k, i) => [k, i]));
      const rows = listAccountsForGroupTab(node.slug);
      const indices = rows.map((r) => {
        const key = plan.idToBucket(r.account_id);
        return key != null ? bucketIndex.get(key)! : Number.MAX_SAFE_INTEGER;
      });
      const sorted = [...indices].sort((a, b) => a - b);
      expect(indices, `bucket clustering for ${node.slug}`).toEqual(sorted);
    }
  });
});
