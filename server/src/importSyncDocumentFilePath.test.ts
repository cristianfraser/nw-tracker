import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cfraserPaths from "./cfraserPaths.js";
import {
  archivedCreditCardStatementPdfFileName,
  assertCcStatementSourcePdfBasename,
  canonicalCcStatementPdfName,
  ccCardLast4FromSourcePdf,
  CcStatementPdfPathError,
  requireCcStatementPdfPath,
  resolveCartolaFilePath,
  resolveCcStatementPdfPath,
} from "./importSyncDocumentFilePath.js";

describe("importSyncDocumentFilePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves CC statement PDF under card slot dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-slot-"));
    const clpDir = path.join(root, "4343", "clp");
    fs.mkdirSync(clpDir, { recursive: true });
    const name = "2026-03-26 estado de cuenta tarjeta 4343.pdf";
    fs.writeFileSync(path.join(clpDir, name), "");
    vi.spyOn(cfraserPaths, "ccStatementPdfSearchDirs").mockImplementation((last4, usd) => {
      const slot = usd ? "usd" : "clp";
      return [path.join(root, last4 ?? "", slot)];
    });

    const abs = resolveCcStatementPdfPath(name, { usd: false });
    expect(abs).toBe(path.join(clpDir, name));
  });

  it("does not resolve stale basename when only canonical file exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-stale-"));
    const clpDir = path.join(root, "4343", "clp");
    fs.mkdirSync(clpDir, { recursive: true });
    const stale = "2025-12-27 estado de cuenta tarjeta 4343.pdf";
    const canonical = "2026-01-26 estado de cuenta tarjeta 4343.pdf";
    fs.writeFileSync(path.join(clpDir, canonical), "");
    vi.spyOn(cfraserPaths, "ccStatementPdfSearchDirs").mockImplementation((last4, usd) => {
      const slot = usd ? "usd" : "clp";
      return [path.join(root, last4 ?? "", slot)];
    });

    expect(resolveCcStatementPdfPath(stale, { usd: false })).toBeNull();
    expect(resolveCcStatementPdfPath(canonical, { usd: false })).toBe(
      path.join(clpDir, canonical)
    );
  });

  it("rejects numbered copy suffix in source_pdf", () => {
    expect(() =>
      assertCcStatementSourcePdfBasename("2024-12-23 estado de cuenta tarjeta usd 4141 (2).pdf", {
        card_last4: "4141",
        currency: "usd",
      })
    ).toThrow(CcStatementPdfPathError);
  });

  it("rejects basename without last4 suffix", () => {
    expect(() =>
      assertCcStatementSourcePdfBasename("2018-04-23 estado de cuenta tarjeta.pdf", {
        card_last4: "4141",
        currency: "clp",
      })
    ).toThrow(/basename must end with/);
  });

  it("requireCcStatementPdfPath throws when file is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-missing-"));
    vi.spyOn(cfraserPaths, "resolveCcStatementSlotDir").mockImplementation((last4, usd) =>
      path.join(root, last4, usd ? "usd" : "clp")
    );
    vi.spyOn(cfraserPaths, "ccStatementPdfSearchDirs").mockImplementation((last4, usd) => [
      path.join(root, last4, usd ? "usd" : "clp"),
    ]);

    const name = "2026-01-26 estado de cuenta tarjeta 4343.pdf";
    expect(() =>
      requireCcStatementPdfPath(name, {
        card_last4: "4343",
        currency: "clp",
      })
    ).toThrow(/missing PDF/);
  });

  it("builds canonical BCI PDF name from period_to", () => {
    expect(canonicalCcStatementPdfName("26/03/2026", "4343")).toBe(
      "2026-03-26 estado de cuenta tarjeta 4343.pdf"
    );
    expect(ccCardLast4FromSourcePdf("2026-03-27 estado de cuenta tarjeta 4343.pdf")).toBe(
      "4343"
    );
    expect(
      ccCardLast4FromSourcePdf("2026-03-26 estado de cuenta tarjeta usd 4141.pdf")
    ).toBe("4141");
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
    expect(resolveCcStatementPdfPath("import:web-paste|open|2026-05", { usd: false })).toBeNull();
  });

  it("returns null for screenshot cartola labels", () => {
    expect(resolveCartolaFilePath("checking_cartola", "screenshot:foo.png")).toBeNull();
  });
});
