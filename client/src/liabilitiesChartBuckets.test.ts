import { describe, expect, it } from "vitest";
import {
  applyMultiSeriesTrailingZeroTailClip,
} from "./components/charts/AppLineChart";
import { buildLineChartTailClipOptions } from "./components/charts/ValuationLineCharts";
import {
  buildLiabilitiesBucketPlan,
  liabilitiesChartBucketNavNodes,
  shouldAggregateLiabilitiesCharts,
} from "./liabilitiesChartBuckets";
import { aggregateLiabilitiesNavGroupedValuationBlock } from "./liabilitiesGroupedAggregation";
import type { AccountListRow, NavTreeNodeDto, TimeseriesBlock } from "./types";

const pasivosCreditCardNav: NavTreeNodeDto = {
  node_id: "liabilities_credit_card",
  slug: "liabilities_credit_card",
  label: "Tarjeta de crédito",
  label_i18n_key: null,
  route_path: "/liabilities/credit-card",
  active_prefix: null,
  nav_end: false,
  show_leaf_hyphen: true,
  account_id: null,
  portfolio_group_id: null,
  source_account_id: null,
  expense_account_id: null,
  expense_account_slug: null,
  asset_group_slug: "liabilities",
  api_group: null,
  api_subgroup: "credit_card",
  color_rgb: null,
  color: null,
  kind_slug: null,
  dashboard_bucket_slug: null,
  exclude_from_parent_total: false,
  group_kind: "bucket",
  children: [
    {
      node_id: "cc-group.santander",
      slug: "santander",
      label: "Santander",
      label_i18n_key: null,
      route_path: "/liabilities/credit-card/santander",
      active_prefix: null,
      nav_end: false,
      show_leaf_hyphen: true,
      account_id: null,
      portfolio_group_id: null,
      source_account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: "credit_cards",
      api_group: null,
      api_subgroup: "credit_card",
      color_rgb: "1,2,3",
      color: null,
      kind_slug: null,
      dashboard_bucket_slug: null,
      exclude_from_parent_total: false,
      group_kind: "bucket",
      children: [
        {
          node_id: "cc-acc.32",
          slug: "credit_card_account_32",
          label: "santander ·4242",
          label_i18n_key: null,
          route_path: "/account/32",
          active_prefix: null,
          nav_end: true,
          show_leaf_hyphen: true,
          account_id: 32,
          portfolio_group_id: null,
          source_account_id: null,
          expense_account_id: null,
          expense_account_slug: null,
          asset_group_slug: "credit_cards",
          api_group: null,
          api_subgroup: "credit_card",
          color_rgb: null,
          color: null,
          kind_slug: null,
          dashboard_bucket_slug: null,
          exclude_from_parent_total: false,
          group_kind: "bucket",
          children: [],
        },
      ],
    },
    {
      node_id: "cc-group.bci",
      slug: "bci",
      label: "BCI",
      label_i18n_key: null,
      route_path: "/liabilities/credit-card/bci",
      active_prefix: null,
      nav_end: false,
      show_leaf_hyphen: true,
      account_id: null,
      portfolio_group_id: null,
      source_account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: "credit_cards",
      api_group: null,
      api_subgroup: "credit_card",
      color_rgb: "4,5,6",
      color: null,
      kind_slug: null,
      dashboard_bucket_slug: null,
      exclude_from_parent_total: false,
      group_kind: "bucket",
      children: [
        {
          node_id: "cc-acc.42",
          slug: "credit_card_account_42",
          label: "lider bci 4343",
          label_i18n_key: null,
          route_path: "/account/42",
          active_prefix: null,
          nav_end: true,
          show_leaf_hyphen: true,
          account_id: 42,
          portfolio_group_id: null,
          source_account_id: null,
          expense_account_id: null,
          expense_account_slug: null,
          asset_group_slug: "credit_cards",
          api_group: null,
          api_subgroup: "credit_card",
          color_rgb: null,
          color: null,
          kind_slug: null,
          dashboard_bucket_slug: null,
          exclude_from_parent_total: false,
          group_kind: "bucket",
          children: [],
        },
      ],
    },
  ],
};

const pasivosRootNav: NavTreeNodeDto = {
  ...pasivosCreditCardNav,
  node_id: "liabilities",
  slug: "liabilities",
  label: "Pasivos",
  route_path: "/liabilities",
  children: [
    pasivosCreditCardNav,
    {
      node_id: "liabilities_mortgage",
      slug: "liabilities_mortgage",
      label: "Hipoteca",
      label_i18n_key: null,
      route_path: "/liabilities/mortgage",
      active_prefix: null,
      nav_end: false,
      show_leaf_hyphen: true,
      account_id: null,
      portfolio_group_id: null,
      source_account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: "liabilities",
      api_group: null,
      api_subgroup: "mortgage",
      color_rgb: null,
      color: null,
      kind_slug: null,
      dashboard_bucket_slug: null,
      exclude_from_parent_total: false,
      group_kind: "bucket",
      children: [
        {
          node_id: "liab-acc.89",
          slug: "liability_account_89",
          label: "suecia",
          label_i18n_key: null,
          route_path: "/account/84",
          active_prefix: null,
          nav_end: true,
          show_leaf_hyphen: true,
          account_id: 89,
          portfolio_group_id: null,
          source_account_id: 84,
          expense_account_id: null,
          expense_account_slug: null,
          asset_group_slug: "liabilities",
          api_group: null,
          api_subgroup: "mortgage",
          color_rgb: null,
          color: null,
          kind_slug: null,
          dashboard_bucket_slug: null,
          exclude_from_parent_total: false,
          group_kind: "bucket",
          children: [],
        },
      ],
    },
  ],
};

const listRows: AccountListRow[] = [
  {
    id: 77,
    name: "santander ·4242",
    notes: null,
    created_at: "",
    category_slug: "credit_card",
    category_label: "credit_card",
    group_slug: "liabilities",
    group_label: "Pasivos",
    source_account_id: 32,
  },
  {
    id: 74,
    name: "santander ·4141",
    notes: null,
    created_at: "",
    category_slug: "credit_card",
    category_label: "credit_card",
    group_slug: "liabilities",
    group_label: "Pasivos",
    source_account_id: 35,
    chart_inactive: true,
  },
  {
    id: 73,
    name: "lider bci 4343",
    notes: null,
    created_at: "",
    category_slug: "credit_card",
    category_label: "credit_card",
    group_slug: "liabilities",
    group_label: "Pasivos",
    source_account_id: 42,
  },
  {
    id: 89,
    name: "suecia",
    notes: null,
    created_at: "",
    category_slug: "mortgage",
    category_label: "mortgage",
    group_slug: "liabilities",
    group_label: "Pasivos",
    source_account_id: 84,
  },
];

describe("buildLiabilitiesBucketPlan", () => {
  it("maps chart master ids and inactive CC rows onto buckets", () => {
    const ccPlan = buildLiabilitiesBucketPlan(pasivosCreditCardNav, listRows);
    expect(ccPlan.idToBucket(32)).toBe("santander");
    expect(ccPlan.idToBucket(35)).toBe("santander");
    expect(ccPlan.idToBucket(42)).toBe("bci");
    expect(ccPlan.idToBucket(74)).toBe("santander");
  });

  it("derives issuer buckets from listRows when sidebar nav omits Santander", () => {
    const prunedNav: NavTreeNodeDto = {
      ...pasivosCreditCardNav,
      children: [pasivosCreditCardNav.children[1]!],
    };
    const buckets = liabilitiesChartBucketNavNodes(prunedNav, listRows);
    expect(buckets.map((b) => b.slug)).toEqual(["santander", "bci"]);
    expect(shouldAggregateLiabilitiesCharts(prunedNav, listRows)).toBe(true);
  });

  it("maps mortgage master id via liability_view source_account_id", () => {
    const plan = buildLiabilitiesBucketPlan(pasivosRootNav, listRows);
    expect(plan.idToBucket(84)).toBe("liabilities_mortgage");
    expect(plan.idToBucket(89)).toBe("liabilities_mortgage");
    expect(plan.idToBucket(35)).toBe("liabilities_credit_card");
  });
});

describe("aggregateLiabilitiesNavGroupedValuationBlock total after tail clip", () => {
  it("keeps Total aligned with synthetic bucket lines", () => {
    const block: TimeseriesBlock = {
      accounts: [
        { account_id: 32, name: "4242", dataKey: "32", valueSeriesType: "data" },
        { account_id: 35, name: "4141", dataKey: "35", valueSeriesType: "data" },
        { account_id: 42, name: "bci", dataKey: "42", valueSeriesType: "data" },
      ],
      points: [
        { date: "2025-07-31", "32": 10_000_000, "35": 0, "42": 500_000 },
        { date: "2025-08-31", "32": 10_800_000, "35": 0, "42": 566_338 },
        { date: "2025-09-30", "32": 10_836_954, "35": 0, "42": 566_338 },
        { date: "2025-10-31", "32": 10_836_954, "35": 0, "42": 566_338 },
        { date: "2025-11-30", "32": 10_836_954, "35": 0, "42": 566_338 },
        { date: "2025-12-31", "32": 10_836_954, "35": 0, "42": 566_338 },
      ],
    };
    const aggregated = aggregateLiabilitiesNavGroupedValuationBlock(
      block,
      listRows,
      pasivosCreditCardNav
    );
    const tailOpts = buildLineChartTailClipOptions(aggregated, false);
    expect(tailOpts?.groupValTotalSourceKeys).toEqual(
      expect.arrayContaining(["liab_santander", "liab_bci"])
    );
    const { points } = applyMultiSeriesTrailingZeroTailClip(aggregated.points, tailOpts!);
    const last = points[points.length - 1]!;
    expect(last.__group_val_total).toBe(10_836_954 + 566_338);
    expect(last.liab_santander).toBe(10_836_954);
    expect(last.liab_bci).toBe(566_338);
  });
});
