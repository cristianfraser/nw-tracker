import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBankConfig, requireMetlifeCardLast4 } from "../config.js";

describe("the metlife-fetch.json paid_with_card_last4 field", () => {
  let cfraserDir: string;
  let prevEnv: string | undefined;
  beforeEach(() => {
    cfraserDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cfraser-"));
    prevEnv = process.env.CFRASER_CSV_DIR;
    process.env.CFRASER_CSV_DIR = cfraserDir;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CFRASER_CSV_DIR;
    else process.env.CFRASER_CSV_DIR = prevEnv;
    fs.rmSync(cfraserDir, { recursive: true, force: true });
  });
  const write = (cfg: Record<string, unknown>) =>
    fs.writeFileSync(path.join(cfraserDir, "metlife-fetch.json"), JSON.stringify({ rut: "11.111.111-1", ...cfg }));

  it("signs in with the RUT and the metlife Keychain item", () => {
    write({});
    const config = loadBankConfig("metlife");
    expect(config.loginAccount).toBe("11.111.111-1");
    expect(config.keychain_service).toBe("nw-tracker-metlife");
  });

  it("is optional for the login and required by the receipts", () => {
    write({});
    expect(loadBankConfig("metlife").paid_with_card_last4).toBeNull();
    expect(() => requireMetlifeCardLast4(loadBankConfig("metlife"))).toThrow(/paid_with_card_last4/);
    write({ paid_with_card_last4: "0042" });
    expect(requireMetlifeCardLast4(loadBankConfig("metlife"))).toBe("0042");
  });

  it("refuses anything but four digits", () => {
    write({ paid_with_card_last4: "42" });
    expect(() => loadBankConfig("metlife")).toThrow(/last four digits/);
  });
});
