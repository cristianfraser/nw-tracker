/**
 * One-time cleanup: international (USD) statement lines taken from a broken pdftotext rendering.
 *
 * The raw rendering loses the table rows at page breaks and section headers, and the parser used
 * to build a row from whatever cells a date's chunk held: a payment's unsigned origin cell read as
 * a positive US$, another line's US$, the page number. A two-letter city was also read as the
 * country in the layout rendering, which took the origin as the US$. The parser now refuses those
 * rows (`_parse_international_vertical_chunk`, `_parse_intl_layout_table_line` in
 * `parse-cc-statement-pdfs.py`), and a statement whose parse changed re-imports with its lines
 * replaced. This script removes the stored ones now, including those on statements parked in
 * `credit-card-statements/pending-review/`, which never re-import.
 *
 * Every printed line of an international statement carries both amounts (MONTO MONEDA ORIGEN,
 * MONTO US$); purchases are positive, payments and credit notes negative. A stored line that
 * breaks one of those is not on the statement:
 *   - `garbled`: the merchant carries the page counter («… DE 2») or a section heading — the rows
 *     both reconcilers already skip (`isGarbledUsdStatementMerchant`);
 *   - `positive_payment`: an «ABONO DE DIVISAS» or «NOTA DE CREDITO» with a positive US$;
 *   - `no_origin_amount`: the origin column read into another cell;
 *   - `negative_purchase`: a purchase merchant with a negative US$ (another line's payment).
 * PDF statements only: the Santander statement JSON and the web-paste buckets carry no rendering.
 *
 * Report by default. `--apply` deletes them through the supported evidence path: the earliest
 * affected transaction date is read BEFORE deleting, then valuations (stamp purge + re-walk from
 * that date) and billing balances are recomputed per account.
 *
 *   npx tsx scripts/remove-cc-intl-extraction-artifacts.ts            # report only
 *   npx tsx scripts/remove-cc-intl-extraction-artifacts.ts --apply
 */
import { db } from "../src/db.js";
import {
  deleteStatementLinesByIds,
  earliestTransactionDateForLineIds,
} from "../src/ccCrossImportDedupe.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { isCcPaymentMerchant, isCcUsdDebtAbonoMerchant } from "../src/ccPaymentLines.js";
import { isGarbledUsdStatementMerchant } from "../src/ccStatementSection3.js";
import { RE_USD_SECTION3 } from "../src/ccStatementLineRules.js";

const apply = process.argv.includes("--apply");

type ArtifactRule = "garbled" | "positive_payment" | "no_origin_amount" | "negative_purchase";

type LineRow = {
  id: number;
  account_id: number;
  statement_id: number;
  source_pdf: string;
  statement_date: string;
  transaction_date: string | null;
  merchant: string | null;
  country: string | null;
  amount_orig: number | null;
  orig_currency: string | null;
  amount_usd: number | null;
};

const RE_CREDIT_NOTE = /\bNOTA\s+DE\s+CREDITO\b/i;

function artifactRule(line: LineRow): ArtifactRule | null {
  const merchant = String(line.merchant ?? "");
  const usd = line.amount_usd ?? 0;
  if (isGarbledUsdStatementMerchant(merchant)) return "garbled";
  if ((isCcUsdDebtAbonoMerchant(merchant) || RE_CREDIT_NOTE.test(merchant)) && usd > 0) {
    return "positive_payment";
  }
  if (line.amount_orig == null) return "no_origin_amount";
  if (usd < 0 && !isCcPaymentMerchant(merchant) && !RE_USD_SECTION3.test(merchant)) {
    return "negative_purchase";
  }
  return null;
}

const rows = db
  .prepare(
    `SELECT l.id, s.account_id, s.id AS statement_id, s.source_pdf, s.statement_date,
            l.transaction_date, l.merchant, l.country, l.amount_orig, l.orig_currency, l.amount_usd
     FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     WHERE s.currency = 'usd' AND s.source_pdf NOT LIKE 'import:%'
     ORDER BY s.account_id, s.id, l.id`
  )
  .all() as LineRow[];

const matches = rows
  .map((r) => ({ line: r, rule: artifactRule(r) }))
  .filter((m): m is { line: LineRow; rule: ArtifactRule } => m.rule != null);

if (matches.length === 0) {
  console.log(`No extraction artifacts among ${rows.length} international statement lines.`);
  process.exit(0);
}

const byAccount = new Map<number, typeof matches>();
for (const m of matches) {
  const list = byAccount.get(m.line.account_id) ?? [];
  list.push(m);
  byAccount.set(m.line.account_id, list);
}

for (const [accountId, list] of byAccount) {
  const sumUsd = list.reduce((s, m) => s + (m.line.amount_usd ?? 0), 0);
  console.log(`account ${accountId}: ${list.length} lines, net US$ ${sumUsd.toFixed(2)}`);
  for (const { line, rule } of list) {
    console.log(
      `  [${rule}] line ${line.id}  ${line.transaction_date ?? "?"}  ${line.merchant}  ` +
        `${line.country ?? ""}  usd=${line.amount_usd ?? ""} orig=${line.amount_orig ?? ""} ` +
        `${line.orig_currency ?? ""}  (statement ${line.statement_id}, ${line.statement_date})`
    );
  }
}
console.log(`TOTAL: ${matches.length} lines across ${byAccount.size} account(s)`);

if (!apply) {
  console.log("\nReport only — re-run with --apply to delete (snapshot the DB first).");
  process.exit(0);
}

for (const [accountId, list] of byAccount) {
  const ids = list.map((m) => m.line.id);
  const removedFrom = earliestTransactionDateForLineIds(ids);
  const removed = deleteStatementLinesByIds(ids);
  upsertCreditCardValuationsFromLedger(accountId, { affectedEvidenceFromYmd: removedFrom });
  recomputeCcBillingMonthBalances(accountId);
  console.log(
    `account ${accountId}: deleted ${removed} lines, revalued from ${removedFrom ?? "(none)"}`
  );
}
console.log("Done.");
