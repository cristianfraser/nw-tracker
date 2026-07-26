import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SURFACE_PREFS_LS_PREFIX,
  parseStoredSurfacePrefs,
  readStoredSurfacePrefs,
  writeStoredSurfacePref,
} from "./surfaceDisplayPrefs";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe("parseStoredSurfacePrefs", () => {
  it("returns {} for null, garbage, and non-object JSON", () => {
    expect(parseStoredSurfacePrefs(null)).toEqual({});
    expect(parseStoredSurfacePrefs("")).toEqual({});
    expect(parseStoredSurfacePrefs("not json")).toEqual({});
    expect(parseStoredSurfacePrefs("42")).toEqual({});
    expect(parseStoredSurfacePrefs('["day"]')).toEqual({});
    expect(parseStoredSurfacePrefs("null")).toEqual({});
  });

  it("keeps valid fields and drops invalid ones independently", () => {
    expect(parseStoredSurfacePrefs('{"period":"day"}')).toEqual({ period: "day" });
    expect(parseStoredSurfacePrefs('{"range":"3y"}')).toEqual({ range: "3y" });
    expect(parseStoredSurfacePrefs('{"period":"year","range":"total"}')).toEqual({
      period: "year",
      range: "total",
    });
    expect(parseStoredSurfacePrefs('{"period":"weekly","range":"3y"}')).toEqual({ range: "3y" });
    expect(parseStoredSurfacePrefs('{"period":"month","range":"2w"}')).toEqual({ period: "month" });
    expect(parseStoredSurfacePrefs('{"period":3,"range":null,"extra":true}')).toEqual({});
  });
});

describe("read/write stored surface prefs", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("reads {} for a surface with nothing stored", () => {
    expect(readStoredSurfacePrefs("home.overview")).toEqual({});
  });

  it("round-trips a single field and merges partial patches", () => {
    expect(writeStoredSurfacePref("group.brokerage.valuation", { period: "day" })).toEqual({
      period: "day",
    });
    expect(readStoredSurfacePrefs("group.brokerage.valuation")).toEqual({ period: "day" });

    // A later range write keeps the stored period (partial JSON merge).
    expect(writeStoredSurfacePref("group.brokerage.valuation", { range: "1y" })).toEqual({
      period: "day",
      range: "1y",
    });
    expect(readStoredSurfacePrefs("group.brokerage.valuation")).toEqual({
      period: "day",
      range: "1y",
    });

    // Sibling surfaces are independent (per page instance).
    expect(readStoredSurfacePrefs("group.retirement.valuation")).toEqual({});
  });

  it("drops garbage on the next write instead of throwing", () => {
    storage.setItem(`${SURFACE_PREFS_LS_PREFIX}rates.range`, "{corrupt");
    expect(readStoredSurfacePrefs("rates.range")).toEqual({});
    expect(writeStoredSurfacePref("rates.range", { range: "1y" })).toEqual({ range: "1y" });
    expect(readStoredSurfacePrefs("rates.range")).toEqual({ range: "1y" });
  });

  it("is a no-op without localStorage (non-browser contexts)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readStoredSurfacePrefs("home.overview")).toEqual({});
    expect(() => writeStoredSurfacePref("home.overview", { period: "month" })).not.toThrow();
  });
});
