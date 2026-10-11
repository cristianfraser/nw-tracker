/**
 * The mortgage sheet — a table in the user's personal Numbers file, read in place — as a
 * `mortgage.sheet_payments` payload. The reading itself is Python (`python/read-mortgage-sheet.py`
 * on numbers-parser, which tells typed cells from formulas); this module runs it, checks what it
 * wrote against the contract and sends it.
 *
 * Config (gitignored, personal): `cfraser/mortgage-sheet.json`
 *   { "file": "~/Library/…/cfraser.numbers", "sheet": "depto", "table": "dividendos" }
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mortgageSheetPaymentsKind, type MortgageSheetPaymentsPayload } from "nw-tracker-contracts";
import { resolveCfraserDir, resolveRepoRoot } from "../paths.js";

export type MortgageSheetAcceptedDifference = { label: string; field: string; reason: string };

export type MortgageSheetConfig = {
  file: string;
  sheet: string;
  table: string;
  /** Differences between the sheet and the ledger the user has declared (reported, never a conflict). */
  accepted_differences: MortgageSheetAcceptedDifference[];
};

export function resolveMortgageSheetConfigPath(): string {
  return path.join(resolveCfraserDir(), "mortgage-sheet.json");
}

/** Null when the config does not exist (a clone, CI): the step then has nothing to read. */
export function loadMortgageSheetConfig(file: string = resolveMortgageSheetConfigPath()): MortgageSheetConfig | null {
  if (!fs.existsSync(file)) return null;
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} must contain a JSON object`);
  const cfg = raw as Partial<MortgageSheetConfig>;
  for (const k of ["file", "sheet", "table"] as const) {
    if (typeof cfg[k] !== "string" || !cfg[k]!.trim()) throw new Error(`${file}: "${k}" is required`);
  }
  const sheetFile = cfg.file!.trim();
  const accepted = (cfg.accepted_differences ?? []) as unknown[];
  if (!Array.isArray(accepted)) throw new Error(`${file}: "accepted_differences" must be a list`);
  for (const a of accepted) {
    const x = a as Partial<MortgageSheetAcceptedDifference>;
    for (const k of ["label", "field", "reason"] as const) {
      if (typeof x[k] !== "string" || !x[k]!.trim()) throw new Error(`${file}: each accepted difference needs "${k}"`);
    }
  }
  return {
    file: sheetFile.startsWith("~/") ? path.join(os.homedir(), sheetFile.slice(2)) : sheetFile,
    sheet: cfg.sheet!.trim(),
    table: cfg.table!.trim(),
    accepted_differences: accepted as MortgageSheetAcceptedDifference[],
  };
}

/** What `read-mortgage-sheet.py` writes. */
export type MortgageSheetRead = {
  document: { path: string; name: string; sha256: string; size: number; modified_at: string };
  sheet: string;
  table: string;
  rows: MortgageSheetPaymentsPayload["rows"];
  projected: string[];
};

export function readMortgageSheet(cfg: MortgageSheetConfig): MortgageSheetRead {
  if (!fs.existsSync(cfg.file)) throw new Error(`mortgage sheet not found: ${cfg.file}`);
  const pythonDir = path.join(resolveRepoRoot(), "ingest", "python");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-mortgage-sheet-")), "rows.json");
  const r = spawnSync(
    "python3",
    [path.join(pythonDir, "read-mortgage-sheet.py"), `--file=${cfg.file}`, `--sheet=${cfg.sheet}`, `--table=${cfg.table}`, `--out=${out}`],
    { encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(pythonDir, ".numbers_deps") }, maxBuffer: 16 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").split("\n").filter((l) => l && !/Warning/.test(l)).slice(-5).join("\n");
    throw new Error(`read-mortgage-sheet.py failed (exit ${r.status}): ${stderr || r.stdout}`);
  }
  const read = JSON.parse(fs.readFileSync(out, "utf8")) as MortgageSheetRead;
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return read;
}

/** The contract-checked payload; a row the reader got wrong fails here, before anything is sent. */
export function mortgageSheetPayload(
  read: MortgageSheetRead,
  apply: boolean,
  accepted: MortgageSheetAcceptedDifference[] = []
): MortgageSheetPaymentsPayload {
  const { path: _path, ...document } = read.document;
  return mortgageSheetPaymentsKind.payload.parse({
    apply,
    document,
    sheet: read.sheet,
    table: read.table,
    rows: read.rows,
    projected: read.projected,
    accepted,
  });
}
