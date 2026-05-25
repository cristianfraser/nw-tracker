import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCfraserPdfsDir } from "./cfraserPaths.js";
import { resolveCartolaFilePath, resolveCcStatementPdfPath } from "./importSyncDocumentFilePath.js";

describe("importSyncDocumentFilePath", () => {
  it("resolves CC statement PDF under cfraser/credit-card-statements", () => {
    const dir = resolveCfraserPdfsDir();
    if (!fs.existsSync(dir)) return;
    const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"));
    if (names.length === 0) return;
    const name = names[0]!;
    const abs = resolveCcStatementPdfPath(name);
    expect(abs).toBe(path.resolve(dir, name));
  });

  it("returns null for web-paste statement sources", () => {
    expect(resolveCcStatementPdfPath("import:web-paste|open|2026-05")).toBeNull();
  });

  it("returns null for screenshot cartola labels", () => {
    expect(resolveCartolaFilePath("checking_cartola", "screenshot:foo.png")).toBeNull();
  });
});
