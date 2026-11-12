import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
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

function snapshotFixture() {
  const zeros = () => ({ net_worth: 0, buckets: { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 0 } });
  return {
    schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
    unit: "clp",
    accounts: [],
    card_metrics_by_slug: {},
    liabilities_breakdown: { mortgage: 0, credit_card: 0 },
    nw_bucket_totals: {
      net_worth: 1,
      buckets: { real_estate: 0, retirement: 0, brokerage: 0, cash_eqs: 1 },
      prior_closes: { month_end: "", year_end: "", month: zeros(), year: zeros() },
    },
  };
}

describe("hasDashboardNavSnapshotCache", () => {
  it("is false when localStorage is empty", () => {
    expect(hasDashboardNavSnapshotCache("clp")).toBe(false);
  });

  it("is true when unit cache exists", () => {
    writeDashboardNavSnapshotCache("clp", {
      ...snapshotFixture(),
    });
    expect(hasDashboardNavSnapshotCache("clp")).toBe(true);
  });

  it("a CLP cache does not stand in for USD", () => {
    writeDashboardNavSnapshotCache("clp", {
      ...snapshotFixture(),
    });
    expect(hasDashboardNavSnapshotCache("usd")).toBe(false);
  });
});

describe("prefetchDashboardNavSnapshot", () => {
  it("skips prefetch when cache exists", async () => {
    writeDashboardNavSnapshotCache("clp", {
      ...snapshotFixture(),
    });
    const qc = new QueryClient();
    const fetchSpy = vi.fn();
    qc.prefetchQuery = fetchSpy as typeof qc.prefetchQuery;
    await prefetchDashboardNavSnapshot(qc, "clp");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("stale nav snapshot vs a grown nav tree", () => {
  // The coverage rule reads which slugs have an entry and that each carries the current
  // fields, never the figures themselves.
  const metrics = { value: {}, parent_pct: {} } as unknown as NavCardMetricsDto;

  function snapshotWithSlugs(slugs: string[]): DashboardNavSnapshotResponse {
    return {
      schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
      unit: "clp",
      accounts: [],
      card_metrics_by_slug: Object.fromEntries(slugs.map((s) => [s, metrics])),
      liabilities_breakdown: { mortgage: 0, credit_card: 0 },
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
      schema_version: DTO_SCHEMA_VERSIONS.sidebar_nav,
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
      tax_return: null,
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

  it("does not cover a tree with entries saved from an older payload", () => {
    const covered = snapshotWithSlugs(OLD_SLUGS).card_metrics_by_slug;
    const noValue = { ...covered, tst_stocks: { parent_pct: {} } as unknown as NavCardMetricsDto };
    expect(navSnapshotCoversNavTree(noValue, sidebarNav(false))).toBe(false);
    const liquidatedWithoutValue = {
      ...covered,
      tst_stocks: { ...metrics, liquidated: { account_ids: [] } } as unknown as NavCardMetricsDto,
    };
    expect(navSnapshotCoversNavTree(liquidatedWithoutValue, sidebarNav(false))).toBe(false);
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

    // The next live snapshot, which carries the new slug, is kept.
    writeDashboardNavSnapshotCache("clp", snapshotWithSlugs([...OLD_SLUGS, "tst_new_portfolio"]));
    expect(hasDashboardNavSnapshotCache("clp")).toBe(true);
  });
});
