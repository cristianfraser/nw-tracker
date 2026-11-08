import { describe, expect, it } from "vitest";
import {
  ccJsonStatementLineBaseKey,
  ccOneShotDedupeKey,
  dedupeKeyOccurrence,
  dedupeKeysByOccurrence,
  dedupeKeyWithOccurrence,
  isTwinDedupeKey,
} from "./ccDedupeKey.js";

describe("twin dedupe keys: one writer, one reader", () => {
  it("writes #dupN from the second occurrence on and reads it back", () => {
    expect(dedupeKeyWithOccurrence("k", 0)).toBe("k");
    expect(dedupeKeyWithOccurrence("k", 2)).toBe("k#dup2");
    expect(dedupeKeyOccurrence("k#dup2")).toBe(2);
    expect(dedupeKeyOccurrence("k")).toBe(0);
    expect(dedupeKeyOccurrence(null)).toBe(0);
    expect(isTwinDedupeKey("k#dup1")).toBe(true);
    expect(isTwinDedupeKey("k")).toBe(false);
  });

  it("indexes the Nth identical base in list order, per call", () => {
    expect(dedupeKeysByOccurrence(["a", "b", "a", "a"])).toEqual(["a", "b", "a#dup1", "a#dup2"]);
    expect(dedupeKeysByOccurrence(["a"])).toEqual(["a"]);
  });

  it("refuses a negative or fractional occurrence", () => {
    expect(() => dedupeKeyWithOccurrence("k", -1)).toThrow();
    expect(() => dedupeKeyWithOccurrence("k", 1.5)).toThrow();
  });
});

describe("statement-JSON line keys", () => {
  it("live in the json| space, are stable and tell currency and amount apart", () => {
    const a = ccJsonStatementLineBaseKey("A", "clp", "2026-01-05", "Shop X", "1000");
    expect(a).toMatch(/^json\|[0-9a-f]{16}$/);
    expect(ccJsonStatementLineBaseKey("A", "clp", "2026-01-05", "SHOP  X", "1000")).toBe(a);
    expect(ccJsonStatementLineBaseKey("A", "usd", "2026-01-05", "Shop X", "1000")).not.toBe(a);
    expect(ccJsonStatementLineBaseKey("A", "clp", "2026-01-05", "Shop X", "1001")).not.toBe(a);
    expect(ccOneShotDedupeKey("A", "Shop X", 1000, "2026-01-05")).not.toBe(a);
  });
});
