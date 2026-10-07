/**
 * Stores the billed amount a statement printed when it is zero or negative. The import kept only a
 * positive «Monto total facturado a pagar» until 2026-10-07, so a period that ended in credit
 * (·0161: −2xx.xxx on 2018-06-25, six dollar statements) or billed nothing read as «no header»,
 * and the month-end anchor fell back to the lines and left the credit out. The parsed corpus
 * (`cfraser/cc-statements-parsed-all.csv`) has the printed values; this writes them onto the rows
 * still holding NULL. Report-first, `--apply` to write; then re-stamp the anchors
 * (`restamp-cc-anchor-frame.ts`).
 *
 *   npx tsx scripts/backfill-cc-printed-facturado.ts [--apply]
 */
import path from "node:path";
import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { currencyFromRow } from "../src/ccStatementsImport.js";
import { parseOptionalChileanInteger, parseChileanNumber } from "../src/chileanNumber.js";

const apply = process.argv.includes("--apply");
const csvPath = path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

/** The CSV prints dollars «-392,00» and pesos «-256727» (both Chilean). */
function printed(currency: string, cell: string): number {
  return currency === "usd" ? parseChileanNumber(cell) : parseOptionalChileanInteger(cell)!;
}

const want = new Map<string, { source_pdf: string; statement_date: string; currency: string; value: number }>();
for (const r of readCommaCsvRecords(csvPath)) {
  const cell = String(r.statement_monto_facturado ?? "").trim();
  if (!cell) continue;
  const currency = currencyFromRow(r as never);
  const value = printed(currency, cell);
  if (value > 0) continue;
  const key = `${r.source_pdf}|${r.statement_date}|${currency}`;
  const had = want.get(key);
  if (had && had.value !== value) throw new Error(`${key}: rows print ${had.value} and ${value}`);
  want.set(key, { source_pdf: r.source_pdf!, statement_date: r.statement_date!, currency, value });
}

const find = db.prepare(
  `SELECT id, account_id, monto_facturado FROM cc_statements WHERE source_pdf = ? AND statement_date = ? AND currency = ?`
);
const set = db.prepare(`UPDATE cc_statements SET monto_facturado = ? WHERE id = ?`);
let n = 0;
db.transaction(() => {
  for (const w of want.values()) {
    const rows = find.all(w.source_pdf, w.statement_date, w.currency) as { id: number; account_id: number; monto_facturado: number | null }[];
    if (rows.length === 0) {
      console.log(`  not stored: ${w.statement_date} ${w.currency} ${w.source_pdf}`);
      continue;
    }
    for (const r of rows) {
      if (r.monto_facturado === w.value) continue;
      if (r.monto_facturado != null) throw new Error(`statement ${r.id} stores ${r.monto_facturado}, the PDF prints ${w.value}`);
      console.log(`  statement ${r.id} (account ${r.account_id}) ${w.statement_date} ${w.currency}: NULL → ${w.value}`);
      if (apply) set.run(w.value, r.id);
      n++;
    }
  }
})();
console.log(apply ? `applied: ${n} statement(s)` : `report only: ${n} statement(s) (--apply to write)`);
