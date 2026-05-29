/**
 * Inbox hook: `cfraser/pdfs/certificado_de_transacciones.pdf` → CSV + archive PDF.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  fintualCertificadoPdfRowsToCsv,
  isFintualCertificadoTransaccionesText,
  parseFintualCertificadoPdfText,
} from "./fintualCertificadoPdfParse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export function fintualCertificadoArchiveDir(cfraserDir: string): string {
  return path.join(cfraserDir, "fintual-certificado");
}

export function findFintualCertificadoInboxPdf(cfraserDir: string): string | null {
  const inbox = path.join(cfraserDir, "pdfs");
  if (!fs.existsSync(inbox)) return null;
  const exact = path.join(inbox, "certificado_de_transacciones.pdf");
  if (fs.existsSync(exact)) return exact;
  for (const name of fs.readdirSync(inbox)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const lower = name.toLowerCase();
    if (lower.includes("certificado") && lower.includes("transacciones")) {
      return path.join(inbox, name);
    }
  }
  return null;
}

function pdfToText(pdfPath: string): string {
  return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 48 * 1024 * 1024,
  });
}

export type ProcessFintualCertificadoInboxResult = {
  pdfPath: string | null;
  csvPath: string | null;
  rows: number;
  archivedTo: string | null;
};

/** Convert inbox certificado PDF to `cfraser/fintual-certificado-de-transacciones.csv`. */
export function processFintualCertificadoInboxPdf(opts?: {
  cfraserDir?: string;
  dryRun?: boolean;
}): ProcessFintualCertificadoInboxResult {
  const cfraserDir = opts?.cfraserDir ?? resolveCfraserCsvDir();
  const dryRun = opts?.dryRun ?? false;
  const pdfPath = findFintualCertificadoInboxPdf(cfraserDir);
  if (!pdfPath) {
    return { pdfPath: null, csvPath: null, rows: 0, archivedTo: null };
  }

  const body = pdfToText(pdfPath);
  if (!isFintualCertificadoTransaccionesText(body)) {
    throw new Error(`Inbox PDF is not a Fintual certificado de transacciones: ${pdfPath}`);
  }
  const parsed = parseFintualCertificadoPdfText(body);
  if (parsed.length === 0) {
    throw new Error(`No rows parsed from Fintual certificado PDF: ${pdfPath}`);
  }

  const csvPath = path.join(cfraserDir, "fintual-certificado-de-transacciones.csv");
  if (!dryRun) {
    fs.writeFileSync(csvPath, fintualCertificadoPdfRowsToCsv(parsed), "utf8");
  }

  const archiveDir = fintualCertificadoArchiveDir(cfraserDir);
  const archivedTo = path.join(archiveDir, path.basename(pdfPath));
  if (!dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
    if (fs.existsSync(archivedTo)) fs.unlinkSync(archivedTo);
    fs.renameSync(pdfPath, archivedTo);
  }

  return { pdfPath, csvPath, rows: parsed.length, archivedTo: dryRun ? null : archivedTo };
}

export function repoRootFromServerSrc(): string {
  return REPO_ROOT;
}
