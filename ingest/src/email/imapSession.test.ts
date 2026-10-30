import { describe, expect, it } from "vitest";
import { isImapConnectionError, retryOnConnectionError } from "./imapSession.js";

function failure(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...extra });
}

describe("isImapConnectionError", () => {
  it("takes the failures seen on 2026-10-29 as the connection's", () => {
    expect(isImapConnectionError(failure("ECONNRESET"))).toBe(true);
    expect(isImapConnectionError(failure("ETIMEOUT"))).toBe(true);
    // imapflow marks a close during login as authenticationFailed, with no server code.
    expect(isImapConnectionError(failure("NoConnection", { authenticationFailed: true }))).toBe(true);
  });

  it("never retries an answer the server gave", () => {
    expect(isImapConnectionError(failure("NoConnection", { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe(false);
    expect(isImapConnectionError(new Error("expected exactly one pdf attachment"))).toBe(false);
    expect(isImapConnectionError(failure("ETHROTTLE"))).toBe(false);
  });
});

describe("retryOnConnectionError", () => {
  const noSleep = async () => undefined;

  it("runs the session again after a dropped connection", async () => {
    const attempts: number[] = [];
    const value = await retryOnConnectionError(
      "test",
      async (n) => {
        attempts.push(n);
        if (n < 3) throw failure("ECONNRESET");
        return "done";
      },
      { delaysMs: [1, 1], sleep: noSleep }
    );
    expect(value).toBe("done");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("gives up after the last delay with the connection's own error", async () => {
    let calls = 0;
    await expect(
      retryOnConnectionError(
        "test",
        async () => {
          calls++;
          throw failure("ETIMEOUT");
        },
        { delaysMs: [1, 1], sleep: noSleep }
      )
    ).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(calls).toBe(3);
  });

  it("throws any other failure at once", async () => {
    let calls = 0;
    await expect(
      retryOnConnectionError(
        "test",
        async () => {
          calls++;
          throw new Error("template changed");
        },
        { delaysMs: [1, 1], sleep: noSleep }
      )
    ).rejects.toThrow("template changed");
    expect(calls).toBe(1);
  });
});
