import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { isValidDemoAuthEmail, recordDemoAuthLogin } from "./httpSecurity.js";

const FIXTURE_EMAIL = "vitest-recruiter@example.com";

afterEach(() => {
  db.prepare(`DELETE FROM demo_auth_logins WHERE email LIKE 'vitest-%'`).run();
});

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

describe("recordDemoAuthLogin", () => {
  it("inserts one row per (email, day) and increments request_count on repeats", () => {
    recordDemoAuthLogin(FIXTURE_EMAIL, "2026-07-01");
    recordDemoAuthLogin(`  ${FIXTURE_EMAIL.toUpperCase()}  `, "2026-07-01");
    recordDemoAuthLogin(FIXTURE_EMAIL, "2026-07-02");

    const rows = db
      .prepare(
        `SELECT email, day, request_count FROM demo_auth_logins
         WHERE email = ? ORDER BY day`
      )
      .all(FIXTURE_EMAIL) as { email: string; day: string; request_count: number }[];

    expect(rows).toEqual([
      { email: FIXTURE_EMAIL, day: "2026-07-01", request_count: 2 },
      { email: FIXTURE_EMAIL, day: "2026-07-02", request_count: 1 },
    ]);
  });
});
