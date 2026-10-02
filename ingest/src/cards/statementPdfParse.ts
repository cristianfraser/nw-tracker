import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cardParsedStatementsKind, type FeederParseResult } from "nw-tracker-contracts";
import { resolveRepoRoot } from "../paths.js";
import { parsedStatementsPayload, readParsedStatementsCsv } from "./parsedStatements.js";

/** Parsing a scanned statement runs OCR; well within the server's wait for this format. */
const PARSE_TIMEOUT_MS = 140_000;

/**
 * One uploaded card statement PDF → `card.parsed_statements` (`POST /parse/card_statement.pdf`):
 * the card statement parser (`ingest/python/parse-cc-statement-pdfs.py`) run on a directory
 * holding only this file, its merged CSV read as the import reads it. The parser's per-PDF cache
 * is the corpus's own (keyed by the PDF's bytes), so a statement already in the corpus parses
 * from cache. A parse that fails or reads no line is `unreadable`.
 */
export async function parseCardStatementPdf(content: Buffer, filename: string): Promise<FeederParseResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cc-pdf-"));
  try {
    const name = path.basename(filename).toLowerCase().endsWith(".pdf") ? path.basename(filename) : `${path.basename(filename)}.pdf`;
    fs.writeFileSync(path.join(dir, name), content);
    const outCsv = path.join(dir, "parsed.csv");
    const pythonDir = path.join(resolveRepoRoot(), "ingest", "python");
    const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn("python3", [path.join(pythonDir, "parse-cc-statement-pdfs.py")], {
        cwd: resolveRepoRoot(),
        env: { ...process.env, PYTHONPATH: path.join(pythonDir, ".pdf_deps"), CFRASER_PDFS_DIR: dir, CC_PARSE_OUTPUT_CSV: outCsv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: string[] = [];
      child.stdout.on("data", (b: Buffer) => chunks.push(b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => chunks.push(b.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGTERM"), PARSE_TIMEOUT_MS);
      child.on("error", (err) => chunks.push(err.message));
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode ?? 1, output: chunks.join("") });
      });
    });
    if (code !== 0) throw new Error(output.trim().split("\n").slice(-5).join("\n") || `the parser exited ${code}`);
    const csv = readParsedStatementsCsv(outCsv);
    if (!csv) throw new Error("the parser read no statement line from this PDF");
    return {
      kind: cardParsedStatementsKind.kind,
      schema_version: cardParsedStatementsKind.schema_version,
      payload: parsedStatementsPayload(csv, { apply: true, full: false }),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
