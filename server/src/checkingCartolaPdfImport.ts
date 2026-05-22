import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  CartolaSkippedRow,
  ParsedCheckingCartola,
  ParsedCheckingMovement,
} from "./checkingCartolaParse.js";
import { resolveCfraserCheckingCartolaPdfsDir } from "./cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type CheckingCartolaPdfJson = {
  generated_at?: string;
  pdfs_dir?: string;
  cartolas: CheckingCartolaPdfEntry[];
};

export type CheckingCartolaPdfEntry = {
  source_file: string;
  period_month: string;
  period_from: string | null;
  period_to: string | null;
  saldo_inicial_clp: number | null;
  saldo_final_clp: number | null;
  movements: ParsedCheckingMovement[];
  skipped?: CartolaSkippedRow[];
  parse_status: "ok" | "unreadable" | "error";
  parse_error?: string | null;
  extractor?: string;
};

export function resolveCheckingCartolasFromPdfJsonPath(): string {
  return path.join(REPO_ROOT, "cfraser", "checking-cartolas-from-pdf.json");
}

export function resolveParseCheckingCartolaPdfsScript(): string {
  return path.join(REPO_ROOT, "server", "scripts", "parse-checking-cartola-pdfs.py");
}

/** Run Python parser; writes `cfraser/checking-cartolas-from-pdf.json`. */
export function runParseCheckingCartolaPdfs(): void {
  const script = resolveParseCheckingCartolaPdfsScript();
  const deps = path.join(REPO_ROOT, "server", "scripts", ".pdf_deps");
  const env = { ...process.env, PYTHONPATH: deps };
  execSync(`python3 "${script}"`, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
}

export function loadCheckingCartolasFromPdfJson(
  jsonPath = resolveCheckingCartolasFromPdfJsonPath()
): CheckingCartolaPdfJson {
  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(raw) as CheckingCartolaPdfJson;
}

export function pdfEntryToParsedCartola(entry: CheckingCartolaPdfEntry): ParsedCheckingCartola {
  if (entry.parse_status !== "ok" || !entry.period_month) {
    throw new Error(entry.parse_error ?? `PDF not parsed: ${entry.source_file}`);
  }
  return {
    source_file: entry.source_file,
    period_month: entry.period_month,
    period_from: entry.period_from,
    period_to: entry.period_to,
    saldo_inicial_clp: entry.saldo_inicial_clp,
    saldo_final_clp: entry.saldo_final_clp,
    movements: entry.movements,
    skipped: entry.skipped ?? [],
    notes: [],
  };
}

export function listCheckingCartolaPdfFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadParsedCheckingCartolasFromPdfJson(
  jsonPath = resolveCheckingCartolasFromPdfJsonPath()
): ParsedCheckingCartola[] {
  const data = loadCheckingCartolasFromPdfJson(jsonPath);
  const out: ParsedCheckingCartola[] = [];
  for (const entry of data.cartolas) {
    if (entry.parse_status !== "ok") continue;
    out.push(pdfEntryToParsedCartola(entry));
  }
  return out;
}

export function parseAndLoadCheckingCartolasFromPdfs(opts?: {
  pdfsDir?: string;
  skipParse?: boolean;
}): ParsedCheckingCartola[] {
  if (!opts?.skipParse) {
    if (opts?.pdfsDir) {
      process.env.CFRASER_CHECKING_CARTOLA_PDFS_DIR = opts.pdfsDir;
    }
    runParseCheckingCartolaPdfs();
  }
  return loadParsedCheckingCartolasFromPdfJson();
}

export function resolveCfraserCheckingCartolaPdfsDirForImport(): string {
  return resolveCfraserCheckingCartolaPdfsDir();
}
