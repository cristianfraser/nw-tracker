import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalCheckingCartolaXlsxFileName,
  isCheckingCartolaXlsxFileName,
  listCheckingCartolaXlsxFiles,
} from "./checkingCartolaParse.js";
import { organizeCheckingCartolaXlsxFromInbox } from "./checkingCartolaInbox.js";

describe("checkingCartolaInbox", () => {
  it("detects and canonicalizes Santander checking cartola xlsx names", () => {
    const name = "Cartola de cuenta Corriente - Mayo 2026.xlsx";
    expect(isCheckingCartolaXlsxFileName(name)).toBe(true);
    expect(canonicalCheckingCartolaXlsxFileName(name)).toBe(
      "2026-05-31 Cartola de cuenta Corriente - Mayo 2026.xlsx"
    );
  });

  it("moves inbox xlsx into excels/cuenta corriente", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cartola-inbox-"));
    const inbox = path.join(root, "inbox");
    const dest = path.join(root, "excels", "cuenta corriente");
    fs.mkdirSync(inbox, { recursive: true });

    const srcName = "Cartola de cuenta Corriente - Mayo 2026.xlsx";
    fs.writeFileSync(path.join(inbox, srcName), Buffer.from("xlsx"));

    const result = organizeCheckingCartolaXlsxFromInbox({ inboxDir: inbox, destDir: dest });
    expect(result.errors).toEqual([]);
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]?.to).toBe(
      "2026-05-31 Cartola de cuenta Corriente - Mayo 2026.xlsx"
    );
    expect(fs.existsSync(path.join(inbox, srcName))).toBe(false);
    expect(
      fs.existsSync(
        path.join(dest, "2026-05-31 Cartola de cuenta Corriente - Mayo 2026.xlsx")
      )
    ).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ignores net-worth cfraser.xlsx in cartola excels dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cartola-xlsx-"));
    fs.writeFileSync(path.join(root, "cfraser.xlsx"), Buffer.from("xlsx"));
    fs.writeFileSync(
      path.join(root, "2026-05-31 Cartola de cuenta Corriente - Mayo 2026.xlsx"),
      Buffer.from("xlsx")
    );
    expect(isCheckingCartolaXlsxFileName("cfraser.xlsx")).toBe(false);
    expect(listCheckingCartolaXlsxFiles(root)).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
