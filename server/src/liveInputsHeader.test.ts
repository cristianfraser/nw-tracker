import express from "express";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAggregationCached } from "./cacheRegistry.js";
import { cacheDepNodeLiveInputs, linkCacheDepNode, newCacheDepNode, noteLiveFxRead, noteLiveTickerRead, runInCacheDepNode } from "./cacheDependencies.js";
import { jsonResponseMiddleware } from "./jsonResponse.js";
import { formatLiveInputs, liveInputsMiddleware } from "./liveInputsHeader.js";

let builds = 0;
let base = "";
let close: () => void = () => {};

beforeAll(async () => {
  const app = express();
  app.use(jsonResponseMiddleware());
  app.use(liveInputsMiddleware());
  app.get("/api/static", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/live", async (_req, res) => {
    await Promise.resolve();
    noteLiveTickerRead("spy");
    res.json({ ok: true });
  });
  app.get("/api/cached", (_req, res) => {
    const value = getAggregationCached("daily.series|vitest-live-inputs-header", () => {
      builds += 1;
      noteLiveTickerRead("BTC-USD");
      noteLiveFxRead("USD_CLP");
      return { v: 1 };
    });
    res.json(value);
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => close());

describe("X-Live-Inputs", () => {
  it("says none when the response read nothing live", async () => {
    const res = await fetch(`${base}/api/static`);
    expect(res.headers.get("x-live-inputs")).toBe("none");
  });

  it("names a ticker read after an await", async () => {
    const res = await fetch(`${base}/api/live`);
    expect(res.headers.get("x-live-inputs")).toBe("SPY");
  });

  it("names the same inputs on a cache hit as on the build", async () => {
    const first = await fetch(`${base}/api/cached`);
    const second = await fetch(`${base}/api/cached`);
    expect(builds).toBe(1);
    expect(first.headers.get("x-live-inputs")).toBe("$fx,BTC-USD");
    expect(second.headers.get("x-live-inputs")).toBe("$fx,BTC-USD");
  });
});

describe("cacheDepNodeLiveInputs", () => {
  it("collects through linked children, cycles included", () => {
    const root = newCacheDepNode();
    const a = newCacheDepNode();
    const b = newCacheDepNode();
    runInCacheDepNode(a, () => {
      noteLiveTickerRead("VEA");
      linkCacheDepNode(b);
    });
    runInCacheDepNode(b, () => {
      noteLiveFxRead("USD_CLP");
      linkCacheDepNode(a);
    });
    runInCacheDepNode(root, () => linkCacheDepNode(a));
    const inputs = cacheDepNodeLiveInputs(root);
    expect(formatLiveInputs(inputs)).toBe("$fx,VEA");
  });
});
