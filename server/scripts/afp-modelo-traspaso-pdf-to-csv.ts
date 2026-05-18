/**
 * AFP Modelo comprobante traspaso PDF → `cfraser/afp-modelo-traspaso.csv`
 *
 *   npm run afp:modelo:traspaso-pdf-to-csv -w nw-tracker-server -- --pdf=/path/Comprobante-Traspaso-Web-AFPModelo.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isAfpModeloTraspasoCertText,
  parseAfpModeloTraspasoText,
  traspasoRecordToCsv,
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
    console.error("Required: --pdf=/path/to/Comprobante-Traspaso-Web-AFPModelo.pdf");
    process.exit(1);
  }
  const body = execFileSync("pdftotext", ["-layout", pdf, "-"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!isAfpModeloTraspasoCertText(body)) {
    console.error("PDF does not look like AFP Modelo comprobante de traspaso.");
    process.exit(1);
  }
  const rec = parseAfpModeloTraspasoText(body);
  if (!rec) {
    console.error("Could not parse traspaso row.");
    process.exit(1);
  }
  const cfraserDir = resolveCfraserCsvDir();
  const out = path.resolve(arg("out") ?? path.join(cfraserDir, "afp-modelo-traspaso.csv"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, traspasoRecordToCsv(rec), "utf8");
  console.log(`Wrote traspaso → ${out} (${rec.afpOrigen} → Modelo, materialización ${rec.materializacionDdMmYyyy ?? "—"})`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
