/**
 * Convert Fintual “certificado de transacciones” PDF → comma CSV in `cfraser/`.
 *
 * Usage:
 *   npm run fintual:cert-pdf-to-csv -w nw-tracker-server -- --pdf=/path/certificado_de_transacciones.pdf
 *
 * Requires **pdftotext** (Poppler).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  fintualCertificadoPdfRowsToCsv,
  isFintualCertificadoTransaccionesText,
  parseFintualCertificadoPdfText,
} from "../src/fintualCertificadoPdfParse.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    console.error("Required: --pdf=/path/to/certificado_de_transacciones.pdf (existing file).");
    process.exit(1);
  }
  const body = pdfToText(pdf);
  if (!body.trim()) {
    console.error("Empty pdftotext output.");
    process.exit(1);
  }
  if (!isFintualCertificadoTransaccionesText(body)) {
    console.error("This PDF does not look like a Fintual certificado de transacciones.");
    process.exit(1);
  }
  const rows = parseFintualCertificadoPdfText(body);
  if (rows.length === 0) {
    console.error("No movement rows parsed — check pdftotext layout or extend fintualCertificadoPdfParse.ts.");
    process.exit(1);
  }
  const cfraserDir = resolveCfraserCsvDir();
  const out = path.resolve(
    arg("out") ?? path.join(cfraserDir, "fintual-certificado-de-transacciones.csv")
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, fintualCertificadoPdfRowsToCsv(rows), "utf8");
  console.log(`Wrote ${rows.length} row(s) → ${out}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
