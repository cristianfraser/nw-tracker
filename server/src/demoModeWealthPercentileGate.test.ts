/** Demo mode hides the wealth-percentile surface: sidebar-nav drops the link, the API 404s. */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerWealthPercentileRoutes } from "./routes/wealthPercentile.js";

let server: Server;
let baseUrl: string;
const originalDemoMode = process.env.DEMO_MODE;

beforeAll(async () => {
  const app = express();
  registerMetaRoutes(app);
  registerWealthPercentileRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("wealth percentile demo-mode gate", () => {
  it("serves the sidebar link and the payload outside demo mode", async () => {
    delete process.env.DEMO_MODE;

    const nav = await fetch(`${baseUrl}/api/meta/sidebar-nav`);
    expect(nav.status).toBe(200);
    const navBody = (await nav.json()) as { wealth_percentile: { slug: string } | null };
    expect(navBody.wealth_percentile?.slug).toBe("wealth_percentile");

    const api = await fetch(`${baseUrl}/api/wealth-percentile`);
    expect(api.status).toBe(200);
  });

  it("nulls the sidebar link and 404s the API in demo mode", async () => {
    process.env.DEMO_MODE = "1";

    const nav = await fetch(`${baseUrl}/api/meta/sidebar-nav`);
    expect(nav.status).toBe(200);
    const navBody = (await nav.json()) as { wealth_percentile: unknown };
    expect(navBody.wealth_percentile).toBeNull();

    const api = await fetch(`${baseUrl}/api/wealth-percentile`);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
  });
});
