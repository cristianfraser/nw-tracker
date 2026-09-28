/**
 * Relabel every stored card line's original currency with the import's own rule
 * (`ccLineOriginCurrency` in `ccOriginCurrency.ts`), in place.
 *
 * The parser used to guess the currency from PAÍS, the merchant's country; the import now labels
 * each line it writes from the amounts and that day's fx. Lines no import rewrites keep the old
 * guess — web-paste lines and statement-JSON lines are never re-parsed, and a statement that is not
 * in the parsed corpus never re-imports — so this applies the same function to what is stored.
 *
 * Order matters for PDF lines. The parser change alters the parsed rows of every international
 * statement, so the next `parse:cc-pdfs` + `import:cc-parsed` re-imports each once, relabeled and
 * with the origin amount as printed: the old reader rounded dollar origins to whole units and
 * shrank grouped amounts a thousandfold («1.xxx,00» stored as 1,xx). A damaged stored value cannot
 * be read back, so run this after that import; a PDF line it would still relabel then belongs to a
 * statement outside the corpus (quarantined under `pending-review/`, or a phantom close an old
 * parse built from a duplicate download — remove those with
 * `remove-cc-duplicate-download-statements.ts`, which re-imports the real statement).
 *
 * `--origins-csv=<parsed CSV>` restores the printed origin of such lines first: a stored PDF line
 * whose (source_pdf, parser row id) the CSV lists takes that row's origin amount before it is
 * relabeled. Produce the CSV by parsing copies of those PDFs on their own, e.g.
 *
 *   mkdir -p /tmp/cc-quarantine && cp cfraser/credit-card-statements/pending-review/*.pdf /tmp/cc-quarantine/
 *   CFRASER_PDFS_DIR=/tmp/cc-quarantine CC_PARSE_OUTPUT_CSV=/tmp/cc-quarantine.csv \
 *     CC_PARSE_CACHE_DIR=/tmp/cc-quarantine-cache npm run parse:cc-pdfs -- --no-reconcile
 *
 * Nothing reads the label or the origin amount, so no balance, cache or valuation depends on them.
 *
 * Report-first: nothing is written without --apply.
 *
 *   npx tsx scripts/relabel-cc-line-origin-currency.ts [--origins-csv=/abs/path.csv] [--apply]
 */
import fs from "node:fs";

import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { ccLineOriginCurrency, parseCcOriginAmount } from "../src/ccOriginCurrency.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { db } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const originsCsv = process.argv.find((a) => a.startsWith("--origins-csv="))?.slice("--origins-csv=".length);

type LineRow = {
  id: number;
  account_id: number;
  source_pdf: string;
  parser_row_id: string | null;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount_orig: number | null;
  amount_usd: number | null;
  orig_currency: string | null;
};

function sourceKind(sourcePdf: string): string {
  if (sourcePdf.startsWith("import:web-paste")) return "web paste";
  if (sourcePdf.startsWith("import:santander-json")) return "statement JSON";
  if (sourcePdf.startsWith("import:")) return "other import";
  return "PDF";
}

/** Printed origin text by `source_pdf \t row_id`, from a CSV the current parser wrote. */
function printedOriginsFromCsv(csvPath: string): Map<string, string> {
  if (!fs.existsSync(csvPath)) throw new Error(`--origins-csv: no such file ${csvPath}`);
  const records = readCommaCsvRecords(csvPath);
  if (records.length === 0) throw new Error(`--origins-csv: ${csvPath} has no rows`);
  const byKey = new Map<string, string>();
  for (const rec of records) {
    if (String(rec.orig_currency ?? "").trim()) {
      throw new Error(
        `--origins-csv: ${csvPath} labels origins (orig_currency "${rec.orig_currency}"), so an ` +
          `older parser wrote it and its amounts are that parser's — parse the PDFs again`
      );
    }
    const rowId = String(rec.row_id ?? "").trim();
    if (!rowId) continue;
    byKey.set(`${String(rec.source_pdf ?? "").trim()}\t${rowId}`, String(rec.amount_orig ?? ""));
  }
  return byKey;
}

const printedOrigins = originsCsv ? printedOriginsFromCsv(originsCsv) : null;

const rows = db
  .prepare(
    `SELECT l.id, s.account_id, s.source_pdf, l.parser_row_id, l.transaction_date, l.posting_date,
            l.merchant, l.amount_orig, l.amount_usd, l.orig_currency
     FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     ORDER BY l.id`
  )
  .all() as LineRow[];

type Change = { line: LineRow; amountOrig: number | null; label: string | null };

const tally = new Map<string, number>();
const changes: Change[] = [];
let amountsRestored = 0;
for (const line of rows) {
  const printed =
    printedOrigins && sourceKind(line.source_pdf) === "PDF" && line.parser_row_id
      ? printedOrigins.get(`${line.source_pdf}\t${line.parser_row_id}`)
      : undefined;
  const amountOrig = printed === undefined ? line.amount_orig : parseCcOriginAmount(printed);
  const label = ccLineOriginCurrency({
    amountOrig,
    amountUsd: line.amount_usd,
    dateIso:
      parseDdMmYyToIso(String(line.transaction_date ?? "")) ??
      parseDdMmYyToIso(String(line.posting_date ?? "")),
  });
  const key = `${sourceKind(line.source_pdf)}\t${line.orig_currency ?? "null"} → ${label ?? "null"}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  if (amountOrig !== line.amount_orig) amountsRestored += 1;
  if (amountOrig !== line.amount_orig || label !== line.orig_currency) {
    changes.push({ line, amountOrig, label });
  }
}

console.log(`${rows.length} card lines; label as stored → by the rule:`);
for (const [key, n] of [...tally].sort()) {
  const [kind, move] = key.split("\t");
  const [from, to] = move!.split(" → ");
  console.log(`  ${kind!.padEnd(14)} ${move!.padEnd(16)} ${String(n).padStart(6)}${from === to ? "" : "  *"}`);
}
if (printedOrigins) {
  console.log(`${amountsRestored} origin amount(s) restored as printed from ${originsCsv}.`);
}
console.log(`${changes.length} line(s) to rewrite (* relabeled, plus any restored amounts).`);
const pdfChanges = changes.filter((c) => sourceKind(c.line.source_pdf) === "PDF");
if (pdfChanges.length > 0) {
  console.log(
    `  ${pdfChanges.length} of them on PDF statements; after parse:cc-pdfs + import:cc-parsed with the ` +
      `new parser, only statements outside the parsed corpus should be left:`
  );
  const byStatement = new Map<string, number>();
  for (const { line } of pdfChanges) {
    const k = `account ${line.account_id} · ${line.source_pdf}`;
    byStatement.set(k, (byStatement.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byStatement].sort()) console.log(`    ${k}: ${n}`);
}

if (!APPLY) {
  console.log("\nReport only — re-run with --apply to write.");
  process.exit(0);
}

const update = db.prepare(`UPDATE cc_statement_lines SET amount_orig = ?, orig_currency = ? WHERE id = ?`);
const written = db
  .transaction(() => {
    let n = 0;
    for (const { line, amountOrig, label } of changes) n += update.run(amountOrig, label, line.id).changes;
    return n;
  })
  .immediate();
console.log(`Rewrote ${written} line(s).`);
