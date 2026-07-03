import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as cfraserPaths from "./cfraserPaths.js";
import {
  archivedCreditCardStatementPdfFileName,
  assertCcStatementSourcePdfBasename,
  buildCartolaPathsFromParsedPdfEntries,
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

  it("resolves CC statement PDF from legacy slot when card dir is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-legacy-"));
    const legacyDir = path.join(root, "legacy", "clp");
    fs.mkdirSync(legacyDir, { recursive: true });
    const name = "2017-09-22 estado de cuenta tarjeta 4113.pdf";
    fs.writeFileSync(path.join(legacyDir, name), "");
    vi.spyOn(cfraserPaths, "ccStatementPdfSearchDirs").mockImplementation((last4, usd) => {
      const slot = usd ? "usd" : "clp";
      return [path.join(root, last4 ?? "", slot), path.join(root, "legacy", slot)];
    });

    expect(resolveCcStatementPdfPath(name, { usd: false })).toBe(path.join(legacyDir, name));
  });

  it("resolves predecessor-card PDF under successor slot dir (4113 -> 4141)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pdf-redirect-"));
    const masterDir = path.join(root, "4141", "usd");
    fs.mkdirSync(masterDir, { recursive: true });
    const name = "2017-09-22 estado de cuenta tarjeta usd 4113.pdf";
    fs.writeFileSync(path.join(masterDir, name), "");
    vi.spyOn(cfraserPaths, "ccStatementPdfSearchDirs").mockImplementation((last4, usd) => {
      const slot = usd ? "usd" : "clp";
      const dirs = [path.join(root, last4 ?? "", slot)];
      if (last4 === "4113") dirs.push(path.join(root, "4141", slot));
      dirs.push(path.join(root, "legacy", slot));
      return dirs;
    });

    expect(resolveCcStatementPdfPath(name, { usd: true })).toBe(path.join(masterDir, name));
  });

  it("returns null for web-paste statement sources", () => {
    expect(resolveCcStatementPdfPath("import:web-paste|open|2026-05", { usd: false })).toBeNull();
  });

  it("returns null for screenshot cartola labels", () => {
    expect(resolveCartolaFilePath("checking_cartola", "screenshot:foo.png")).toBeNull();
  });

  it("treats parsed zero-movement cartola PDF as covered month", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-pdf-json-"));
    const pdfDir = path.join(root, "cartolas-cuenta-vista");
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfName = "2021-04-30 cartola cuenta vista.pdf";
    fs.writeFileSync(path.join(pdfDir, pdfName), "");
    vi.spyOn(cfraserPaths, "resolveCfraserCuentaVistaCartolaPdfsDir").mockReturnValue(pdfDir);

    const abs = path.join(pdfDir, pdfName);
    const paths = buildCartolaPathsFromParsedPdfEntries(
      [
        {
          source_file: pdfName,
          period_month: "2021-04",
          parse_status: "ok",
          movements: [],
        },
      ],
      "cuenta_vista_cartola"
    );
    expect(paths.get("2021-04")?.path).toBe(abs);
    expect(paths.has("2021-03")).toBe(false);
  });

  it("does not map prior-month DESDE to a single-month April statement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-pdf-apr2024-"));
    const pdfDir = path.join(root, "cartolas-cuenta-vista");
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfName = "2024-04-30 cartola cuenta vista 59.pdf";
    const abs = path.join(pdfDir, pdfName);
    fs.writeFileSync(abs, "");
    vi.spyOn(cfraserPaths, "resolveCfraserCuentaVistaCartolaPdfsDir").mockReturnValue(pdfDir);

    const paths = buildCartolaPathsFromParsedPdfEntries(
      [
        {
          source_file: pdfName,
          period_month: "2024-04",
          period_from: "2024-03-28",
          period_to: "2024-04-30",
          parse_status: "ok",
          movements: [{ occurred_on: "2024-04-07" }],
        },
      ],
      "cuenta_vista_cartola"
    );
    expect(paths.get("2024-04")?.path).toBe(abs);
    expect(paths.has("2024-03")).toBe(false);
  });

  it("covers every month in a multi-month vista cartola period range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-pdf-multimonth-"));
    const pdfDir = path.join(root, "cartolas-cuenta-vista");
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfName = "2019-10-31 cartola cuenta vista 65.pdf";
    fs.writeFileSync(path.join(pdfDir, pdfName), "");
    vi.spyOn(cfraserPaths, "resolveCfraserCuentaVistaCartolaPdfsDir").mockReturnValue(pdfDir);

    const paths = buildCartolaPathsFromParsedPdfEntries(
      [
        {
          source_file: pdfName,
          period_month: "2019-10",
          period_from: "2018-11-01",
          period_to: "2019-10-31",
          parse_status: "ok",
          movements: [
            { occurred_on: "2018-11-05" },
            { occurred_on: "2019-03-15" },
            { occurred_on: "2019-10-20" },
          ],
        },
      ],
      "cuenta_vista_cartola"
    );
    expect(paths.get("2019-03")?.path).toBe(path.join(pdfDir, pdfName));
    expect(paths.get("2018-11")?.path).toBe(path.join(pdfDir, pdfName));
    expect(paths.has("2019-11")).toBe(false);
  });

  it("keeps sin-mov monthly PDF for its statement month when multi-month PDF has no Feb movements", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-pdf-sinmov-tie-"));
    const pdfDir = path.join(root, "cartolas-cuenta-vista");
    fs.mkdirSync(pdfDir, { recursive: true });
    const sinMovName = "2019-02-28 cartola cuenta vista.pdf";
    const multiName = "2019-10-31 cartola cuenta vista.pdf";
    const sinMovPath = path.join(pdfDir, sinMovName);
    const multiPath = path.join(pdfDir, multiName);
    fs.writeFileSync(sinMovPath, "");
    fs.writeFileSync(multiPath, "");
    vi.spyOn(cfraserPaths, "resolveCfraserCuentaVistaCartolaPdfsDir").mockReturnValue(pdfDir);

    const paths = buildCartolaPathsFromParsedPdfEntries(
      [
        {
          source_file: sinMovName,
          period_month: "2019-02",
          parse_status: "ok",
          movements: [],
          cartola_sin_movimientos: true,
        },
        {
          source_file: multiName,
          period_month: "2019-10",
          period_from: "2018-11-01",
          period_to: "2019-10-31",
          parse_status: "ok",
          movements: [{ occurred_on: "2019-03-15" }],
        },
      ],
      "cuenta_vista_cartola"
    );
    expect(paths.get("2019-02")?.path).toBe(sinMovPath);
    expect(paths.get("2019-03")?.path).toBe(multiPath);
  });
});
