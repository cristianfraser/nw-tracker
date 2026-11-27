import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BankAccountStatement, ParsedCartolaPdfEntry } from "nw-tracker-contracts";
import { resolveCfraserDir, resolveRepoRoot } from "../paths.js";
import {
  listCheckingCartolaXlsxFiles,
  parseCheckingCartolaFile,
  type CartolaSkippedRow,
  type ParsedCheckingCartola,
} from "./checkingCartolaXlsx.js";

/**
 * Santander's monthly cartolas → `bank_account.statements`: the cuenta corriente's from its xlsx
 * (`cfraser/excels/cuenta corriente/`) and PDFs (`cfraser/cartolas-cuenta-corriente/`), the cuenta
 * vista's from its PDFs (`cfraser/cartolas-cuenta-vista/`). The PDFs are read by the Python parsers
 * (`ingest/python/parse-checking-cartola-pdfs.py`, `parse-cuenta-vista-cartola-pdfs.py`), which
 * write their result as JSON in `cfraser/`; a statement that does not parse is sent as unreadable,
 * so the server's import log names it.
 */

export type StatementsRead = {
  statements: BankAccountStatement[];
  unreadable: { document: string; error: string }[];
};

/**
 * One PDF cartola as the Python parsers write it. `parse_status` `skipped`: the parser left the PDF
 * out on purpose (a cartola of another account). The contract leaves a skipped row's keys open;
 * the parsers write the xlsx reader's `CartolaSkippedRow`.
 */
type CartolaPdfEntry = ParsedCartolaPdfEntry & { skipped?: CartolaSkippedRow[] };

export function statementFromParsedCartola(c: ParsedCheckingCartola): BankAccountStatement {
  return {
    document: c.source_file,
    period_month: c.period_month,
    period_from: c.period_from,
    period_to: c.period_to,
    opening_balance: c.saldo_inicial_clp,
    closing_balance: c.saldo_final_clp,
    month_closing_balances: c.month_saldo_final_clp ?? null,
    movements: c.movements.map((m) => ({
      date: m.occurred_on,
      branch: m.branch,
      description: m.description,
      document_no: m.document_no,
      amount: m.amount_clp,
    })),
    skipped_rows: c.skipped,
    notes: c.notes,
  };
}

function statementFromPdfEntry(e: CartolaPdfEntry): BankAccountStatement {
  if (!e.period_month) throw new Error(e.parse_error ?? `PDF not parsed: ${e.source_file}`);
  return statementFromParsedCartola({
    source_file: e.source_file,
    period_month: e.period_month,
    period_from: e.period_from,
    period_to: e.period_to,
    saldo_inicial_clp: e.saldo_inicial_clp,
    saldo_final_clp: e.saldo_final_clp,
    month_saldo_final_clp: e.month_saldo_final_clp ?? undefined,
    movements: e.movements,
    skipped: e.skipped ?? [],
    notes: [],
  });
}

function envDir(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? path.resolve(v) : fallback;
}

export function checkingCartolaXlsxDir(): string {
  return envDir("CFRASER_CHECKING_CARTOLAS_DIR", path.join(resolveCfraserDir(), "excels", "cuenta corriente"));
}

/** Run one of the Python cartola parsers; true when it exited clean. */
function runPythonParser(script: string, only: readonly string[] | undefined): boolean {
  const pythonDir = path.join(resolveRepoRoot(), "ingest", "python");
  const args = [path.join(pythonDir, script)];
  if (only?.length) args.push(`--only=${only.join(",")}`);
  const r = spawnSync("python3", args, {
    cwd: resolveRepoRoot(),
    env: { ...process.env, PYTHONPATH: path.join(pythonDir, ".pdf_deps") },
    stdio: "inherit",
  });
  return r.status === 0;
}

function readPdfJson(file: string): CartolaPdfEntry[] {
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { cartolas: CartolaPdfEntry[] }).cartolas;
}

function collectPdfEntries(entries: readonly CartolaPdfEntry[], only: readonly string[] | undefined, out: StatementsRead): void {
  const filter = only != null ? new Set(only) : null;
  for (const e of entries) {
    if (filter && !filter.has(e.source_file)) continue;
    if (e.parse_status === "skipped") {
      console.warn(`  skip pdf:${e.source_file}: ${e.parse_error ?? "skipped"}`);
      continue;
    }
    if (e.parse_status !== "ok") {
      out.unreadable.push({ document: e.source_file, error: e.parse_error ?? `PDF ${e.parse_status}` });
      continue;
    }
    try {
      out.statements.push(statementFromPdfEntry(e));
    } catch (err) {
      out.unreadable.push({ document: e.source_file, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * The cuenta corriente's cartolas: the xlsx, then the PDFs (the server imports each account's
 * cartolas oldest month first, whatever the order). `onlyXlsx` / `onlyPdf`: the documents to read
 * of that format — an empty list reads none; absent reads every one.
 */
export function readCheckingCartolas(opts: {
  dir?: string;
  pdf: boolean;
  skipPdfParse: boolean;
  onlyXlsx?: readonly string[];
  onlyPdf?: readonly string[];
}): StatementsRead {
  const out: StatementsRead = { statements: [], unreadable: [] };
  // A list given (even empty) names the documents to read; none given reads every one.
  const xlsxFilter = opts.onlyXlsx != null ? new Set(opts.onlyXlsx) : null;
  for (const file of listCheckingCartolaXlsxFiles(opts.dir ?? checkingCartolaXlsxDir())) {
    const base = path.basename(file);
    if (xlsxFilter && !xlsxFilter.has(base)) continue;
    try {
      out.statements.push(statementFromParsedCartola(parseCheckingCartolaFile(file)));
    } catch (err) {
      out.unreadable.push({ document: base, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!opts.pdf || (opts.onlyPdf != null && opts.onlyPdf.length === 0)) return out;
  if (!opts.skipPdfParse && !runPythonParser("parse-checking-cartola-pdfs.py", opts.onlyPdf)) {
    out.unreadable.push({ document: "pdf", error: "parse-checking-cartola-pdfs.py failed" });
    return out;
  }
  collectPdfEntries(readPdfJson(path.join(resolveCfraserDir(), "checking-cartolas-from-pdf.json")), opts.onlyPdf, out);
  return out;
}

/** The cuenta vista's cartolas (PDFs only). */
export function readCuentaVistaCartolas(opts: { skipPdfParse: boolean; onlyPdf?: readonly string[] }): StatementsRead {
  const out: StatementsRead = { statements: [], unreadable: [] };
  if (opts.onlyPdf != null && opts.onlyPdf.length === 0) return out;
  const json = path.join(resolveCfraserDir(), "cuenta-vista-cartolas-from-pdf.json");
  if (!opts.skipPdfParse && !runPythonParser("parse-cuenta-vista-cartola-pdfs.py", opts.onlyPdf)) {
    // The parser writes what it read before failing; the import takes that, as it always has.
    if (!fs.existsSync(json)) {
      out.unreadable.push({ document: "cuenta-vista-pdf", error: "parse-cuenta-vista-cartola-pdfs.py failed" });
      return out;
    }
    console.warn("Cuenta vista PDF parser exited non-zero; continuing with partial JSON output.");
  }
  collectPdfEntries(readPdfJson(json), opts.onlyPdf, out);
  return out;
}
