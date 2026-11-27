import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bankAccountStatementSchema, type BankAccountStatement, type ParsedCartolaPdfEntry } from "nw-tracker-contracts";
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
 * write their result as JSON in `cfraser/`. A cartola that does not parse fails only itself: the
 * parser writes its reason beside the others and exits 0, the readable ones are sent, and the
 * unreadable one is sent as unreadable (the server's import log names it) and reported as a step
 * problem. A parser that exits non-zero did not finish: nothing of that account's PDFs is sent.
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

/** The folder the PDF parser of the account reads (its env override, as the parser reads it). */
export function cartolaPdfDir(account: "checking" | "cuenta-vista"): string {
  return account === "checking"
    ? envDir("CFRASER_CHECKING_CARTOLA_PDFS_DIR", path.join(resolveCfraserDir(), "cartolas-cuenta-corriente"))
    : envDir("CFRASER_CUENTA_VISTA_PDFS_DIR", path.join(resolveCfraserDir(), "cartolas-cuenta-vista"));
}

/** The PDFs a full scan asks the account's parser for: every `*.pdf` in its folder (basenames). */
export function listCartolaPdfs(account: "checking" | "cuenta-vista"): string[] {
  const dir = cartolaPdfDir(account);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
}

/** A parser run: finished (its JSON holds every cartola's status), or the reason it did not. */
export type ParserRun = { ok: true } | { ok: false; error: string };

export type ParserRunner = (script: string, only: readonly string[] | undefined) => ParserRun;

/** Run one of the Python cartola parsers; its stderr is echoed, and its last line names a failure. */
function runPythonParser(script: string, only: readonly string[] | undefined): ParserRun {
  const pythonDir = path.join(resolveRepoRoot(), "ingest", "python");
  const args = [path.join(pythonDir, script)];
  if (only?.length) args.push(`--only=${only.join(",")}`);
  const r = spawnSync("python3", args, {
    cwd: resolveRepoRoot(),
    env: { ...process.env, PYTHONPATH: path.join(pythonDir, ".pdf_deps") },
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
  });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) return { ok: true };
  const last = (r.stderr ?? "").trim().split("\n").pop()?.trim();
  const how = r.error ? r.error.message : r.status === null ? `killed by ${r.signal}` : `exited ${r.status}`;
  return { ok: false, error: `${script} ${how}${last ? `: ${last}` : ""}` };
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
  runParser?: ParserRunner;
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
  if (!opts.skipPdfParse) {
    const run = (opts.runParser ?? runPythonParser)("parse-checking-cartola-pdfs.py", opts.onlyPdf);
    if (!run.ok) {
      out.unreadable.push({ document: "pdf", error: run.error });
      return out;
    }
  }
  collectPdfEntries(readPdfJson(path.join(resolveCfraserDir(), "checking-cartolas-from-pdf.json")), opts.onlyPdf, out);
  return out;
}

/** The cuenta vista's cartolas (PDFs only). */
export function readCuentaVistaCartolas(opts: {
  skipPdfParse: boolean;
  onlyPdf?: readonly string[];
  runParser?: ParserRunner;
}): StatementsRead {
  const out: StatementsRead = { statements: [], unreadable: [] };
  if (opts.onlyPdf != null && opts.onlyPdf.length === 0) return out;
  const json = path.join(resolveCfraserDir(), "cuenta-vista-cartolas-from-pdf.json");
  if (!opts.skipPdfParse) {
    const run = (opts.runParser ?? runPythonParser)("parse-cuenta-vista-cartola-pdfs.py", opts.onlyPdf);
    if (!run.ok) {
      out.unreadable.push({ document: "cuenta-vista-pdf", error: run.error });
      return out;
    }
  }
  collectPdfEntries(readPdfJson(json), opts.onlyPdf, out);
  return out;
}

/**
 * The statements the contract takes, the others unreadable with the field and cell that fail
 * (a cell not in the shared reading, `cartolaText`: an older parser's JSON under
 * `--skip-pdf-parse`, a reader that skipped it): one bad document is named and stays pending,
 * the others are sent.
 */
export function statementsTheContractTakes(read: StatementsRead): StatementsRead {
  const out: StatementsRead = { statements: [], unreadable: [...read.unreadable] };
  for (const s of read.statements) {
    const parsed = bankAccountStatementSchema.safeParse(s);
    if (parsed.success) {
      out.statements.push(parsed.data);
      continue;
    }
    const issue = parsed.error.issues[0]!;
    const at = issue.path.join(".");
    const cell = issue.path.reduce<unknown>((v, k) => (v as Record<string | number, unknown> | undefined)?.[k as string | number], s);
    out.unreadable.push({ document: s.document, error: `${at}${typeof cell === "string" ? ` «${cell}»` : ""}: ${issue.message}` });
  }
  return out;
}
