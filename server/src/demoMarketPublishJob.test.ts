import { describe, expect, it } from "vitest";
import { parseServerConfig } from "./config.js";
import {
  DEMO_MARKET_PUBLISH_STALE_MS,
  demoMarketPublishToken,
  firstDemoMarketPublishMs,
  nextNightlyDemoMarketPublishMs,
} from "./demoMarketPublishJob.js";

// 2026-11-09 12:00 Chile (UTC−3) and the nightly slots around it.
const noonChile = Date.parse("2026-11-09T15:00:00Z");
const tonight1am = Date.parse("2026-11-10T04:00:00Z");

describe("demo market publish schedule", () => {
  it("runs nightly at 01:00 Chile, the next slot at least a minute ahead", () => {
    expect(nextNightlyDemoMarketPublishMs(noonChile)).toBe(tonight1am);
    expect(nextNightlyDemoMarketPublishMs(Date.parse("2026-11-10T03:59:30Z"))).toBe(Date.parse("2026-11-11T04:00:00Z"));
    expect(nextNightlyDemoMarketPublishMs(Date.parse("2026-11-10T03:58:00Z"))).toBe(tonight1am);
  });

  it("publishes at boot only when the last success is missing or stale", () => {
    expect(firstDemoMarketPublishMs(noonChile, null)).toBe(noonChile);
    expect(firstDemoMarketPublishMs(noonChile, new Date(noonChile - DEMO_MARKET_PUBLISH_STALE_MS).toISOString())).toBe(noonChile);
    expect(firstDemoMarketPublishMs(noonChile, new Date(noonChile - 60 * 60_000).toISOString())).toBe(tonight1am);
  });

  it("is configured by the token and the flag, off with the background jobs and on the demo", () => {
    expect(demoMarketPublishToken({})).toBeNull();
    expect(demoMarketPublishToken({ DEMO_MARKET_PUBLISH_TOKEN: "  x " })).toBe("x");
    expect(parseServerConfig({}).demoMarketPublish).toBe(true);
    expect(parseServerConfig({ BACKGROUND_JOBS_ENABLED: "0" }).demoMarketPublish).toBe(false);
    expect(parseServerConfig({ DEMO_MODE: "1", DEMO_MARKET_PUBLISH_ENABLED: "1" }).demoMarketPublish).toBe(false);
    expect(parseServerConfig({ DEMO_MARKET_PUBLISH_ENABLED: "0" }).demoMarketPublish).toBe(false);
  });
});
