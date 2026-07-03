import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import type { CheckingCartolaPdfEntry } from "./checkingCartolaPdfImport.js";
import { pdfEntryToParsedCartola } from "./checkingCartolaPdfImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type CuentaVistaCartolaPdfJson = {
  generated_at?: string;
  pdfs_dir?: string;
  cartolas: CheckingCartolaPdfEntry[];
};

export function resolveCuentaVistaCartolasFromPdfJsonPath(): string {
  return path.join(REPO_ROOT, "cfraser", "cuenta-vista-cartolas-from-pdf.json");
}

export function resolveParseCuentaVistaCartolaPdfsScript(): string {
  return path.join(REPO_ROOT, "server", "scripts", "parse-cuenta-vista-cartola-pdfs.py");
}

/** Run Python parser; writes `cfraser/cuenta-vista-cartolas-from-pdf.json`. */
export function runParseCuentaVistaCartolaPdfs(onlyBasenames?: string[]): void {
  const script = resolveParseCuentaVistaCartolaPdfsScript();
  const deps = path.join(REPO_ROOT, "server", "scripts", ".pdf_deps");
  const jsonPath = resolveCuentaVistaCartolasFromPdfJsonPath();
  const args = [script];
  if (onlyBasenames?.length) {
    args.push(`--only=${onlyBasenames.join(",")}`);
  }
  const result = spawnSync("python3", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: deps },
    stdio: "inherit",
  });
  if (result.status === 0) return;
  if (fs.existsSync(jsonPath)) {
    console.warn(
      "Cuenta vista PDF parser exited non-zero; continuing with partial JSON output."
    );
    return;
  }
  const detail = result.error?.message ?? `exit code ${result.status ?? "unknown"}`;
  throw new Error(`parse-cuenta-vista-cartola-pdfs.py failed: ${detail}`);
}

export function loadCuentaVistaCartolasFromPdfJson(
  jsonPath = resolveCuentaVistaCartolasFromPdfJsonPath()
): CuentaVistaCartolaPdfJson {
  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(raw) as CuentaVistaCartolaPdfJson;
}

export function loadParsedCuentaVistaCartolasFromPdfJson(
  jsonPath = resolveCuentaVistaCartolasFromPdfJsonPath()
): ParsedCheckingCartola[] {
  const data = loadCuentaVistaCartolasFromPdfJson(jsonPath);
  const out: ParsedCheckingCartola[] = [];
  for (const entry of data.cartolas) {
    if (entry.parse_status !== "ok") continue;
    out.push(pdfEntryToParsedCartola(entry));
  }
  return out;
}

export function parseAndLoadCuentaVistaCartolasFromPdfs(opts?: {
  pdfsDir?: string;
  skipParse?: boolean;
}): ParsedCheckingCartola[] {
  if (!opts?.skipParse) {
    if (opts?.pdfsDir) {
      process.env.CFRASER_CUENTA_VISTA_PDFS_DIR = opts.pdfsDir;
    }
    runParseCuentaVistaCartolaPdfs();
  }
  return loadParsedCuentaVistaCartolasFromPdfJson();
}
