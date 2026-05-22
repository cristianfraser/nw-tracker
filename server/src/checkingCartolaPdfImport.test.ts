import path from "node:path";
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { cartolaMovementDedupeKey } from "./checkingCartolaParse.js";
import {
  loadCheckingCartolasFromPdfJson,
  resolveCheckingCartolasFromPdfJsonPath,
  resolveParseCheckingCartolaPdfsScript,
} from "./checkingCartolaPdfImport.js";
import { resolveCfraserCheckingCartolaPdfsDir } from "./cfraserPaths.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SAMPLE_PDF = "1_1457_REDACTED_30042019_CC.pdf";

describe("checkingCartolaPdfImport", () => {
  it("parses May 2021 sample cartola PDF", () => {
    const pdfDir = resolveCfraserCheckingCartolaPdfsDir();
    const sample = path.join(pdfDir, SAMPLE_PDF);
    const deps = path.join(REPO_ROOT, "server", "scripts", ".pdf_deps");
    execSync(`python3 "${resolveParseCheckingCartolaPdfsScript()}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: deps, CFRASER_CHECKING_CARTOLA_PDFS_DIR: pdfDir },
    });

    const data = loadCheckingCartolasFromPdfJson(resolveCheckingCartolasFromPdfJsonPath());
    const entry = data.cartolas.find((c) => c.source_file === SAMPLE_PDF);
    expect(entry).toBeDefined();
    expect(entry?.parse_status).toBe("ok");
    expect(entry?.period_month).toBe("2021-05");
    expect(entry?.period_to).toBe("2021-05-31");
    expect(entry?.saldo_final_clp).toBe(6_695_050);
    expect(entry?.movements.length).toBe(19);

    const fintualLike = entry?.movements.find((m) =>
      m.description.includes("TESORERIA")
    );
    expect(fintualLike?.amount_clp).toBe(320_365);
    expect(fintualLike?.occurred_on).toBe("2021-05-12");

    const cargo = entry?.movements.find((m) => m.description.includes("T. Crédito"));
    expect(cargo?.amount_clp).toBe(-681_191);

    const dupes = new Set((entry?.movements ?? []).map((m) => cartolaMovementDedupeKey(m)));
    expect(dupes.size).toBe(entry?.movements.length);

    const ocrApril = data.cartolas.find((c) => c.source_file.includes("334249"));
    expect(ocrApril?.parse_status).toBe("ok");
    expect(ocrApril?.period_month).toBe("2020-04");
    expect(ocrApril?.movements.length).toBe(2);
  });
});
