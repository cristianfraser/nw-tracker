import { describe, expect, it } from "vitest";
import {
  isBundleContentLoading,
  isPageShapeLoading,
  useRealBundleForContent,
} from "./pageShapeReady";

describe("isPageShapeLoading", () => {
  it("blocks only when both shape sources are still missing", () => {
    expect(isPageShapeLoading(true, undefined, true, undefined)).toBe(true);
  });

  it("does not block when accounts exist even if nav snapshot is pending", () => {
    expect(isPageShapeLoading(true, undefined, false, { accounts: [] })).toBe(false);
    expect(isPageShapeLoading(false, [], true, undefined)).toBe(false);
  });

  it("unblocks when both have data", () => {
    expect(isPageShapeLoading(false, [], false, { accounts: [] })).toBe(false);
  });
});

describe("isBundleContentLoading", () => {
  it("dims during unit switch with placeholder bundle", () => {
    expect(
      isBundleContentLoading({ isPending: false, isPlaceholderData: true, bundleReady: true })
    ).toBe(true);
  });

  it("shows loading on first fetch", () => {
    expect(
      isBundleContentLoading({ isPending: true, isPlaceholderData: false, bundleReady: false })
    ).toBe(true);
  });
});

describe("useRealBundleForContent", () => {
  it("returns false during unit switch with placeholder bundle", () => {
    expect(useRealBundleForContent(true, true)).toBe(false);
  });

  it("returns true when bundle is ready and not placeholder", () => {
    expect(useRealBundleForContent(false, true)).toBe(true);
  });

  it("returns false when bundle is not ready", () => {
    expect(useRealBundleForContent(false, false)).toBe(false);
  });
});
