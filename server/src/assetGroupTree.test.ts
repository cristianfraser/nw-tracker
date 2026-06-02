import { describe, expect, it } from "vitest";
import {
  accountBelongsToDashboardBucket,
  assetGroupBySlug,
  dashboardBucketForAssetGroupSlug,
  isLeafAssetGroupSlug,
  leafAssetGroupIdForKindSlug,
  leafAssetGroupIdsUnder,
  leafAssetGroupSlugsUnder,
  leafAssetGroupSlugForKindSlug,
  listAccountsForBucketSlug,
} from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";

describe("assetGroupTree", () => {
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
    expect(dashboardBucketForAssetGroupSlug("cash_eqs")).toBe(null);
    expect(dashboardBucketForAssetGroupSlug("cash_eqs__cash_savings")).toBe("cash_eqs");
    expect(dashboardBucketForAssetGroupSlug("cash_eqs__checking_accounts")).toBe(null);
    expect(dashboardBucketForAssetGroupSlug("cash_eqs__fondo_reserva")).toBe("cash_eqs");
    expect(dashboardBucketForAssetGroupSlug("cash_eqs__cuenta_corriente")).toBe(null);
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

  it("lists acciones tab accounts from portfolio brokerage_acciones group", () => {
    const rows = listAccountsForBucketSlug("brokerage_acciones", undefined, NOTE_STOCKS_LEGACY);
    const slugs = new Set(rows.map((r) => r.bucket_slug));
    for (const s of slugs) {
      expect(s === "brokerage_acciones" || s.startsWith("brokerage_acciones__")).toBe(true);
    }
  });

  it("resolves afc kind to leaf bucket, not retirement_afp_afc parent", () => {
    expect(leafAssetGroupSlugForKindSlug("afc")).toBe("retirement_afp_afc__afc");
    expect(leafAssetGroupSlugForKindSlug("afp")).toBe("retirement_afp_afc__afp");
    expect(leafAssetGroupIdForKindSlug("afc")).toBeGreaterThan(0);
  });

  it("lists AFP + AFC from retirement_afp_afc portfolio group", () => {
    const rows = listAccountsForBucketSlug("retirement_afp_afc", undefined, NOTE_STOCKS_LEGACY);
    const names = rows.map((r) => r.name);
    expect(names).toContain("AFP");
    expect(names).toContain("AFC");
  });
});
