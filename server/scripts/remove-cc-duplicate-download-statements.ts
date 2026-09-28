/**
 * One-time cleanup: stored statements that an old parse built from a duplicate download.
 *
 * Santander lets a statement be downloaded again after its close, and that second copy was filed
 * under its PAGAR HASTA date («<pay-by> estado de cuenta tarjeta usd <last4>.pdf»). The text is the
 * same statement's, word for word. An old parser took that pay-by as the close and the real close
 * as the period start, so the copy landed as a statement of its own. When the real statement was
 * imported later, its lines were skipped as duplicates of the copy's (only same-statement twins,
 * which the copy had collapsed, got in), so the purchases sat on a phantom close. The current parse
 * reads the real close from the copy and skips it as an already-parsed statement («skip duplicate
 * statement copy»), so the phantom row never re-imports and nothing repairs it.
 *
 * A stored statement is such a copy when all of these hold:
 *   - it came from a PDF (not a web paste, not the statement JSON) and the current parse has no
 *     statement with its source name and close, nor any statement for its close on the account;
 *   - the parse has a statement P, stored on the same account, card group and currency, whose close
 *     is the copy's period start and whose pay-by is the copy's close (the misread signature);
 *   - every line of the copy is on P (transaction date, merchant, amounts), counted as a multiset;
 *   - none of its lines carries an expense category (deleting it would drop the category).
 * A stored statement the parse lacks for any other reason (a zero-row statement, one parked in
 * pending-review) is listed and left alone.
 *
 * Report by default. `--apply` repairs each account in one transaction: the copies are deleted
 * (their lines cascade) and each P is re-imported through `mergeCcAccountFromParsedRows` with its
 * lines replaced — the same merge the importer runs, so every import gate (reconcile, feed closes,
 * valuations) applies — and the converted card payments that had evidence before must still find
 * it afterwards (`assertCcPaymentEvidenceKept`), else the whole account rolls back.
 *
 *   npx tsx scripts/remove-cc-duplicate-download-statements.ts [--csv=/abs/parsed.csv]
 *   npx tsx scripts/remove-cc-duplicate-download-statements.ts --apply
 */
import path from "node:path";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import {
  ccImportFlowItemFromRow,
  currencyFromRow,
  statementKeyFromRow,
  type CcStatementCsvRecord,
} from "../src/ccStatementsImport.js";
import { mergeCcAccountFromParsedRows } from "../src/ccInstallmentLedgerMerge.js";
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { padCcStatementDate } from "../src/ccStatementJsonSource.js";
import { isSantanderJsonSource } from "../src/ccStatementJsonSource.js";
import {
  assertCcPaymentEvidenceKept,
  ccPaymentPairingIdsWithEvidence,
} from "../src/ccPaymentMirrorEvidence.js";

const apply = process.argv.includes("--apply");
const csvArg = process.argv.find((a) => a.startsWith("--csv="))?.slice("--csv=".length);
const csvPath = csvArg ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

type StoredStatement = {
  id: number;
  account_id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  period_from: string | null;
  currency: string;
};

type StoredLine = {
  id: number;
  transaction_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  categorized: number;
};

type ParsedStatement = {
  key: string;
  card_group: string;
  source_pdf: string;
  close: string;
  pay_by: string;
  currency: string;
  records: CcStatementCsvRecord[];
};

/** Date, merchant and the amount in the statement's own currency (a stored USD line keeps CLP 0). */
function lineIdentity(
  currency: string,
  d: string | null,
  merchant: string | null,
  clp: number | null,
  usd: number | null
): string {
  const iso = parseDdMmYyToIso(String(d ?? "").trim()) ?? String(d ?? "").trim();
  const amount = currency === "usd" ? (usd == null ? "" : usd.toFixed(2)) : String(clp ?? "");
  return `${iso}|${String(merchant ?? "").trim().toUpperCase()}|${amount}`;
}

const records = readCommaCsvRecords(csvPath);
if (records.length === 0) throw new Error(`No rows read from ${csvPath}`);

const parsed = new Map<string, ParsedStatement>();
for (const r of records) {
  const src = String(r.source_pdf ?? "").trim();
  if (!src || src.startsWith("import:")) continue;
  const key = statementKeyFromRow(r);
  let st = parsed.get(key);
  if (!st) {
    st = {
      key,
      card_group: String(r.card_group ?? ""),
      source_pdf: src,
      close: padCcStatementDate(String(r.statement_date ?? "")),
      pay_by: padCcStatementDate(String(r.pay_by ?? "")),
      currency: currencyFromRow(r),
      records: [],
    };
    parsed.set(key, st);
  }
  st.records.push(r);
}
const parsedBySourceClose = new Set([...parsed.values()].map((p) => `${p.source_pdf}\t${p.close}`));

const stored = db
  .prepare(
    `SELECT id, account_id, card_group, source_pdf, statement_date, period_from, currency
     FROM cc_statements
     WHERE source_pdf NOT LIKE 'import:%'
     ORDER BY account_id, id`
  )
  .all() as StoredStatement[];
const storedBySourceClose = new Map<string, StoredStatement>();
for (const s of stored) storedBySourceClose.set(`${s.source_pdf}\t${padCcStatementDate(s.statement_date)}`, s);

/** Parsed statements with the stored row they import into (its account). */
const parsedOnAccount: { p: ParsedStatement; s: StoredStatement }[] = [];
for (const p of parsed.values()) {
  const s = storedBySourceClose.get(`${p.source_pdf}\t${p.close}`);
  if (s) parsedOnAccount.push({ p, s });
}

const selLines = db.prepare(
  `SELECT l.id, l.transaction_date, l.merchant, l.amount_clp, l.amount_usd,
          (c.statement_line_id IS NOT NULL) AS categorized
   FROM cc_statement_lines l
   LEFT JOIN cc_expense_line_categories c ON c.statement_line_id = l.id
   WHERE l.statement_id = ?`
);

type Plan = { copy: StoredStatement; target: ParsedStatement; targetStatementId: number; lines: StoredLine[] };
const plans: Plan[] = [];
const leftAlone: string[] = [];
const refused: string[] = [];

for (const s of stored) {
  if (isSantanderJsonSource(s.source_pdf)) continue;
  const close = padCcStatementDate(s.statement_date);
  if (parsedBySourceClose.has(`${s.source_pdf}\t${close}`)) continue;
  const reachableByClose = parsedOnAccount.some(
    ({ p, s: ps }) => ps.account_id === s.account_id && p.card_group === s.card_group && p.close === close
  );
  if (reachableByClose) continue;

  const label = `statement ${s.id} (account ${s.account_id}, ${s.source_pdf}, close ${close})`;
  const periodFrom = padCcStatementDate(String(s.period_from ?? ""));
  const targets = parsedOnAccount.filter(
    ({ p, s: ps }) =>
      ps.account_id === s.account_id &&
      p.card_group === s.card_group &&
      p.currency === s.currency &&
      p.close === periodFrom &&
      p.pay_by === close
  );
  if (targets.length === 0) {
    leftAlone.push(`${label}: not in the parse, and no parsed statement closes on its period start with its close as pay-by`);
    continue;
  }
  if (targets.length > 1) {
    refused.push(`${label}: several parsed statements match (${targets.map((t) => t.p.source_pdf).join(", ")})`);
    continue;
  }
  const { p, s: ps } = targets[0]!;
  const lines = selLines.all(s.id) as StoredLine[];
  const categorized = lines.filter((l) => l.categorized);
  if (categorized.length > 0) {
    refused.push(`${label}: ${categorized.length} line(s) carry an expense category (ids ${categorized.map((l) => l.id).join(", ")})`);
    continue;
  }
  const onTarget = new Map<string, number>();
  for (const r of p.records) {
    const it = ccImportFlowItemFromRow(r, "");
    const k = lineIdentity(p.currency, String(r.transaction_date ?? ""), it.description, it.amount_clp, it.amount_usd);
    onTarget.set(k, (onTarget.get(k) ?? 0) + 1);
  }
  const missing: StoredLine[] = [];
  for (const l of lines) {
    const k = lineIdentity(s.currency, l.transaction_date, l.merchant, l.amount_clp, l.amount_usd);
    const n = onTarget.get(k) ?? 0;
    if (n === 0) missing.push(l);
    else onTarget.set(k, n - 1);
  }
  if (missing.length > 0) {
    refused.push(
      `${label}: ${missing.length} line(s) not on ${p.source_pdf} — ` +
        missing.map((l) => `${l.transaction_date} ${l.merchant} ${l.amount_usd ?? l.amount_clp}`).join("; ")
    );
    continue;
  }
  plans.push({ copy: s, target: p, targetStatementId: ps.id, lines });
}

console.log(`# parsed CSV: ${csvPath} (${parsed.size} statements)`);
for (const pl of plans) {
  console.log(
    `duplicate copy: statement ${pl.copy.id} (account ${pl.copy.account_id}, ${pl.copy.source_pdf}, ` +
      `close ${pl.copy.statement_date}, ${pl.lines.length} line(s)) = ${pl.target.source_pdf} ` +
      `(statement ${pl.targetStatementId}, close ${pl.target.close}, ${pl.target.records.length} parsed row(s))`
  );
}
for (const m of leftAlone) console.log(`left alone: ${m}`);
for (const m of refused) console.log(`REFUSED: ${m}`);
if (refused.length > 0) throw new Error(`${refused.length} candidate(s) refused — see above; nothing written.`);
if (plans.length === 0) {
  console.log("Nothing to remove.");
  process.exit(0);
}
if (!apply) {
  console.log(`# report only — ${plans.length} copy statement(s); pass --apply to delete them and re-import their statements.`);
  process.exit(0);
}

const delStatement = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);
const byAccount = new Map<number, Plan[]>();
for (const pl of plans) {
  const list = byAccount.get(pl.copy.account_id) ?? [];
  list.push(pl);
  byAccount.set(pl.copy.account_id, list);
}
for (const [accountId, list] of byAccount) {
  const result = db.transaction(() => {
    const before = ccPaymentPairingIdsWithEvidence(accountId);
    for (const pl of list) delStatement.run(pl.copy.id);
    const targetRecords = list.flatMap((pl) => pl.target.records);
    const merged = mergeCcAccountFromParsedRows(accountId, targetRecords, {
      replaceLedger: false,
      replaceStatementKeys: new Set(list.map((pl) => pl.target.key)),
    });
    assertCcPaymentEvidenceKept(accountId, before, "removing the duplicate-download statements");
    return merged;
  })();
  console.log(
    `account ${accountId}: deleted ${list.map((pl) => pl.copy.id).join(", ")}; re-imported ` +
      `${result.statements.statementCount} statement(s), ${result.statements.linesInserted} line(s) inserted, ` +
      `${result.statements.linesSkippedDuplicate} skipped as duplicates.`
  );
}
