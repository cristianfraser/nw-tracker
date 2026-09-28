import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  hasDashboardNavSnapshotCache,
  navSnapshotCoversNavTree,
  readDashboardNavSnapshotCache,
  writeDashboardNavSnapshotCache,
} from "./dashboardNavSnapshotCache";
import { prefetchDashboardNavSnapshot } from "./displayUnitQueries";
import { writeSidebarNavCache } from "./sidebarNavCache";
import { navNodeFixture } from "../test/navNodeFixture";
import type { DashboardNavSnapshotResponse, NavCardMetricsDto, SidebarNavResponse } from "../types";

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

describe("stale nav snapshot vs a grown nav tree", () => {
  // The coverage rule reads only which slugs have an entry, never the metrics body.
  const metrics = {} as NavCardMetricsDto;

  function snapshotWithSlugs(slugs: string[]): DashboardNavSnapshotResponse {
    return {
      accounts: [],
      card_metrics_by_slug: Object.fromEntries(slugs.map((s) => [s, metrics])),
      liabilities_breakdown: { mortgage_clp: 0, credit_card_clp: 0 },
    } as unknown as DashboardNavSnapshotResponse;
  }

  function sidebarNav(withNewPortfolio: boolean): SidebarNavResponse {
    const brokerage = navNodeFixture({
      slug: "tst_brokerage",
      label: "Brokerage",
      children: [
        navNodeFixture({ slug: "tst_stocks", label: "Stocks" }),
        ...(withNewPortfolio
          ? [navNodeFixture({ slug: "tst_new_portfolio", label: "Portfolio" })]
          : []),
        // Account leaves carry no card-metrics entry (compact cards read their own row).
        navNodeFixture({ slug: "tst_account_leaf", label: "Account", account_id: 9001 }),
      ],
    });
    return {
      dashboard: null,
      net_worth: navNodeFixture({ slug: "tst_net_worth", label: "NW", children: [brokerage] }),
      main: [
        navNodeFixture({
          slug: "liabilities",
          label: "Pasivos",
          children: [navNodeFixture({ slug: "tst_liab_cards", label: "Cards" })],
        }),
      ],
      flows: null,
      projections: null,
      wealth_percentile: null,
      rates: null,
    };
  }

  const OLD_SLUGS = ["tst_net_worth", "tst_brokerage", "tst_stocks", "liabilities", "tst_liab_cards"];

  it("covers a tree whose every group node has an entry (account leaves skipped)", () => {
    const covered = snapshotWithSlugs(OLD_SLUGS).card_metrics_by_slug;
    expect(navSnapshotCoversNavTree(covered, sidebarNav(false))).toBe(true);
  });

  it("does not cover a tree that grew a node, nor a Pasivos child it lacks", () => {
    const old = snapshotWithSlugs(OLD_SLUGS).card_metrics_by_slug;
    expect(navSnapshotCoversNavTree(old, sidebarNav(true))).toBe(false);
    const noLiabChild = snapshotWithSlugs(OLD_SLUGS.filter((s) => s !== "tst_liab_cards"));
    expect(navSnapshotCoversNavTree(noLiabChild.card_metrics_by_slug, sidebarNav(false))).toBe(false);
  });

  it("treats an unknown nav tree as no mismatch", () => {
    expect(navSnapshotCoversNavTree({}, undefined)).toBe(true);
  });

  it("discards a snapshot saved before the nav tree grew a node", () => {
    writeSidebarNavCache(sidebarNav(false));
    writeDashboardNavSnapshotCache("clp", snapshotWithSlugs(OLD_SLUGS));
    expect(hasDashboardNavSnapshotCache("clp")).toBe(true);

    // A migration adds a nav node; the fresh sidebar nav is cached before any render reads it.
    writeSidebarNavCache(sidebarNav(true));
    expect(readDashboardNavSnapshotCache("clp")).toBeUndefined();
    expect(hasDashboardNavSnapshotCache("clp")).toBe(false);
    expect(storage["nw:dashboard-nav-snapshot-v8:clp"]).toBeUndefined();

    // The next live snapshot, which carries the new slug, is kept.
    writeDashboardNavSnapshotCache("clp", snapshotWithSlugs([...OLD_SLUGS, "tst_new_portfolio"]));
    expect(hasDashboardNavSnapshotCache("clp")).toBe(true);
  });
});
