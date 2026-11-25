import { describe, expect, it } from "vitest";
import { compareLatestRowOrderKeys, latestRowOrderKey } from "./latestMovementOrder.js";

const chile = (wall: string) => Date.parse(`${wall}-03:00`);
const DAY = "2026-01-15"; // summer time: UTC−3

describe("latestRowOrderKey", () => {
  it("takes the first stated time that falls on the row's day", () => {
    const key = latestRowOrderKey(DAY, {
      stated: [chile("2026-01-17T09:00:00"), chile("2026-01-15T12:30:00")],
      bounds: [chile("2026-01-15T22:00:00")],
      seq: 3,
    });
    expect(key).toEqual({ atMs: chile("2026-01-15T12:30:00"), seq: 3 });
  });

  it("else the earliest upper bound, clamped into the row's day", () => {
    expect(latestRowOrderKey(DAY, { stated: [], bounds: [chile("2026-01-15T22:00:00"), chile("2026-01-15T10:05:00")], seq: 1 }).atMs).toBe(
      chile("2026-01-15T10:05:00")
    );
    // First read the next day: the end of its own day.
    expect(latestRowOrderKey(DAY, { stated: [], bounds: [chile("2026-01-16T13:00:00")], seq: 1 }).atMs).toBe(
      chile("2026-01-16T00:00:00") - 1
    );
    expect(latestRowOrderKey(DAY, { stated: [], bounds: [], seq: null })).toEqual({ atMs: null, seq: null });
  });

  it("reads the Chile day in winter time too (UTC−4)", () => {
    const july = Date.parse("2026-07-10T23:30:00-04:00");
    expect(latestRowOrderKey("2026-07-10", { stated: [july], bounds: [], seq: null }).atMs).toBe(july);
  });
});

describe("compareLatestRowOrderKeys", () => {
  it("puts the later moment first, then the later write, missing ones last", () => {
    const keys = [
      { atMs: null, seq: 9 },
      { atMs: 100, seq: 1 },
      { atMs: 200, seq: null },
      { atMs: 100, seq: 2 },
    ];
    expect([...keys].sort(compareLatestRowOrderKeys)).toEqual([
      { atMs: 200, seq: null },
      { atMs: 100, seq: 2 },
      { atMs: 100, seq: 1 },
      { atMs: null, seq: 9 },
    ]);
  });
});
