import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_PAGEVIEW_PATH,
  demoReadOnlyMiddleware,
  isValidDemoAuthEmail,
  issueSessionToken,
  readCookie,
  verifySessionToken,
} from "./httpSecurity.js";

describe("isValidDemoAuthEmail", () => {
  it("accepts plausible emails", () => {
    expect(isValidDemoAuthEmail("recruiter.jane@corp.com")).toBe(true);
    expect(isValidDemoAuthEmail("  a@b.co  ")).toBe(true);
    expect(isValidDemoAuthEmail("first+tag@sub.domain.dev")).toBe(true);
  });

  it("rejects non-emails (format check only)", () => {
    expect(isValidDemoAuthEmail("")).toBe(false);
    expect(isValidDemoAuthEmail("notanemail")).toBe(false);
    expect(isValidDemoAuthEmail("missing@tld")).toBe(false);
    expect(isValidDemoAuthEmail("two words@x.com")).toBe(false);
    expect(isValidDemoAuthEmail("@no-user.com")).toBe(false);
    expect(isValidDemoAuthEmail(`${"a".repeat(250)}@x.com`)).toBe(false);
  });
});

describe("session token", () => {
  const OLD_SECRET = process.env.SESSION_SECRET;
  const OLD_PW = process.env.AUTH_PASSWORD;

  beforeEach(() => {
    process.env.SESSION_SECRET = "vitest-session-secret";
    delete process.env.AUTH_PASSWORD;
  });

  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = OLD_SECRET;
    if (OLD_PW === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = OLD_PW;
  });

  it("round-trips the email (case/space-normalized)", () => {
    const token = issueSessionToken("  Recruiter.Jane@Corp.com ");
    expect(verifySessionToken(token)).toEqual({ email: "recruiter.jane@corp.com" });
  });

  it("rejects tampered payloads and signatures", () => {
    const token = issueSessionToken("jane@corp.com");
    const [emailPart, issuedAt, sig] = token.split(".");
    // Swap the email for another (valid) address, keeping the original signature.
    const otherEmail = Buffer.from("evil@corp.com", "utf8").toString("base64url");
    expect(verifySessionToken(`${otherEmail}.${issuedAt}.${sig}`)).toBeNull();
    // Flip the signature.
    expect(verifySessionToken(`${emailPart}.${issuedAt}.${sig}x`)).toBeNull();
    // Malformed shapes.
    expect(verifySessionToken("")).toBeNull();
    expect(verifySessionToken("a.b")).toBeNull();
    expect(verifySessionToken(null)).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = issueSessionToken("jane@corp.com");
    process.env.SESSION_SECRET = "a-different-secret";
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env.SESSION_MAX_AGE_MS = "1000";
    try {
      const stale = issueSessionToken("jane@corp.com", Date.now() - 5000);
      expect(verifySessionToken(stale)).toBeNull();
      const fresh = issueSessionToken("jane@corp.com");
      expect(verifySessionToken(fresh)).toEqual({ email: "jane@corp.com" });
    } finally {
      delete process.env.SESSION_MAX_AGE_MS;
    }
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

  it("exempts the analytics beacon and non-api paths", () => {
    expect(run("POST", DEMO_PAGEVIEW_PATH).nexted).toBe(true);
    expect(run("POST", "/login").nexted).toBe(true);
    expect(run("POST", "/apifoo").nexted).toBe(true);
  });
});

describe("readCookie", () => {
  it("extracts a named cookie from the Cookie header", () => {
    expect(readCookie("a=1; nw_session=abc.def; b=2", "nw_session")).toBe("abc.def");
    expect(readCookie("nw_session=only", "nw_session")).toBe("only");
    expect(readCookie("other=x", "nw_session")).toBeNull();
    expect(readCookie(undefined, "nw_session")).toBeNull();
  });
});
