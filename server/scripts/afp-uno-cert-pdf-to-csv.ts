/**
 * Convert AFP UNO “CERTIFICADO DE MOVIMIENTOS” (or legacy cotizaciones) PDF → semicolon CSV in `cfraser/`.
 *
 * Usage:
 *   npm run afp:uno:cert-pdf-to-csv -w nw-tracker-server -- --pdf=/path/Certificado_UNO-15.pdf
 *   npm run afp:uno:cert-pdf-to-csv -w nw-tracker-server -- --pdf=... --out=/path/out.csv
 *
 * Requires **pdftotext** (Poppler).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isAfpUnoMovimientosCertText,
  movimientoRowsToCsv,
  parseAfpUnoCertMovimientosText,
} from "../src/afpUnoCertMovimientosParse.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

function pdfToText(pdfPath: string): string {
  return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 48 * 1024 * 1024,
  });
}

function main(): void {
  const pdf = arg("pdf");
  if (!pdf || !fs.existsSync(pdf)) {
    console.error("Required: --pdf=/path/to/Certificado_UNO-15.pdf (existing file).");
    process.exit(1);
  }
  const body = pdfToText(pdf);
  if (!body.trim()) {
    console.error("Empty pdftotext output.");
    process.exit(1);
  }
  if (!isAfpUnoMovimientosCertText(body)) {
    console.error(
      "This PDF does not look like UNO “CERTIFICADO DE MOVIMIENTOS”. Use the movimientos cuenta PDF (UNO-15+)."
    );
    process.exit(1);
  }
  const rows = parseAfpUnoCertMovimientosText(body);
  if (rows.length === 0) {
    console.error("No movement rows parsed — check pdftotext layout or extend afpUnoCertMovimientosParse.ts.");
    process.exit(1);
  }
  const cfraserDir = resolveCfraserCsvDir();
  const out = path.resolve(arg("out") ?? path.join(cfraserDir, "afp-uno-certificado-cotizaciones.csv"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, movimientoRowsToCsv(rows), "utf8");
  console.log(`Wrote ${rows.length} row(s) → ${out}`);
  const defaultOut = path.resolve(cfraserDir, "afp-uno-certificado-cotizaciones.csv");
  if (path.resolve(out) !== defaultOut) {
    console.log(
      `Note: import:excel loads afp-uno-certificado-cotizaciones.csv from the resolved cfraser dir (${cfraserDir}), not from --out unless you copy the file there.`
    );
  } else {
    console.log(`import:excel will read this file (same cfraser dir: ${cfraserDir}).`);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
