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
 *   - the flows of its lines can be handed to P's lines (nothing a line's flow holds — category,
 *     note, big group, pieces, links, refund mark — conflicts with what P's line holds).
 * A stored statement the parse lacks for any other reason (a zero-row statement, one parked in
 * pending-review) is listed and left alone.
 *
 * Each copy line hands its flow to the line of P that stands for it, one to one (`ccDuplicateDownloadCopies.ts`):
 * a line P's document still needs a row for moves onto P as it is, a line P already has folds into
 * it, so the arrival and everything filed on the line survive.
 *
 * Report by default. `--apply` repairs each account in one transaction: the copies' lines hand
 * their flows over, the copies are deleted and each P is re-imported through
 * `importStatementDocuments` restating its lines — the same import the importer runs, so every import gate (reconcile, feed closes,
 * valuations) applies — and the converted card payments that had evidence before must still find
 * it afterwards (`assertCcPaymentEvidenceKept`), else the whole account rolls back.
 *
 *   npx tsx scripts/remove-cc-duplicate-download-statements.ts [--csv=/abs/parsed.csv]
 *   npx tsx scripts/remove-cc-duplicate-download-statements.ts --apply
 */
import path from "node:path";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "./lib/ccParsedCommaCsv.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { canonicalStatementsFromParsedRecords, cardStatementKey, type CardCanonicalStatement } from "nw-tracker-contracts";
// Loads the card-line write funnel the import writes through.
import "../src/cards/lineWrites.js";
import { padCcStatementDate } from "../src/ccStatementJsonSource.js";
import {
  copyHandoverConflict,
  copyLineIdentity,
  copyLinesWithAssignments,
  documentIdentityCounts,
  removeDuplicateDownloadCopies,
  storedStatementLines,
  type DuplicateDownloadCopy,
  type StoredCopyLine,
} from "../src/ccDuplicateDownloadCopies.js";

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

type ParsedStatement = {
  key: string;
  card_group: string;
  source_pdf: string;
  close: string;
  pay_by: string;
  currency: string;
  statement: CardCanonicalStatement;
};

const records = readCommaCsvRecords(csvPath);
if (records.length === 0) throw new Error(`No rows read from ${csvPath}`);

const parsed = new Map<string, ParsedStatement>();
for (const statement of canonicalStatementsFromParsedRecords(records)) {
  const src = statement.document;
  if (!src || src.startsWith("import:")) continue;
  const key = cardStatementKey(statement);
  parsed.set(key, {
    key,
    card_group: statement.card_group,
    source_pdf: src,
    close: padCcStatementDate(statement.close),
    pay_by: padCcStatementDate(statement.pay_by ?? ""),
    currency: statement.currency,
    statement,
  });
}
const parsedBySourceClose = new Set([...parsed.values()].map((p) => `${p.source_pdf}\t${p.close}`));

const stored = db
  .prepare(
    `SELECT id, account_id, card_group, source_pdf, statement_date, period_from, currency
     FROM cc_statements
     WHERE source_kind = 'statement_pdf'
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

type Plan = { copy: StoredStatement; target: ParsedStatement; targetStatementId: number; lines: StoredCopyLine[]; handover: DuplicateDownloadCopy };
const plans: Plan[] = [];
const leftAlone: string[] = [];
const refused: string[] = [];

for (const s of stored) {
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
  const lines = storedStatementLines(s.id);
  const copy: DuplicateDownloadCopy = {
    copyStatementId: s.id,
    targetStatementId: ps.id,
    currency: s.currency,
    targetStatement: p.statement,
    targetKey: p.key,
  };
  const onTarget = documentIdentityCounts(p.statement);
  const missing: StoredCopyLine[] = [];
  for (const l of lines) {
    const k = copyLineIdentity(s.currency, l.transaction_date, l.merchant, l.amount_clp, l.amount_usd);
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
  const conflict = copyHandoverConflict(copy);
  if (conflict) {
    refused.push(`${label}: its flows cannot be handed to ${p.source_pdf}'s lines — ${conflict}`);
    continue;
  }
  const filed = copyLinesWithAssignments(lines);
  if (filed.length > 0) console.log(`# ${label}: ${filed.length} line(s) carry filed assignments, handed to ${p.source_pdf}'s lines`);
  plans.push({ copy: s, target: p, targetStatementId: ps.id, lines, handover: copy });
}

console.log(`# parsed CSV: ${csvPath} (${parsed.size} statements)`);
for (const pl of plans) {
  console.log(
    `duplicate copy: statement ${pl.copy.id} (account ${pl.copy.account_id}, ${pl.copy.source_pdf}, ` +
      `close ${pl.copy.statement_date}, ${pl.lines.length} line(s)) = ${pl.target.source_pdf} ` +
      `(statement ${pl.targetStatementId}, close ${pl.target.close}, ${pl.target.statement.lines.length} parsed row(s))`
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

const byAccount = new Map<number, Plan[]>();
for (const pl of plans) {
  const list = byAccount.get(pl.copy.account_id) ?? [];
  list.push(pl);
  byAccount.set(pl.copy.account_id, list);
}
for (const [accountId, list] of byAccount) {
  const result = removeDuplicateDownloadCopies(accountId, list.map((pl) => pl.handover));
  console.log(
    `account ${accountId}: deleted ${list.map((pl) => pl.copy.id).join(", ")}; re-imported ` +
      `${result.statements.statementCount} statement(s), ${result.statements.linesInserted} line(s) inserted, ` +
      `${result.statements.linesSkippedDuplicate} skipped as duplicates.`
  );
}
