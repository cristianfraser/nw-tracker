import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The analytics module opens its own SQLite file from `DEMO_ANALYTICS_DB` at first use, so the
 * env var has to be set before the module is imported — hence the dynamic import below.
 */
const tempDir = mkdtempSync(join(tmpdir(), "nw-demo-analytics-"));
process.env.DEMO_ANALYTICS_DB = join(tempDir, "analytics.db");
process.env.DEMO_ANALYTICS_SALT = "vitest-analytics-salt";

const {
  demoAnalyticsDb,
  isBotUserAgent,
  normalizeBeaconPath,
  recordDemoPageview,
  recordDemoVisit,
  referrerOrigin,
  srcTagFromQuery,
  visitorKey,
} = await import("./demoAnalytics.js");

const DAY = "2026-07-24";

function visit(overrides: Partial<Parameters<typeof recordDemoVisit>[0]> = {}) {
  recordDemoVisit({
    day: DAY,
    visitor: "v1",
    src: null,
    referrer: null,
    country: null,
    userAgent: "Mozilla/5.0",
    ...overrides,
  });
}

beforeAll(() => {
  demoAnalyticsDb();
});

afterEach(() => {
  demoAnalyticsDb().exec("DELETE FROM demo_visits; DELETE FROM demo_pageviews;");
});

afterAll(() => {
  demoAnalyticsDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("visitorKey", () => {
  it("is stable within a day and different across days (no cross-day correlation)", () => {
    const today = visitorKey("1.2.3.4", "UA", DAY);
    expect(visitorKey("1.2.3.4", "UA", DAY)).toBe(today);
    expect(visitorKey("1.2.3.4", "UA", "2026-07-25")).not.toBe(today);
  });

  it("separates different visitors and never contains the raw ip", () => {
    const a = visitorKey("1.2.3.4", "UA", DAY);
    expect(visitorKey("5.6.7.8", "UA", DAY)).not.toBe(a);
    expect(visitorKey("1.2.3.4", "OtherUA", DAY)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("1.2.3.4");
  });
});

describe("request classification", () => {
  it("flags crawlers, uptime pings and empty user agents as bots", () => {
    expect(isBotUserAgent("Googlebot/2.1")).toBe(true);
    expect(isBotUserAgent("Render/1.0 health-check")).toBe(true);
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent("Mozilla/5.0 (Macintosh) Safari/605.1")).toBe(false);
  });

  it("keeps only the referrer origin", () => {
    expect(referrerOrigin("https://www.linkedin.com/jobs/private-thread?id=42")).toBe(
      "https://www.linkedin.com"
    );
    expect(referrerOrigin(undefined)).toBeNull();
    expect(referrerOrigin("not a url")).toBeNull();
  });

  it("sanitizes the src tag", () => {
    expect(srcTagFromQuery({ src: "linkedin" })).toBe("linkedin");
    expect(srcTagFromQuery({ src: "cv<script>" })).toBe("cvscript");
    expect(srcTagFromQuery({})).toBeNull();
    expect(srcTagFromQuery({ src: 42 })).toBeNull();
  });

  it("accepts only plausible in-app routes from the beacon", () => {
    expect(normalizeBeaconPath("/liabilities/cc/santander?x=1")).toBe("/liabilities/cc/santander");
    expect(normalizeBeaconPath("/")).toBe("/");
    expect(normalizeBeaconPath("//evil.example.com")).toBeNull();
    expect(normalizeBeaconPath("https://evil.example.com")).toBeNull();
    expect(normalizeBeaconPath(`/${"a".repeat(200)}`)).toBeNull();
    expect(normalizeBeaconPath(42)).toBeNull();
  });
});

describe("recordDemoVisit", () => {
  it("keeps one row per (day, visitor) and counts repeat requests", () => {
    visit();
    visit();
    visit({ day: "2026-07-25" });

    const rows = demoAnalyticsDb()
      .prepare(`SELECT day, visitor, request_count FROM demo_visits ORDER BY day`)
      .all();
    expect(rows).toEqual([
      { day: DAY, visitor: "v1", request_count: 2 },
      { day: "2026-07-25", visitor: "v1", request_count: 1 },
    ]);
  });

  it("keeps the arrival's src/referrer rather than the latest request's", () => {
    visit({ src: "linkedin", referrer: "https://www.linkedin.com" });
    visit({ src: "cv", referrer: null });

    const row = demoAnalyticsDb()
      .prepare(`SELECT src, referrer FROM demo_visits WHERE day = ? AND visitor = 'v1'`)
      .get(DAY);
    expect(row).toEqual({ src: "linkedin", referrer: "https://www.linkedin.com" });
  });

  it("backfills src when the arrival request had none", () => {
    visit({ src: null });
    visit({ src: "homepage" });
    const row = demoAnalyticsDb()
      .prepare(`SELECT src FROM demo_visits WHERE day = ? AND visitor = 'v1'`)
      .get(DAY);
    expect(row).toEqual({ src: "homepage" });
  });
});

describe("recordDemoPageview", () => {
  it("counts views per (day, visitor, path)", () => {
    recordDemoPageview(DAY, "v1", "/");
    recordDemoPageview(DAY, "v1", "/");
    recordDemoPageview(DAY, "v1", "/projections");
    recordDemoPageview(DAY, "v2", "/");

    const rows = demoAnalyticsDb()
      .prepare(`SELECT visitor, path, views FROM demo_pageviews ORDER BY visitor, path`)
      .all();
    expect(rows).toEqual([
      { visitor: "v1", path: "/", views: 2 },
      { visitor: "v1", path: "/projections", views: 1 },
      { visitor: "v2", path: "/", views: 1 },
    ]);
  });
});
