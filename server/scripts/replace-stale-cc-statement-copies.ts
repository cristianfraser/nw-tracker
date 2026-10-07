/**
 * One-time repair: replace card statement rows an older parse left behind with the copy the current
 * parse produces.
 *
 * The parser decides a statement's card group from its file name (`card_group_for_pdf_name`). An
 * earlier parse filed the ·0113 / ·0274 statements of the ·0161 master under group B; today they
 * parse as group A. The incremental import keys statements on (card group, file, close), so it
 * added the A copy beside the old B one instead of replacing it, and its line dedupe skipped every
 * A line the B copy already had — leaving the full set on the stale B row (no import fingerprint,
 * never refreshed) and 0–5 leftover lines on the A row, which the walk and the month-end anchors
 * then counted twice (2018-02-22: the MONTO CANCELADO −1xx.xxx on both).
 *
 * A stale copy: a statement row whose card group is not the one the current parse gives its file
 * and close, while a row under the parse's group exists (2019-07-24 ·0113: the B copy carried a
 * fingerprint from a later import and the A row only the MONTO CANCELADO −1xx.xxx again). Inside one
 * IMMEDIATE transaction this deletes the stale rows and re-imports their twins in full from the
 * parse through `mergeCcAccountFromParsedRows`, carrying categories, notes, big groups and splits
 * from the deleted lines to the new ones (`ccExpenseLineRekey.ts`) and failing when a paired card
 * payment loses its evidence. Without --apply everything is rolled back, so the report IS the plan.
 *
 *   npx tsx scripts/replace-stale-cc-statement-copies.ts [--csv=/abs/path.csv] [--apply]
 */
import path from "node:path";

import { db } from "../src/db.js";
import { readCommaCsvRecords } from "../src/ccParsedCommaCsv.js";
import { cardLast4FromParsedRow } from "../src/ccParsedImportAccounts.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../src/ccConsolidatedCards.js";
import {
  mergeCcAccountFromParsedRows,
  replaceStatementKeysFromRecords,
} from "../src/ccInstallmentLedgerMerge.js";
import { captureCcExpenseLines, rekeyCcExpenseLinesAfterImport } from "../src/ccExpenseLineRekey.js";
import {
  assertCcPaymentEvidenceKept,
  ccPaymentPairingIdsWithEvidence,
} from "../src/ccPaymentMirrorEvidence.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");
const csvArg = process.argv.find((a) => a.startsWith("--csv="))?.slice("--csv=".length);
const csvPath = csvArg ?? path.join(resolveCfraserCsvDir(), "cc-statements-parsed-all.csv");

class Rollback extends Error {}

type StatementRow = {
  id: number;
  account_id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  currency: string;
  import_fingerprint: string | null;
};

const records = readCommaCsvRecords(csvPath);
const parsedGroups = new Map<string, Set<string>>();
for (const r of records) {
  const key = `${String(r.source_pdf ?? "").trim()}\t${String(r.statement_date ?? "").trim()}`;
  parsedGroups.set(key, (parsedGroups.get(key) ?? new Set()).add(String(r.card_group ?? "").trim()));
}

const statements = db
  .prepare(
    `SELECT id, account_id, card_group, source_pdf, statement_date, currency, import_fingerprint
     FROM cc_statements`
  )
  .all() as StatementRow[];
const identity = (s: StatementRow) => `${s.account_id}\t${s.source_pdf}\t${s.statement_date}\t${s.currency}`;
const groupsOf = (s: StatementRow) => parsedGroups.get(`${s.source_pdf}\t${s.statement_date}`);
/** The row under the parse's own group, per statement identity. */
const parseGroupRow = new Map<string, StatementRow>();
for (const s of statements) if (groupsOf(s)?.has(s.card_group)) parseGroupRow.set(identity(s), s);

const stale = statements.filter((s) => {
  const groups = groupsOf(s);
  if (groups == null || groups.has(s.card_group)) return false;
  return parseGroupRow.has(identity(s));
});

const lineStats = db.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(amount_clp), 0) AS clp, COALESCE(SUM(amount_usd), 0) AS usd
   FROM cc_statement_lines WHERE statement_id = ?`
);
const stats = (id: number) => lineStats.get(id) as { n: number; clp: number; usd: number };

const byAccount = new Map<number, StatementRow[]>();
for (const s of stale) byAccount.set(s.account_id, [...(byAccount.get(s.account_id) ?? []), s]);

const tx = db.transaction(() => {
  for (const [accountId, rows] of byAccount) {
    const twins = rows.map((s) => parseGroupRow.get(identity(s))!);
    const twinFiles = new Set(twins.map((t) => `${t.source_pdf}\t${t.statement_date}`));
    const accountRecords = records.filter((r) => {
      const acc = resolveMasterAccountIdForImportCardLast4(cardLast4FromParsedRow(r));
      return acc === accountId && twinFiles.has(`${String(r.source_pdf).trim()}\t${String(r.statement_date).trim()}`);
    });
    const before = new Map(rows.map((s) => [s.id, stats(s.id)]));
    const twinBefore = new Map(twins.map((t) => [t.id, stats(t.id)]));

    const pairedWithEvidence = ccPaymentPairingIdsWithEvidence(accountId);
    const capture = captureCcExpenseLines(accountId);
    const del = db.prepare(`DELETE FROM cc_statements WHERE id = ?`);
    for (const s of rows) del.run(s.id);
    const merged = mergeCcAccountFromParsedRows(accountId, accountRecords, {
      replaceStatementKeys: replaceStatementKeysFromRecords(accountRecords),
    });
    const rekey = rekeyCcExpenseLinesAfterImport(capture);
    assertCcPaymentEvidenceKept(accountId, pairedWithEvidence, "the stale statement replacement");

    console.log(`\naccount ${accountId}: ${rows.length} stale copies, ${accountRecords.length} parsed lines re-imported`);
    for (const s of rows) {
      const twin = parseGroupRow.get(identity(s))!;
      const now = db
        .prepare(
          `SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf = ? AND statement_date = ? AND currency = ?`
        )
        .all(accountId, s.source_pdf, s.statement_date, s.currency) as { id: number }[];
      if (now.length !== 1) throw new Error(`${s.source_pdf} ${s.statement_date}: ${now.length} statement rows after the repair`);
      const after = stats(now[0]!.id);
      const expected = accountRecords.filter(
        (r) => String(r.source_pdf).trim() === s.source_pdf && String(r.statement_date).trim() === s.statement_date
      ).length;
      const b = before.get(s.id)!;
      const t = twinBefore.get(twin.id)!;
      console.log(
        `  ${s.statement_date} ${s.source_pdf}: stale ${s.card_group} ${b.n} lines (${Math.round(b.clp).toLocaleString("es-CL")}) + ` +
          `${twin.card_group} ${t.n} (${Math.round(t.clp).toLocaleString("es-CL")}) → ${after.n} lines ` +
          `(${Math.round(after.clp).toLocaleString("es-CL")}), parse has ${expected}`
      );
    }
    console.log(
      `  expense assignments carried: ${JSON.stringify(rekey)}; merge rekey ${JSON.stringify(merged.expense_line_rekey)}`
    );
  }
  clearAggregationCache();
  console.log(`\n${stale.length} stale statement copies on ${byAccount.size} account(s)`);
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
