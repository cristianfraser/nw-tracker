import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  hasDashboardNavSnapshotCache,
  writeDashboardNavSnapshotCache,
} from "./dashboardNavSnapshotCache";
import { prefetchDashboardNavSnapshot } from "./displayUnitQueries";

const storage: Record<string, string> = {};

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  });
});

describe("hasDashboardNavSnapshotCache", () => {
  it("is false when localStorage is empty", () => {
    expect(hasDashboardNavSnapshotCache("clp")).toBe(false);
  });

  it("is true when unit cache exists", () => {
    writeDashboardNavSnapshotCache("clp", {
      accounts: [],
      card_metrics_by_slug: {},
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        net_worth_clp: 1,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 1,
        prior_closes: {
          month_end: "",
          year_end: "",
          month: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
          year: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
        },
      },
    });
    expect(hasDashboardNavSnapshotCache("clp")).toBe(true);
  });

  it("USD falls back to CLP cache", () => {
    writeDashboardNavSnapshotCache("clp", {
      accounts: [],
      card_metrics_by_slug: {},
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        net_worth_clp: 1,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 1,
        prior_closes: {
          month_end: "",
          year_end: "",
          month: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
          year: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
        },
      },
    });
    expect(hasDashboardNavSnapshotCache("usd")).toBe(true);
  });
});

describe("prefetchDashboardNavSnapshot", () => {
  it("skips prefetch when cache exists", async () => {
    writeDashboardNavSnapshotCache("clp", {
      accounts: [],
      card_metrics_by_slug: {},
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
      nw_bucket_totals: {
        net_worth_clp: 1,
        real_estate_clp: 0,
        retirement_clp: 0,
        brokerage_clp: 0,
        cash_eqs_clp: 1,
        prior_closes: {
          month_end: "",
          year_end: "",
          month: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
          year: {
            net_worth_clp: 0,
            real_estate_clp: 0,
            retirement_clp: 0,
            brokerage_clp: 0,
            cash_eqs_clp: 0,
          },
        },
      },
    });
    const qc = new QueryClient();
    const fetchSpy = vi.fn();
    qc.prefetchQuery = fetchSpy as typeof qc.prefetchQuery;
    await prefetchDashboardNavSnapshot(qc, "clp");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
