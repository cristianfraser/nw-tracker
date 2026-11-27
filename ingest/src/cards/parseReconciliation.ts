import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";

/**
 * The card statement parser's reconciliation (`cc-statements-parse-reconciliation.jsonl`, one
 * JSON object per statement, written by `ingest/python/cc_statement_reconcile.py`): a statement
 * whose parsed lines do not add up to the figures it prints is `withheld` — left out of the
 * parsed CSV, so the import never sees it and its rows on file stay as they are. So is one the
 * reconcile raised on (`error`: a row with no parser layout, an amount it cannot read).
 */
type ReconcileCheck = { code: string; ok: boolean; expected: number | null; actual: number | null; delta: number | null };
type ReconcileEntry = { source_pdf: string; currency: string; withheld?: boolean; checks?: ReconcileCheck[]; error?: string };

/** The corpus run's reconciliation file, or the one beside a side run's output CSV. */
export function parseReconciliationPath(outputCsv?: string): string {
  if (outputCsv) return path.join(path.dirname(outputCsv), `${path.basename(outputCsv, path.extname(outputCsv))}.reconciliation.jsonl`);
  return path.join(resolveCfraserDir(), "cc-statements-parse-reconciliation.jsonl");
}

function amount(n: number | null | undefined): string {
  return n == null ? "—" : String(Math.round(n * 100) / 100);
}

/**
 * One problem line per withheld statement: the statement and, for each failed check, the printed
 * figure, the parsed sum and the difference. No file (a run without reconcile) reads as none.
 */
export function withheldStatementProblems(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as ReconcileEntry;
    if (!entry.withheld) continue;
    if (entry.error) {
      out.push(
        `${entry.source_pdf} (${entry.currency.toUpperCase()}) withheld — its reconcile failed: ${entry.error}. ` +
          `Its rows on file are untouched; fix the parse (or quarantine the PDF).`
      );
      continue;
    }
    const failed = (entry.checks ?? []).filter((c) => !c.ok);
    const figures = failed
      .map((c) => `${c.code}: printed ${amount(c.expected)}, parsed ${amount(c.actual)}, difference ${amount(c.delta)}`)
      .join("; ");
    out.push(
      `${entry.source_pdf} (${entry.currency.toUpperCase()}) withheld — its parsed lines do not add up to what it prints` +
        `${figures ? `: ${figures}` : ""}. Its rows on file are untouched; fix the parse (or quarantine the PDF).`
    );
  }
  return out;
}
