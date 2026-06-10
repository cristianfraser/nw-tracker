import { describe, expect, it } from "vitest";
import {
  buildPlaceholderGroupPerf,
  buildPlaceholderGroupValuationBlock,
  buildPlaceholderPortfolioGroupBundle,
} from "./groupPageChartPlaceholders";
import type { AccountListRow } from "../types";

const sampleAccounts: AccountListRow[] = [
  {
    id: 60,
    name: "OILK",
    notes: null,
    created_at: "2020-01-01",
    category_slug: "stock",
    category_label: "stock",
    group_slug: "brokerage_acciones",
    group_label: "Acciones",
  },
];

describe("buildPlaceholderGroupValuationBlock", () => {
  it("emits month-end points at zero per account", () => {
    const block = buildPlaceholderGroupValuationBlock(sampleAccounts);
    expect(block.accounts).toHaveLength(1);
    expect(block.points.length).toBeGreaterThan(0);
    const last = block.points[block.points.length - 1]!;
    expect(last.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(last["60"]).toBe(0);
  });
});

describe("buildPlaceholderPortfolioGroupBundle", () => {
  it("includes ts and perf when accounts are provided", () => {
    const bundle = buildPlaceholderPortfolioGroupBundle("clp", sampleAccounts, "brokerage_acciones");
    expect(bundle.accounts).toHaveLength(1);
    expect(bundle.ts.accounts_in_group?.points.length).toBeGreaterThan(0);
    expect(bundle.ts.group_allocation_pie?.length).toBe(1);
    expect(bundle.groupPerf?.points.length).toBeGreaterThan(0);
    expect(bundle.groupPerf?.bar_accounts[0]?.bar_data_key).toBe("pl_60");
  });
});

describe("buildPlaceholderGroupPerf", () => {
  it("zeroes bar series and totals", () => {
    const perf = buildPlaceholderGroupPerf(sampleAccounts, "brokerage_acciones", "clp");
    const last = perf.points[perf.points.length - 1]!;
    expect(last.pl_60).toBe(0);
    expect(last.delta_total).toBe(0);
  });
});
