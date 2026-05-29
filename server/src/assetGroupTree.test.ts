import { describe, expect, it } from "vitest";
import {
  accountBelongsToDashboardBucket,
  assetGroupBySlug,
  dashboardBucketForAssetGroupSlug,
  isLeafAssetGroupSlug,
  leafAssetGroupIdsUnder,
  leafAssetGroupSlugsUnder,
  listAccountsForBucketSlug,
  resolveLegacyTabBucketSlug,
} from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";

describe("assetGroupTree", () => {
  it("resolves legacy brokerage tab queries to leaf buckets", () => {
    expect(resolveLegacyTabBucketSlug("brokerage", "acciones")).toBe("brokerage_acciones");
    expect(resolveLegacyTabBucketSlug("brokerage", "mutual_funds")).toBe("brokerage_mutual_funds");
    expect(resolveLegacyTabBucketSlug("retirement", "apv_a")).toBe("retirement_apv_a");
  });

  it("has nested brokerage leaves after migration", () => {
    expect(assetGroupBySlug("brokerage_acciones")).toBeTruthy();
    expect(isLeafAssetGroupSlug("brokerage_acciones")).toBe(false);
    expect(isLeafAssetGroupSlug("brokerage")).toBe(false);
    const leaves = leafAssetGroupIdsUnder("brokerage");
    expect(leaves.length).toBeGreaterThanOrEqual(3);
    const leafSlugs = leafAssetGroupSlugsUnder("brokerage");
    expect(leafSlugs.some((s) => s.startsWith("brokerage_acciones__"))).toBe(true);
  });

  it("walks asset_groups tree to dashboard parent buckets", () => {
    expect(dashboardBucketForAssetGroupSlug("brokerage_acciones")).toBe("brokerage");
    expect(dashboardBucketForAssetGroupSlug("retirement_apv_a")).toBe("retirement");
    expect(dashboardBucketForAssetGroupSlug("cash_eqs")).toBe("cash_eqs");
    expect(
      accountBelongsToDashboardBucket({
        group_slug: "brokerage_acciones",
        bucket_slug: "brokerage_acciones",
        dashboard_bucket_slug: "brokerage",
      }, "brokerage")
    ).toBe(true);
    expect(
      accountBelongsToDashboardBucket({
        group_slug: "brokerage_acciones",
        bucket_slug: "brokerage_acciones",
        dashboard_bucket_slug: "brokerage",
      }, "retirement")
    ).toBe(false);
  });

  it("lists acciones tab accounts from leaf bucket placement", () => {
    const rows = listAccountsForBucketSlug("brokerage", "acciones", NOTE_STOCKS_LEGACY);
    const slugs = new Set(rows.map((r) => r.bucket_slug));
    for (const s of slugs) {
      expect(s === "brokerage_acciones" || s.startsWith("brokerage_acciones__")).toBe(true);
    }
  });

  it("lists AFP + AFC tab including accounts on intermediate buckets", () => {
    const rows = listAccountsForBucketSlug("retirement", "afp_afc", NOTE_STOCKS_LEGACY);
    const names = rows.map((r) => r.name);
    expect(names).toContain("AFP");
    expect(names).toContain("AFC");
  });
});
