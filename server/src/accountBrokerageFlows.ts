import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import type { AccountRow } from "./movementUnitsPolicy.js";
import { parsePanelAccountNotes } from "./panelAccountNotes.js";

const LEGACY_BROKERAGE_CATEGORY_SLUGS = new Set(["spy", "vea"]);

export function accountUsesBrokerageFlowKinds(
  account: AccountRow,
  notes?: string | null
): boolean {
  const noteText = notes ?? account.notes ?? null;
  if (LEGACY_BROKERAGE_CATEGORY_SLUGS.has(account.bucket_slug)) return true;
  const dashBucket =
    dashboardBucketForAssetGroupSlug(account.group_slug) ??
    dashboardBucketForAssetGroupSlug(account.bucket_slug);
  if (dashBucket === "brokerage" && parsePanelAccountNotes(noteText) != null) {
    return true;
  }
  return false;
}
