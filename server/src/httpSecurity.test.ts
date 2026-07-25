import { describe, expect, it } from "vitest";
import { DEMO_PAGEVIEW_PATH, demoReadOnlyMiddleware } from "./httpSecurity.js";

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

  it("exempts the analytics beacon and non-api paths", () => {
    expect(run("POST", DEMO_PAGEVIEW_PATH).nexted).toBe(true);
    expect(run("POST", "/login").nexted).toBe(true);
    expect(run("POST", "/apifoo").nexted).toBe(true);
  });
});
