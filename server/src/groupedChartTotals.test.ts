import { describe, expect, it } from "vitest";
import { getGroupValuationTimeseries, listAccountsForGroupTab } from "./valuationTimeseries.js";
import { totalDisplayDepositsClpForAccount } from "./accountDeposits.js";
import { getNavChartGroupNodeBySlug } from "./navTree.js";
import {
  buildNavChartBucketPlan,
  stripChartBucketNavNodes,
} from "./groupChartBuckets.js";
import type { NavTreeNodeDto } from "./navTree.js";

type Block = {
  accounts: { account_id: number; dataKey: string; valueSeriesType: string }[];
  points: Record<string, string | number | null>[];
  tail_clipped_keys?: string[];
};

function num(v: string | number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** First nav portfolio group in the test DB whose grouped block carries a deposit total. */
function firstAggregatingNavGroup():
  | { slug: string; grouped: Block; ungrouped: Block }
  | null {
  for (const slug of ["inversiones", "brokerage", "retirement"]) {
    const built = getGroupValuationTimeseries(slug, "clp", undefined, { groupedBlocks: true }) as {
      accounts_in_group: Block;
      nav_grouped_blocks?: { grouped?: Block };
    };
    const grouped = built.nav_grouped_blocks?.grouped;
    if (grouped && grouped.points.some((p) => num(p["__group_dep_total"]) != null)) {
      return { slug, grouped, ungrouped: built.accounts_in_group };
    }
  }
  return null;
}

describe("server-grouped chart totals (Agrupado ≡ raw ≡ card)", () => {
  it("grouped __group_dep_total / __group_val_total are copied verbatim from the raw block", () => {
    const found = firstAggregatingNavGroup();
    if (!found) return; // lean test DB may lack an aggregating group with deposits
    const { grouped, ungrouped } = found;
    expect(grouped.points.length).toBe(ungrouped.points.length);
    for (let i = 0; i < ungrouped.points.length; i++) {
      expect(num(grouped.points[i]!["__group_dep_total"])).toBe(
        num(ungrouped.points[i]!["__group_dep_total"])
      );
      expect(num(grouped.points[i]!["__group_val_total"])).toBe(
        num(ungrouped.points[i]!["__group_val_total"])
      );
    }
  });

  it("last-point grouped aportes total equals Σ lifetime deposits (chart ≡ summary card)", () => {
    const found = firstAggregatingNavGroup();
    if (!found) return;
    const { slug, grouped } = found;
    const last = grouped.points[grouped.points.length - 1]!;
    const chartDepTotal = num(last["__group_dep_total"]);
    expect(chartDepTotal).not.toBeNull();

    const rows = listAccountsForGroupTab(slug, undefined);
    let cardSum = 0;
    for (const r of rows) {
      if (r.exclude_from_group_totals === 1) continue;
      cardSum += totalDisplayDepositsClpForAccount(r.account_id);
    }
    // This is the exact bug: the grouped chart's "Total aportes acum." must match the card, not a
    // re-sum over display-clipped series that drops sold-out members.
    expect(Math.abs(chartDepTotal! - cardSum)).toBeLessThan(1);
  });

  it("the display clip never lists the group totals as tail-clipped", () => {
    const found = firstAggregatingNavGroup();
    if (!found) return;
    const clipped = found.grouped.tail_clipped_keys ?? [];
    expect(clipped).not.toContain("__group_dep_total");
    expect(clipped).not.toContain("__group_val_total");
  });

  it("Pasivos credit-card masters all bucket into an issuer (config membership, no name heuristics)", () => {
    const built = getGroupValuationTimeseries("liabilities_credit_card", "clp", undefined, {
      groupedBlocks: true,
    }) as { accounts_in_group: Block; liab_grouped_block?: Block };
    const block = built.liab_grouped_block;
    if (!block) return; // no CC issuer aggregation in this DB
    const bucketKeys = block.accounts
      .filter((a) => a.account_id < 0 && a.account_id !== -1)
      .map((a) => a.dataKey);
    // Every real CC master line collapsed into an issuer bucket (none left as its own positive line).
    const positiveDataLines = block.accounts.filter(
      (a) => a.account_id > 0 && a.valueSeriesType === "data"
    );
    expect(bucketKeys.length).toBeGreaterThanOrEqual(1);
    expect(positiveDataLines.length).toBe(0);
  });
});

// --- Pure bucket-node selection (ported from the retired client logic) ---

function node(partial: Partial<NavTreeNodeDto> & { slug: string }): NavTreeNodeDto {
  return {
    node_id: partial.slug,
    slug: partial.slug,
    label: partial.label ?? partial.slug,
    label_i18n_key: partial.label_i18n_key ?? null,
    route_path: partial.route_path ?? `/g/${partial.slug}`,
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: false,
    account_id: partial.account_id ?? null,
    source_account_id: partial.source_account_id ?? null,
    portfolio_group_id: partial.portfolio_group_id ?? 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: partial.asset_group_slug ?? null,
    api_group: partial.api_group ?? "brokerage",
    api_subgroup: partial.api_subgroup ?? null,
    color_rgb: partial.color_rgb ?? null,
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: partial.dashboard_bucket_slug ?? null,
    exclude_from_parent_total: false,
    group_kind: partial.group_kind ?? "bucket",
    children: partial.children ?? [],
  };
}

describe("buildNavChartBucketPlan (server bucket-node selection)", () => {
  it("agrupado = strip children; each bucket gets nav_<slug> keys, negative ids, node color", () => {
    const brokerage = node({
      slug: "brokerage",
      children: [
        node({ slug: "brokerage_mutual_funds", route_path: "/mf", color_rgb: "51,73,255" }),
        node({ slug: "brokerage_acciones", route_path: "/eq", color_rgb: "29,153,168" }),
        node({ slug: "brokerage_crypto", route_path: "/cr", color_rgb: "234,179,8" }),
      ],
    });
    const plan = buildNavChartBucketPlan(brokerage, true);
    expect(plan.orderedKeys).toEqual([
      "brokerage_mutual_funds",
      "brokerage_acciones",
      "brokerage_crypto",
    ]);
    expect(plan.meta.brokerage_mutual_funds!.dataKey).toBe("nav_brokerage_mutual_funds");
    expect(plan.meta.brokerage_mutual_funds!.depKey).toBe("nav_brokerage_mutual_funds_dep");
    expect(plan.meta.brokerage_mutual_funds!.barDataKey).toBe("pl_nav_brokerage_mutual_funds");
    expect(plan.meta.brokerage_mutual_funds!.accountId).toBe(-720);
    expect(plan.meta.brokerage_acciones!.accountId).toBe(-721);
    expect(plan.meta.brokerage_acciones!.color_rgb).toBe("29,153,168");
  });

  it("sin agrupar drills one level deeper into each grouped bucket", () => {
    const brokerage = node({
      slug: "brokerage",
      children: [
        node({
          slug: "brokerage_acciones",
          route_path: "/eq",
          children: [
            node({ slug: "account_1", account_id: 1, route_path: "/account/1", api_group: null }),
            node({ slug: "account_2", account_id: 2, route_path: "/account/2", api_group: null }),
          ],
        }),
        node({
          slug: "brokerage_crypto",
          route_path: "/cr",
          children: [
            node({ slug: "account_3", account_id: 3, route_path: "/account/3", api_group: null }),
            node({ slug: "account_4", account_id: 4, route_path: "/account/4", api_group: null }),
          ],
        }),
      ],
    });
    const grouped = buildNavChartBucketPlan(brokerage, true);
    expect(grouped.orderedKeys).toEqual(["brokerage_acciones", "brokerage_crypto"]);
    const ungrouped = buildNavChartBucketPlan(brokerage, false);
    expect(ungrouped.orderedKeys).toEqual(["account_1", "account_2", "account_3", "account_4"]);
    expect(ungrouped.idToBucket(1)).toBe("account_1");
  });

  it("resolves real net-worth groups without a childless-liabilities stub collision", () => {
    // `liabilities` exists as a childless stub under net_worth; the resolver must return the real
    // Pasivos subtree (with children) instead.
    const liab = getNavChartGroupNodeBySlug("liabilities");
    if (liab) {
      expect(stripChartBucketNavNodes(liab).length).toBeGreaterThanOrEqual(1);
    }
  });
});
