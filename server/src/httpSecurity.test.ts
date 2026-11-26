import type { RequestHandler } from "express";
import { describe, expect, it } from "vitest";
import { parseServerConfig } from "./config.js";
import { crossSiteWriteGuardMiddleware, demoReadOnlyMiddleware, hostAllowlistMiddleware } from "./httpSecurity.js";
import { USAGE_PAGE_VIEW_PATH } from "./usagePagePath.js";

/** Runs one middleware on an Express-shaped double: method, path, headers and status().json(). */
function runGuard(guard: RequestHandler, method: string, path: string, headers: Record<string, string>) {
  let nexted = false;
  let statusCode: number | null = null;
  let body: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return { json: (payload: unknown) => void (body = payload) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guard({ method, path, headers } as any, res as any, () => void (nexted = true));
  return { nexted, statusCode, body };
}

describe("hostAllowlistMiddleware", () => {
  const personal = parseServerConfig({
    CORS_ALLOWED_ORIGINS: "http://dev-box.test:5173",
    ALLOWED_HOSTS: "Tracker.Example.org, 10.0.0.5",
  });
  const get = (host: string | undefined) =>
    runGuard(hostAllowlistMiddleware(personal), "GET", "/api/dashboard/page-bundle", host == null ? {} : { host });

  it("lets loopback in on any port (the deploy agent and the ingest service call 127.0.0.1)", () => {
    for (const host of ["127.0.0.1:3001", "localhost:3299", "localhost", "[::1]:3001", "LOCALHOST."]) {
      expect(get(host).nexted, host).toBe(true);
    }
  });

  it("lets in the CORS origins' hosts and ALLOWED_HOSTS, port ignored, case folded", () => {
    expect(get("dev-box.test:3001").nexted).toBe(true);
    expect(get("tracker.example.org").nexted).toBe(true);
    expect(get("TRACKER.example.org:443").nexted).toBe(true);
    expect(get("10.0.0.5:3001").nexted).toBe(true);
  });

  it("refuses any other Host, and a request with none", () => {
    for (const host of ["rebound.attacker.test:3001", "127.0.0.2:3001", "tracker.example.org.attacker.test", undefined]) {
      const r = get(host);
      expect(r.nexted, String(host)).toBe(false);
      expect(r.statusCode).toBe(421);
      expect(r.body).toEqual({ error: "host_not_allowed" });
    }
  });

  it("is off in the demo, which serves public data on its platform hostname", () => {
    const demo = parseServerConfig({ DEMO_MODE: "1" });
    expect(runGuard(hostAllowlistMiddleware(demo), "GET", "/api/health", { host: "demo.platform.test" }).nexted).toBe(true);
  });

  it("refuses to boot on an ALLOWED_HOSTS entry that is a URL", () => {
    expect(() => parseServerConfig({ ALLOWED_HOSTS: "https://tracker.example.org" })).toThrow(/ALLOWED_HOSTS/);
  });
});

describe("crossSiteWriteGuardMiddleware", () => {
  const personal = parseServerConfig({ ALLOWED_HOSTS: "tracker.example.org" });
  const write = (headers: Record<string, string>, path = "/api/import-sync/jobs/7/cancel", method = "POST") =>
    runGuard(crossSiteWriteGuardMiddleware(personal), method, path, { host: "127.0.0.1:3001", ...headers });

  it("refuses a write from another site's page", () => {
    for (const headers of <Record<string, string>[]>[
      { origin: "https://attacker.test", "sec-fetch-site": "cross-site" },
      { origin: "https://attacker.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:8080", "sec-fetch-site": "same-site" },
    ]) {
      const r = write(headers);
      expect(r.nexted, JSON.stringify(headers)).toBe(false);
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: "cross_site_write" });
    }
    expect(write({ origin: "https://attacker.test" }, "/api/ingest/batches").statusCode).toBe(403);
    expect(write({ origin: "https://attacker.test" }, "/api/movements/3", "DELETE").statusCode).toBe(403);
  });

  it("passes requests with no Origin: curl, the ingest service, the deploy agent", () => {
    expect(write({}).nexted).toBe(true);
    expect(write({ "sec-fetch-mode": "cors" }, "/api/jobs/claim").nexted).toBe(true);
  });

  it("passes the app's own pages", () => {
    // Served by the server itself (same Host), through the Vite proxy (Host rewritten, the browser
    // says same-origin), a CORS-allowed dev origin, and the public name behind a proxy.
    expect(write({ origin: "http://127.0.0.1:3001", "sec-fetch-site": "same-origin" }).nexted).toBe(true);
    expect(write({ origin: "http://127.0.0.1:3001" }).nexted).toBe(true);
    expect(write({ origin: "http://localhost:5199", "sec-fetch-site": "same-origin" }).nexted).toBe(true);
    expect(write({ origin: "http://localhost:5173", "sec-fetch-site": "same-site" }).nexted).toBe(true);
    expect(write({ origin: "https://tracker.example.org" }).nexted).toBe(true);
    // The page-view beacon is a same-origin sendBeacon POST.
    expect(write({ origin: "http://127.0.0.1:3001", "sec-fetch-site": "same-origin" }, USAGE_PAGE_VIEW_PATH).nexted).toBe(true);
  });

  it("leaves reads and non-api paths alone", () => {
    const guard = crossSiteWriteGuardMiddleware(personal);
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(runGuard(guard, method, "/api/dashboard/page-bundle", { origin: "https://attacker.test" }).nexted).toBe(true);
    }
    expect(runGuard(guard, "POST", "/apifoo", { origin: "https://attacker.test" }).nexted).toBe(true);
  });

  it("is off in the demo (its counted edits and beacon come from its own pages anyway)", () => {
    const demo = parseServerConfig({ DEMO_MODE: "1" });
    const guard = crossSiteWriteGuardMiddleware(demo);
    expect(runGuard(guard, "PATCH", "/api/flows/expenses/lines/12/category", { origin: "https://elsewhere.test" }).nexted).toBe(true);
  });
});

describe("demoReadOnlyMiddleware", () => {
  /** Minimal Express-shaped doubles: the guard only touches method/path and status().json(). */
  function run(method: string, path: string) {
    const guard = demoReadOnlyMiddleware();
    let nexted = false;
    let statusCode: number | null = null;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return { json: (payload: unknown) => void (body = payload) };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guard({ method, path } as any, res as any, () => void (nexted = true));
    return { nexted, statusCode, body };
  }

  it("passes reads through", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(run(method, "/api/dashboard/page-bundle").nexted).toBe(true);
    }
  });

  it("rejects /api mutations with the demo_read_only sentinel", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = run(method, "/api/movements");
      expect(r.nexted).toBe(false);
      expect(r.statusCode).toBe(403);
      expect(r.body).toEqual({ error: "demo_read_only" });
    }
  });

  it("lets the allowlisted demo edits through (counted by the quota middleware)", () => {
    expect(run("PATCH", "/api/flows/expenses/lines/12/category").nexted).toBe(true);
    expect(run("POST", "/api/flows/expenses/manual").nexted).toBe(true);
    expect(run("PATCH", "/api/flows/expenses/purchase-notes").statusCode).toBe(403);
  });

  it("exempts the analytics beacon and non-api paths", () => {
    expect(run("POST", USAGE_PAGE_VIEW_PATH).nexted).toBe(true);
    expect(run("POST", "/login").nexted).toBe(true);
    expect(run("POST", "/apifoo").nexted).toBe(true);
  });
});
