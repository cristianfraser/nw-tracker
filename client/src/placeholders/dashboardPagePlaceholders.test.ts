import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { describe, expect, it } from "vitest";
import {
  buildPlaceholderDashboardBundle,
  buildPlaceholderDashboardDash,
  buildPlaceholderDashboardTimeseries,
  buildPlaceholderNavStripDash,
} from "./dashboardPagePlaceholders";
import { navSnapshotCoversNavTree } from "../queries/dashboardNavSnapshotCache";
import { requireNavCardMetrics } from "../portfolioNavDashboardCards";
import { navNodeFixture } from "../test/navNodeFixture";
import type { NavTreeNodeDto, SidebarNavResponse } from "../types";

describe("buildPlaceholderDashboardTimeseries", () => {
  it("emits overview and primary blocks with zero month-end points", () => {
    const ts = buildPlaceholderDashboardTimeseries("clp");
    expect(ts.overview?.lines.length).toBeGreaterThan(0);
    expect(ts.overview?.points.length).toBeGreaterThan(0);
    const last = ts.overview!.points[ts.overview!.points.length - 1]!;
    expect(last.total_nw).toBe(0);
    expect(last.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildPlaceholderDashboardDash", () => {
  it("includes one slice per NW bucket for pie chart, in the unit it names", () => {
    const dash = buildPlaceholderDashboardDash("clp");
    expect(dash.unit).toBe("clp");
    expect(dash.allocation.length).toBe(4);
    expect(dash.allocation.every((a) => a.value === 1)).toBe(true);
    expect(dash.totals.net_worth).toBe(0);
  });
});

describe("buildPlaceholderDashboardBundle", () => {
  it("wraps dash, ts, and null perf", () => {
    const bundle = buildPlaceholderDashboardBundle("usd");
    expect(bundle.dash.allocation[0]?.value).toBe(1);
    expect(bundle.dash.unit).toBe("usd");
    expect(bundle.ts.unit).toBe("usd");
    expect(bundle.inversionesPerf).toBeNull();
  });
});

describe("buildPlaceholderNavStripDash", () => {
  const stocks = navNodeFixture({
    slug: "tst_stocks",
    label: "Stocks",
    children: [
      navNodeFixture({ slug: "tst_portfolio", label: "Portfolio" }),
      navNodeFixture({ slug: "account_9001", label: "SPY", account_id: 9001 }),
    ],
  });
  const brokerage = navNodeFixture({ slug: "tst_brokerage", label: "Brokerage", children: [stocks] });
  const cash = navNodeFixture({
    slug: "tst_cash",
    label: "Cash",
    children: [navNodeFixture({ slug: "account_9002", label: "Checking", account_id: 9002 })],
  });
  const liabilities = navNodeFixture({
    slug: "liabilities",
    label: "Pasivos",
    children: [
      navNodeFixture({
        slug: "tst_liab_cards",
        label: "Cards",
        children: [navNodeFixture({ slug: "tst_issuer", label: "Issuer" })],
      }),
      navNodeFixture({ slug: "tst_liab_mortgage", label: "Mortgage" }),
    ],
  });
  const nav: SidebarNavResponse = {
    schema_version: DTO_SCHEMA_VERSIONS.sidebar_nav,
    dashboard: null,
    net_worth: navNodeFixture({ slug: "tst_net_worth", label: "NW", children: [brokerage, cash] }),
    main: [brokerage, cash, liabilities],
    flows: null,
    projections: null,
    wealth_percentile: null,
    tax_return: null,
    rates: null,
  };

  function groupNodes(roots: (NavTreeNodeDto | null)[]): NavTreeNodeDto[] {
    const out: NavTreeNodeDto[] = [];
    const visit = (n: NavTreeNodeDto) => {
      if (n.account_id == null && n.expense_account_id == null) out.push(n);
      for (const c of n.children ?? []) visit(c);
    };
    for (const r of roots) if (r) visit(r);
    return out;
  }

  it("covers every group node of the sidebar nav, so the strip never throws on a slug", () => {
    const dash = buildPlaceholderNavStripDash(nav);
    expect(navSnapshotCoversNavTree(dash.card_metrics_by_slug, nav)).toBe(true);
    const nodes = groupNodes([nav.net_worth, ...nav.main]);
    expect(new Set(nodes.map((n) => n.slug)).size).toBe(9);
    for (const node of nodes) {
      expect(() => requireNavCardMetrics(dash, node)).not.toThrow();
    }
    // Account leaves read their own rows; they carry no entry.
    expect(dash.card_metrics_by_slug.account_9001).toBeUndefined();
  });

  it("is all zeros (whatever the unit: a zero is a zero in every currency)", () => {
    const dash = buildPlaceholderNavStripDash(nav);
    expect(dash.accounts).toEqual([]);
    const month = dash.card_metrics_by_slug.tst_brokerage!.child.month;
    expect(month.delta_period).toBe(0);
    expect(dash.card_metrics_by_slug.tst_brokerage!.row_pct.total.value).toBeNull();
    expect(dash.card_metrics_by_slug.liabilities!.parent.day.deposits).toBe(0);
    expect(dash.liabilities_breakdown?.credit_card).toBe(0);
  });
});
