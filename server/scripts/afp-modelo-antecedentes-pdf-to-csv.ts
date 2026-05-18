/**
 * AFP Modelo antecedentes previsionales PDF → `cfraser/afp-modelo-antecedentes.csv`
 *
 *   npm run afp:modelo:antecedentes-pdf-to-csv -w nw-tracker-server -- --pdf=/path/Certificado-de-antecedentes-previsionales-AFPModelo.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  antecedentesSnapshotToCsv,
  isAfpModeloAntecedentesCertText,
  parseAfpModeloAntecedentesText,
} from "../src/afpModeloAntecedentesParse.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

function main(): void {
  const pdf = arg("pdf");
  if (!pdf || !fs.existsSync(pdf)) {
    console.error("Required: --pdf=/path/to/Certificado-de-antecedentes-previsionales-AFPModelo.pdf");
    process.exit(1);
  }
  const body = execFileSync("pdftotext", ["-layout", pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!isAfpModeloAntecedentesCertText(body)) {
    console.error("PDF does not look like AFP Modelo antecedentes previsionales.");
    process.exit(1);
  }
  const snap = parseAfpModeloAntecedentesText(body);
  if (!snap) {
    console.error("Could not parse obligatoria row — check pdftotext layout.");
    process.exit(1);
  }
  const cfraserDir = resolveCfraserCsvDir();
  const out = path.resolve(arg("out") ?? path.join(cfraserDir, "afp-modelo-antecedentes.csv"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, antecedentesSnapshotToCsv(snap), "utf8");
  console.log(
    `Wrote antecedentes → ${out} (cuotas=${snap.cuotas}, ingreso_sistema=${snap.fechaIngresoSistemaDdMmYyyy ?? "—"})`
  );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
