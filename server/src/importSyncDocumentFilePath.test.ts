import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cfraserPaths from "./cfraserPaths.js";
import { resolveCfraserPdfsDir } from "./cfraserPaths.js";
import {
  archivedCreditCardStatementPdfFileName,
  canonicalCcStatementPdfName,
  ccCardLast4FromSourcePdf,
  resolveCartolaFilePath,
  resolveCcStatementPdfPath,
} from "./importSyncDocumentFilePath.js";

describe("importSyncDocumentFilePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves CC statement PDF under cfraser/credit-card-statements", () => {
    const dir = resolveCfraserPdfsDir();
    if (!fs.existsSync(dir)) return;
    const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"));
    if (names.length === 0) return;
    const name = names[0]!;
    const abs = resolveCcStatementPdfPath(name);
    expect(abs).toBe(path.resolve(dir, name));
  });

  it("prefers period_to canonical name over stale source_pdf basename", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-resolve-"));
    vi.spyOn(cfraserPaths, "resolveCfraserPdfsDir").mockReturnValue(dir);
    const stale = "2025-12-27 estado de cuenta tarjeta 4343.pdf";
    const canonical = "2026-01-26 estado de cuenta tarjeta 4343.pdf";
    fs.writeFileSync(path.join(dir, stale), "");
    fs.writeFileSync(path.join(dir, canonical), "");

    const abs = resolveCcStatementPdfPath(stale, { periodTo: "26/01/2026" });
    expect(abs).toBe(path.resolve(dir, canonical));
  });

  it("builds canonical BCI PDF name from period_to", () => {
    expect(canonicalCcStatementPdfName("26/03/2026", "4343")).toBe(
      "2026-03-26 estado de cuenta tarjeta 4343.pdf"
    );
    expect(ccCardLast4FromSourcePdf("2026-03-27 estado de cuenta tarjeta 4343.pdf")).toBe(
      "4343"
    );
  });

  it("builds archived CC PDF name for CLP and USD rows", () => {
    expect(
      archivedCreditCardStatementPdfFileName({
        period_to: "26/03/2026",
        card_last4: "4343",
        currency: "clp",
      })
    ).toBe("2026-03-26 estado de cuenta tarjeta 4343.pdf");
    expect(
      archivedCreditCardStatementPdfFileName({
        period_to: "2026-03-26",
        card_last4: "4141",
        currency: "usd",
      })
    ).toBe("2026-03-26 estado de cuenta tarjeta usd 4141.pdf");
    expect(
      archivedCreditCardStatementPdfFileName({
        period_to: "26/03/2026",
        card_last4: "4141",
        parser_layout: "international_usd",
      })
    ).toBe("2026-03-26 estado de cuenta tarjeta usd 4141.pdf");
  });

  it("returns null for web-paste statement sources", () => {
    expect(resolveCcStatementPdfPath("import:web-paste|open|2026-05")).toBeNull();
  });

  it("returns null for screenshot cartola labels", () => {
    expect(resolveCartolaFilePath("checking_cartola", "screenshot:foo.png")).toBeNull();
  });
});
