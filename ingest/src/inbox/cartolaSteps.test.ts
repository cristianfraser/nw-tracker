import { describe, expect, it } from "vitest";
import { checkingCartolaStepArgs, cuentaVistaCartolaStepArgs, deferStepFailure } from "./cartolaSteps.js";

const base = { force: false, skipCheckingPdf: false, skipPdfParse: false, dryRun: false, xlsxFiled: [], pdfFiled: [], pending: [] };

describe("the inbox pipeline's cartola steps", () => {
  it("a PDF arriving alone sends that PDF and no xlsx (an empty list is none)", () => {
    expect(checkingCartolaStepArgs({ ...base, pdfFiled: ["2026-10-30 cartola.pdf"] })).toEqual([
      "run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--", "--only-xlsx=", "--only-pdf=2026-10-30 cartola.pdf",
    ]);
  });

  it("pending cartolas are sent again with the run's own, each by its format, and alone when nothing was filed", () => {
    expect(checkingCartolaStepArgs({ ...base, xlsxFiled: ["Octubre 2026.xlsx"], pending: ["2026-09-30 cartola.pdf", "Agosto 2026.xlsx"] })).toEqual([
      "run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--", "--only-xlsx=Octubre 2026.xlsx,Agosto 2026.xlsx", "--only-pdf=2026-09-30 cartola.pdf",
    ]);
    expect(checkingCartolaStepArgs({ ...base, pending: ["Agosto 2026.xlsx"] })).toEqual([
      "run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--", "--only-xlsx=Agosto 2026.xlsx", "--xlsx-only",
    ]);
    expect(cuentaVistaCartolaStepArgs({ force: false, skipPdfParse: false, dryRun: false, pdfFiled: [], pending: ["vista 84.pdf"] })).toEqual([
      "run", "import:cuenta-vista-cartolas", "-w", "nw-tracker-ingest", "--", "--only-pdf=vista 84.pdf",
    ]);
  });

  it("nothing filed and nothing pending runs no step; --checking scans everything", () => {
    expect(checkingCartolaStepArgs(base)).toBeNull();
    expect(cuentaVistaCartolaStepArgs({ force: false, skipPdfParse: false, dryRun: false, pdfFiled: [], pending: [] })).toBeNull();
    expect(checkingCartolaStepArgs({ ...base, force: true })).toEqual(["run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--"]);
  });

  it("a failing cartola step is deferred: the first failure is kept for the end", () => {
    let deferred = 0;
    deferred = deferStepFailure(deferred, 1);
    deferred = deferStepFailure(deferred, 0);
    deferred = deferStepFailure(deferred, 2);
    expect(deferred).toBe(1);
  });
});

describe("the checking cartola reader's lists", () => {
  it("an empty xlsx list reads no xlsx; no list reads every one", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { readCheckingCartolas } = await import("../santander/cartolas.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-xlsx-"));
    fs.writeFileSync(path.join(dir, "cartola cuenta corriente 2026-10.xlsx"), "not a workbook");
    expect(readCheckingCartolas({ dir, pdf: false, skipPdfParse: true, onlyXlsx: [] })).toEqual({ statements: [], unreadable: [] });
    expect(readCheckingCartolas({ dir, pdf: false, skipPdfParse: true }).unreadable.map((u) => u.document)).toEqual(["cartola cuenta corriente 2026-10.xlsx"]);
  });
});
