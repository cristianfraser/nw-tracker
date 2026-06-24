import { describe, expect, it } from "vitest";
import { pathnameUsesDashboardNavContext } from "./dashboardNavContextRoutes";

describe("pathnameUsesDashboardNavContext", () => {
  it("is false on home and account detail", () => {
    expect(pathnameUsesDashboardNavContext("/")).toBe(false);
    expect(pathnameUsesDashboardNavContext("/account/60")).toBe(false);
  });

  it("is true on portfolio group routes", () => {
    expect(pathnameUsesDashboardNavContext("/inversiones/brokerage")).toBe(true);
    expect(pathnameUsesDashboardNavContext("/liabilities/credit-card")).toBe(true);
    expect(pathnameUsesDashboardNavContext("/real_estate")).toBe(true);
  });

  it("is false on flows, rates, watchlist, and panel", () => {
    expect(pathnameUsesDashboardNavContext("/flows/income")).toBe(false);
    expect(pathnameUsesDashboardNavContext("/rates")).toBe(false);
    expect(pathnameUsesDashboardNavContext("/watchlist")).toBe(false);
    expect(pathnameUsesDashboardNavContext("/panel/accounts")).toBe(false);
  });
});
