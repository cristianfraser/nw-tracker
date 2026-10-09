import { describe, expect, it } from "vitest";
import { isBundleContentLoading, useRealBundleForContent } from "./pageShapeReady";

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
