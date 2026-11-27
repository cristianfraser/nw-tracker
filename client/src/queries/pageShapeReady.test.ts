import { describe, expect, it } from "vitest";
import { bundleContent, dailyPayloadPending } from "./pageShapeReady";
import type { HeldUnitView } from "./heldUnitPayload";

type Bundle = { unit: string; ready: boolean };
const ready = (b: Bundle) => b.ready;
const shown = (p: Partial<HeldUnitView<Bundle>>): HeldUnitView<Bundle> => ({
  data: undefined,
  held: false,
  unit: undefined,
  loading: false,
  live: undefined,
  error: null,
  ...p,
});

describe("bundleContent", () => {
  it("draws a held bundle of another unit, dimmed, and stores nothing", () => {
    const held = { unit: "clp", ready: true };
    expect(bundleContent(shown({ data: held, held: true, loading: true }), ready)).toEqual({
      content: held,
      loading: true,
      live: undefined,
    });
  });

  it("draws and stores this unit's live bundle, undimmed", () => {
    const live = { unit: "usd", ready: true };
    expect(bundleContent(shown({ data: live, live }), ready)).toEqual({ content: live, loading: false, live });
  });

  it("has no content (the page's zero placeholder) while nothing is on hand or ready", () => {
    expect(bundleContent(shown({ loading: true }), ready)).toEqual({ content: undefined, loading: true, live: undefined });
    const partial = { unit: "usd", ready: false };
    expect(bundleContent(shown({ data: partial, live: partial }), ready)).toEqual({
      content: undefined,
      loading: true,
      live: undefined,
    });
  });
});

describe("dailyPayloadPending", () => {
  it("is pending in day mode only with no daily payload at all", () => {
    expect(dailyPayloadPending(true, { data: undefined })).toBe(true);
    // A held daily series (another unit or range) is drawn, dimmed: not pending.
    expect(dailyPayloadPending(true, { data: { unit: "clp" } })).toBe(false);
    expect(dailyPayloadPending(false, { data: undefined })).toBe(false);
  });
});
