import { describe, expect, it } from "vitest";
import { assetGroupBySlug } from "./assetGroupTree.js";
import { assetGroupIdForFintualCertV2Notes } from "./fintualCertV2.js";

describe("assetGroupIdForFintualCertV2Notes", () => {
  it("places apv_a and apv_b cert accounts on distinct leaf asset groups", () => {
    const aId = assetGroupIdForFintualCertV2Notes("import:fintual|cert|key=apv_a");
    const bId = assetGroupIdForFintualCertV2Notes("import:fintual|cert|key=apv_b");
    expect(aId).toBe(assetGroupBySlug("retirement_apv_a__apv")!.id);
    expect(bId).toBe(assetGroupBySlug("retirement_apv_b__apv")!.id);
    expect(aId).not.toBe(bId);
  });
});
