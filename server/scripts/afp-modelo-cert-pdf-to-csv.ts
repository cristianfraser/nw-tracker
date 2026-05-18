/**
 * AFP Modelo “CERTIFICADO COTIZACIONES” PDF → semicolon CSV in `cfraser/`.
 *
 *   npm run afp:modelo:cert-pdf-to-csv -w nw-tracker-server -- --pdf=/path/Certificado-de-cotizaciones-AFPModelo.pdf
 *
 * Requires **pdftotext** (Poppler). Then keep `cfraser/afp-modelo-certificado-cotizaciones.csv` next to other CSVs;
 * `import:excel` will read it and insert a prior-AFP cuotas adjustment vs the UNO movimientos cert.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isAfpModeloCotizacionesCertText,
  modeloCotizacionesRowsToCsv,
  parseAfpModeloCotizacionesPdfText,
} from "../src/afpModeloCotizacionesParse.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

function main(): void {
  const pdf = arg("pdf");
  if (!pdf || !fs.existsSync(pdf)) {
    console.error("Required: --pdf=/path/to/Certificado-de-cotizaciones-AFPModelo.pdf");
    process.exit(1);
  }
  const body = execFileSync("pdftotext", ["-layout", pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!body.trim()) {
    console.error("Empty pdftotext output.");
    process.exit(1);
  }
  if (!isAfpModeloCotizacionesCertText(body)) {
    console.error("PDF does not look like AFP Modelo CERTIFICADO COTIZACIONES.");
    process.exit(1);
  }
  const rows = parseAfpModeloCotizacionesPdfText(body);
  if (rows.length === 0) {
    console.error("No cotización rows parsed — extend afpModeloCotizacionesParse.ts if layout changed.");
    process.exit(1);
  }
  const cfraserDir = resolveCfraserCsvDir();
  const out = path.resolve(arg("out") ?? path.join(cfraserDir, "afp-modelo-certificado-cotizaciones.csv"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, modeloCotizacionesRowsToCsv(rows), "utf8");
  console.log(`Wrote ${rows.length} row(s) → ${out}`);
  console.log(`Run import:excel so the Modelo vs UNO cuotas gap is applied (see log: afp-modelo-prior-cuotas).`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
