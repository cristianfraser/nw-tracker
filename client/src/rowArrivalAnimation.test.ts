import { describe, expect, it } from "vitest";
import { arrivalMotion, nextSeenKeys } from "./rowArrivalAnimation";

const base = { arrived: true, narrow: false, reducedMotion: false };
const from = { top: 0, left: 0, width: 100, height: 40 };
const to = { top: 40, left: 0, width: 100, height: 40 };

describe("arrivalMotion", () => {
  it("fades a new row in with a tint", () => {
    const m = arrivalMotion({ ...base, action: "add" });
    expect(m.duration).toBeGreaterThan(0);
    expect(m.tint).toBe(true);
    expect(m.keyframes[0]).toEqual({ opacity: 0 });
  });
  it("leaves an add of an already shown key alone", () => {
    expect(arrivalMotion({ ...base, action: "add", arrived: false })).toMatchObject({ duration: 0, tint: false });
  });
  it("slides moved rows on desktop only", () => {
    expect(arrivalMotion({ ...base, action: "remain", from, to }).duration).toBeGreaterThan(0);
    expect(arrivalMotion({ ...base, action: "remain", from, to }).keyframes[0]).toEqual({ transform: "translate(0px, -40px)" });
    expect(arrivalMotion({ ...base, action: "remain", from, to, narrow: true }).duration).toBe(0);
    expect(arrivalMotion({ ...base, action: "remain", from: to, to }).duration).toBe(0);
  });
  it("removes instantly", () => {
    expect(arrivalMotion({ ...base, action: "remove" }).duration).toBe(0);
  });
  it("keeps only the tint under reduced motion", () => {
    expect(arrivalMotion({ ...base, action: "add", reducedMotion: true })).toMatchObject({ duration: 0, tint: true });
    expect(arrivalMotion({ ...base, action: "remain", from, to, reducedMotion: true }).duration).toBe(0);
  });
});

describe("nextSeenKeys", () => {
  it("takes the first non-empty list as the baseline", () => {
    expect(nextSeenKeys(null, []).seen).toBeNull();
    const first = nextSeenKeys(null, ["a", "b"]);
    expect(first.arrived.size).toBe(0);
    expect([...first.seen!]).toEqual(["a", "b"]);
  });
  it("reports only keys never shown, and keeps those that fell off", () => {
    const r = nextSeenKeys(new Set(["a", "b"]), ["n", "a"]);
    expect([...r.arrived]).toEqual(["n"]);
    expect([...r.seen!].sort()).toEqual(["a", "b", "n"]);
  });
});
