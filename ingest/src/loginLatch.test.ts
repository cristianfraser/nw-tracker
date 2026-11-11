import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginLatch } from "./loginLatch.js";
import { loginLatchPath, santanderLoginLatch } from "./santander/loginLatch.js";

let dir: string;
const previous = process.env.CFRASER_CSV_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-latch-"));
  process.env.CFRASER_CSV_DIR = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.CFRASER_CSV_DIR;
  else process.env.CFRASER_CSV_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loginLatch", () => {
  const latch = loginLatch({ fileName: ".example-login-rejected.json", site: "Example", credentials: "RUT/Clave de Acceso" });

  it("refuses after a rejection until the Keychain item changes, then clears itself", () => {
    expect(latch.isLatched()).toBe(false);
    latch.assertNotLatched("svc", "acct", false, () => null);
    latch.recordCredentialsRejected("Datos incorrectos");
    expect(latch.isLatched()).toBe(true);
    const before = () => new Date(Date.now() - 60_000);
    expect(() => latch.assertNotLatched("svc", "acct", false, before)).toThrow(/Example rejected the RUT\/Clave de Acceso .*«Datos incorrectos».*-s svc -a "acct"/);
    // --force tries once without clearing.
    latch.assertNotLatched("svc", "acct", true, before);
    expect(latch.isLatched()).toBe(true);
    latch.assertNotLatched("svc", "acct", false, () => new Date(Date.now() + 60_000));
    expect(latch.isLatched()).toBe(false);
  });

  it("is per site: Santander's file is its own", () => {
    latch.recordCredentialsRejected("x");
    expect(santanderLoginLatch.isLatched()).toBe(false);
    expect(loginLatchPath()).toBe(path.join(dir, ".santander-login-rejected.json"));
    santanderLoginLatch.recordCredentialsRejected("Alguno de los datos ingresados es incorrecto");
    expect(() => santanderLoginLatch.assertNotLatched("nw-tracker-santander", "r", false, () => null)).toThrow(
      /^Not logging in: the bank rejected the RUT\/Clave Digital on .* risks the bank blocking it\./
    );
    santanderLoginLatch.clear("test");
    expect(santanderLoginLatch.isLatched()).toBe(false);
    expect(latch.isLatched()).toBe(true);
  });

  it("refuses a file that is not a latch", () => {
    fs.writeFileSync(latch.path(), "{}");
    expect(() => latch.assertNotLatched("svc", "acct", false, () => null)).toThrow(/is not a login latch/);
  });
});
