import { describe, expect, it } from "vitest";
import {
  buildPlaceholderDashboardBundle,
  buildPlaceholderDashboardDash,
  buildPlaceholderDashboardTimeseries,
} from "./dashboardPagePlaceholders";

describe("buildPlaceholderDashboardTimeseries", () => {
  it("emits overview and primary blocks with zero month-end points", () => {
    const ts = buildPlaceholderDashboardTimeseries("clp");
    expect(ts.overview?.lines.length).toBeGreaterThan(0);
    expect(ts.overview?.points.length).toBeGreaterThan(0);
    const last = ts.overview!.points[ts.overview!.points.length - 1]!;
    expect(last.total_nw).toBe(0);
    expect(ts.accounts_ex_property?.points.length).toBeGreaterThan(0);
    expect(last.as_of_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildPlaceholderDashboardDash", () => {
  it("includes one CLP slice per NW bucket for pie chart", () => {
    const dash = buildPlaceholderDashboardDash("clp");
    expect(dash.allocation.length).toBe(4);
    expect(dash.allocation.every((a) => a.value_clp === 1)).toBe(true);
    expect(dash.totals.net_worth_clp).toBe(0);
  });
});

describe("buildPlaceholderDashboardBundle", () => {
  it("wraps dash, ts, and null perf", () => {
    const bundle = buildPlaceholderDashboardBundle("usd");
    expect(bundle.dash.allocation[0]?.value_usd).toBe(1);
    expect(bundle.ts.unit).toBe("usd");
    expect(bundle.retirementPerf).toBeNull();
    expect(bundle.brokeragePerf).toBeNull();
  });
});
