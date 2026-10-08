import { describe, expect, it } from "vitest";
import {
  buildCompositionBlock,
  buildCompositionLineSpecs,
  compositionBigBuckets,
  type CompositionAccountRow,
} from "./dashboardComposition.js";
import type { NavTreeNodeDto } from "./navTree.js";

function node(partial: Partial<NavTreeNodeDto> & { slug: string }): NavTreeNodeDto {
  return {
    node_id: `t-${partial.slug}`,
    label: partial.slug.toUpperCase(),
    label_i18n_key: null,
    route_path: `/${partial.slug}`,
    active_prefix: null,
    nav_end: false,
    show_leaf_hyphen: true,
    account_id: null,
    portfolio_group_id: 1,
    expense_account_id: null,
    expense_account_slug: null,
    asset_group_slug: null,
    api_group: null,
    api_subgroup: null,
    color_rgb: "1,2,3",
    color: null,
    kind_slug: null,
    dashboard_bucket_slug: null,
    exclude_from_parent_total: false,
    group_kind: "bucket",
    children: [],
    ...partial,
  };
}
const acct = (id: number, name: string): NavTreeNodeDto =>
  node({ slug: `account_${id}`, label: name, account_id: id, portfolio_group_id: null });
const row = (id: number): CompositionAccountRow => ({ account_id: id, bucket_slug: "x", name: `a${id}` });

const tree = node({
  slug: "net_worth",
  children: [
    node({
      slug: "cmp_inversiones",
      group_kind: "nav_bucket",
      children: [
        node({
          slug: "cmp_brokerage",
          dashboard_bucket_slug: "brokerage",
          children: [node({ slug: "cmp_funds", children: [acct(1, "fund")] }), acct(2, "loose")],
        }),
        node({ slug: "cmp_retirement", dashboard_bucket_slug: "retirement", children: [acct(3, "afp")] }),
      ],
    }),
    node({
      slug: "cmp_cash",
      group_kind: "nav_bucket",
      dashboard_bucket_slug: "cash_eqs",
      children: [
        node({ slug: "cash_savings", children: [acct(4, "sav")] }),
        node({ slug: "cmp_checking", children: [acct(5, "chk")] }),
      ],
    }),
    node({ slug: "cmp_liab", group_kind: "liability_group", children: [acct(9, "mortgage")] }),
    node({ slug: "cmp_ref", group_kind: "reference" }),
  ],
});

const rowsByGroup: Record<string, CompositionAccountRow[]> = {
  cmp_brokerage: [row(1), row(2)],
  cmp_funds: [row(1)],
  cmp_retirement: [row(3)],
  cmp_cash: [row(4), row(5)],
  cash_savings: [row(4)],
  cmp_checking: [row(5)],
};
const rowsFor = (slug: string) => rowsByGroup[slug] ?? [];

describe("dashboard composition lines", () => {
  it("flattens bucket-less nav buckets, keeps dashboard buckets, skips liabilities and references", () => {
    expect(compositionBigBuckets(tree).map((b) => b.slug)).toEqual([
      "cmp_brokerage",
      "cmp_retirement",
      "cmp_cash",
    ]);
  });

  it("makes one line per first-level child, grouped by big bucket, netting on the savings node", () => {
    const specs = buildCompositionLineSpecs(tree, rowsFor);
    expect(specs.map((s) => [s.bigBucketSlug, s.dataKey])).toEqual([
      ["cmp_brokerage", "cmp_funds"],
      ["cmp_brokerage", "account_2"],
      ["cmp_retirement", "account_3"],
      ["cmp_cash", "cash_savings"],
      ["cmp_cash", "cmp_checking"],
    ]);
    expect(specs.filter((s) => s.netLinkedCreditCard).map((s) => s.dataKey)).toEqual(["cash_savings"]);
    expect(specs[1]!.name).toBe("loose");
    expect(specs[0]!.color_rgb).toBe("1,2,3");
  });

  it("fails when a bucket account is in none of its lines", () => {
    expect(() =>
      buildCompositionLineSpecs(tree, (s) => (s === "cmp_cash" ? [...rowsFor(s), row(77)] : rowsFor(s)))
    ).toThrow(/account 77/);
  });

  it("fails when an account is claimed by two lines", () => {
    expect(() =>
      buildCompositionLineSpecs(tree, (s) => (s === "cmp_checking" ? [row(4)] : rowsFor(s)))
    ).toThrow(/account 4/);
  });

  it("shares floor a netted-negative savings line and sum to 1", () => {
    const specs = buildCompositionLineSpecs(tree, rowsFor);
    const values = new Map<string, (number | null)[]>([
      ["cmp_funds", [100]],
      ["account_2", [100]],
      ["account_3", [200]],
      ["cash_savings", [-50]],
      ["cmp_checking", [100]],
    ]);
    const block = buildCompositionBlock(["2026-01-31"], specs, values);
    const shares = block.series.map((s) => s.values[0]!);
    expect(shares[3]).toBe(0);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(shares[2]).toBeCloseTo(200 / 500, 10);
  });
});
