import fs from "node:fs";
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
const APR_2019_PDF = "2019-04-30 cartola cuenta corriente 27.pdf";
const MAY_2021_PDF = "2021-05-31 cartola cuenta corriente 1457.pdf";

describe("checkingCartolaPdfImport", () => {
  it("parses Apr 2019 and May 2021 sample cartola PDFs", () => {
    const pdfDir = resolveCfraserCheckingCartolaPdfsDir();
    if (!fs.existsSync(path.join(pdfDir, APR_2019_PDF))) return;

    const deps = path.join(REPO_ROOT, "server", "scripts", ".pdf_deps");
    execSync(`python3 "${resolveParseCheckingCartolaPdfsScript()}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: deps, CFRASER_CHECKING_CARTOLA_PDFS_DIR: pdfDir },
    });

    const data = loadCheckingCartolasFromPdfJson(resolveCheckingCartolasFromPdfJsonPath());

    const apr2019 = data.cartolas.find((c) => c.source_file === APR_2019_PDF);
    expect(apr2019?.parse_status).toBe("ok");
    expect(apr2019?.period_month).toBe("2019-04");
    expect(apr2019?.period_to).toBe("2019-04-30");
    expect(apr2019?.saldo_final_clp).toBe(677_226);
    expect(apr2019?.movements.length).toBe(19);

    const may2021 = data.cartolas.find((c) => c.source_file === MAY_2021_PDF);
    if (!may2021) return;
    expect(may2021.parse_status).toBe("ok");
    expect(may2021.period_month).toBe("2021-05");
    expect(may2021.period_to).toBe("2021-05-31");
    expect(may2021.saldo_final_clp).toBe(6_695_050);
    expect(may2021.movements.length).toBe(19);

    const entry = may2021;

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
