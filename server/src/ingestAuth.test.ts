import { describe, expect, it } from "vitest";
import { ingestAuthConfigFromEnv, ingestAuthMiddleware, isLoopbackAddress } from "./ingestAuth.js";

describe("ingestAuthMiddleware", () => {
  /** Express-shaped doubles: the guard reads the socket address and the auth header. */
  function run(
    config: Parameters<typeof ingestAuthMiddleware>[0],
    remoteAddress: string,
    authorization?: string
  ) {
    let nexted = false;
    let statusCode: number | null = null;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return { json: (payload: unknown) => void (body = payload) };
      },
    };
    const req = { socket: { remoteAddress }, headers: authorization ? { authorization } : {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ingestAuthMiddleware(config)(req as any, res as any, () => void (nexted = true));
    return { nexted, statusCode, body };
  }

  const local = { token: null, allowRemote: false, demoMode: false };

  it("lets local connections through and refuses remote ones", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(run(local, addr).nexted).toBe(true);
    }
    const remote = run(local, "192.168.1.20");
    expect(remote.statusCode).toBe(403);
    expect(remote.body).toMatchObject({ error: "ingest_forbidden" });
  });

  it("checks the bearer token when one is set, remote allowed only with it", () => {
    const withToken = { token: "abc", allowRemote: true, demoMode: false };
    expect(run(withToken, "10.0.0.5", "Bearer abc").nexted).toBe(true);
    expect(run(withToken, "10.0.0.5", "Bearer abd").statusCode).toBe(401);
    expect(run(withToken, "127.0.0.1").statusCode).toBe(401);
  });

  it("refuses everything in demo mode", () => {
    const r = run({ ...local, demoMode: true }, "127.0.0.1");
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatchObject({ error: "ingest_disabled" });
  });
});

describe("ingestAuthConfigFromEnv", () => {
  it("defaults to local-only without a token", () => {
    expect(ingestAuthConfigFromEnv({})).toEqual({ token: null, allowRemote: false, demoMode: false });
  });

  it("refuses remote access without a token", () => {
    expect(() => ingestAuthConfigFromEnv({ INGEST_ALLOW_REMOTE: "1" })).toThrow(/INGEST_TOKEN/);
    expect(
      ingestAuthConfigFromEnv({ INGEST_ALLOW_REMOTE: "1", INGEST_TOKEN: " t " })
    ).toEqual({ token: "t", allowRemote: true, demoMode: false });
  });

  it("reads the demo flag", () => {
    expect(ingestAuthConfigFromEnv({ DEMO_MODE: "1" }).demoMode).toBe(true);
  });
});

describe("isLoopbackAddress", () => {
  it("does not treat a missing address as local", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
