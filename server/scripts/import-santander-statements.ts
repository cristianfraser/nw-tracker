/**
 * Santander statement JSON → ledger. Report by default; `--apply` writes.
 *
 *   npm run import:santander-statements -w nw-tracker-server
 *   npm run import:santander-statements -w nw-tracker-server -- --dir=<path>
 *   npm run import:santander-statements -w nw-tracker-server -- --apply
 *
 * «JSON leads, PDF import guarded»: a facturación already imported from its PDF is never
 * rewritten — those statements get the report-only diff (the cross-check that has already
 * caught real PDF data loss). Unowned facturaciones are written through the same merge
 * pipeline as PDFs; once JSON owns a close, later PDF imports of it are skipped by the
 * symmetric guard in `mergeCcAccountFromParsedRows` and the PDF stays the archive.
 *
 * A facturación's two currencies pair on (account, NumExtracto) — both endpoints are asked for
 * the same statement number — and the international one, which carries no dates of its own, is
 * dated from its national twin. An international file with no twin is reported, never dated
 * from another close (`assembleSantanderStatementBatch`).
 *
 * The staging dir only grows: the scraper writes one file per (account, extracto, endpoint) and
 * never deletes. `--apply` moves a superseded facturación — any but its account's newest
 * extracto, which the scraper keeps re-fetching — into `<dir>/archive/` once every statement of
 * it is verified: diffed clean against its PDF, or written from the JSON and checked against
 * itself. Anything else stays in place and is reported again the next run.
 *
 * A clean report diff is: `only in JSON` containing just the payment row (CodTxs 067, which
 * the PDF parser drops by design) and `only in DB` empty.
 */
import fs from "node:fs";
import path from "node:path";
import { statementSourceOwnerForClose, padCcStatementDate } from "../src/ccStatementJsonSource.js";
import {
  assertNoCardRoutingConflict,
  buildSantanderStatementRecords,
  fillStatementNextPeriodTo,
  inheritedStatementCtx,
  statementNextPeriodTo,
  usdStatementIsStaleEcho,
  writeSantanderStatements,
} from "../src/santanderStatementImport.js";
import {
  assembleSantanderStatementBatch,
  diffStatementAgainstLedger,
  listSantanderStatementFiles,
  parseSantanderStatementFile,
  resolveSantanderStatementJsonDir,
  selectSantanderStatementGroupsToArchive,
  type ParsedSantanderStatement,
  type SantanderStatementGroup,
  type SantanderStatementGroupOutcomes,
  type SantanderStatementOutcome,
} from "../src/santanderStatementReport.js";
import type { CcStatementCsvRecord } from "../src/ccStatementsImport.js";

const apply = process.argv.includes("--apply");
const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
const dir = dirArg ? path.resolve(dirArg) : resolveSantanderStatementJsonDir();

const files = dirArg
  ? fs
      .readdirSync(dir)
      .filter((n) => /estadoCuenta(Nacional|Internacional)/i.test(n) && n.endsWith(".json"))
      .sort()
      .map((n) => path.join(dir, n))
  : listSantanderStatementFiles(dir);

if (files.length === 0) {
  console.log(`No statement JSON in ${dir}.`);
  console.log("Run `npm run fetch:santander` (statements are saved on every run), or pass --dir=<capture dir>.");
  process.exit(0);
}

const statements: ParsedSantanderStatement[] = [];
for (const file of files) {
  const parsed = parseSantanderStatementFile(file);
  if (parsed) statements.push(parsed);
  else console.log(`\n${path.basename(file)}\n  not a statement response (no OUTPUT) — skipped`);
}
const { groups, duplicates } = assembleSantanderStatementBatch(statements);
for (const { file, copy_of } of duplicates) {
  console.log(`\n${file}\n  identical copy of ${copy_of} (a retried fetch) — skipped`);
}

let clean = 0;
let dirty = 0;
let written = 0;
let skippedPdfOwned = 0;
let unpaired = 0;

type StatementReview = {
  statement: ParsedSantanderStatement;
  outcome: SantanderStatementOutcome;
  /** Present on a write candidate (`pending`). */
  write?: { accountId: number; records: CcStatementCsvRecord[] };
};

/** Diff one statement against the ledger, print its report block, and build its write if any. */
function reviewStatement(
  parsed: ParsedSantanderStatement,
  group: SantanderStatementGroup,
  national: ParsedSantanderStatement
): StatementReview {
  if (parsed.lines.length === 0) return { statement: parsed, outcome: "empty" };

  const statementDateRaw = parsed.header.statement_date ?? group.statement_date;
  const diff = diffStatementAgainstLedger(parsed, statementDateRaw);
  const header = `${diff.file}  [${diff.currency}]  ${diff.statement_date ?? "(no statement date)"}`;
  console.log(`\n${header}`);
  console.log(
    `  account_id ${diff.account_id ?? "?"} · extracto ${group.extracto} · json ${diff.json_lines} lines · ` +
      `ledger ${diff.db_lines ?? "not imported"}`
  );

  if (diff.account_id == null || !statementDateRaw) {
    dirty += 1;
    console.log("  ✗ cannot resolve account or statement date — not importable");
    return { statement: parsed, outcome: "dirty" };
  }

  const statementDate = padCcStatementDate(statementDateRaw);
  const owner = statementSourceOwnerForClose(diff.account_id, statementDate, parsed.currency);
  let nextCloseDisagrees = false;

  // FechaProxFact is the same printed «próximo período» end the PDF carries; a PDF-owned close
  // gets it filled when the PDF format predates the line, and a disagreement is a problem.
  const nextCloseRaw = parsed.header.next_close ?? national.header.next_close ?? null;
  const nextClose = nextCloseRaw ? padCcStatementDate(nextCloseRaw) : null;
  if (owner === "pdf" && nextClose && parsed.currency === "clp") {
    const stored = statementNextPeriodTo(diff.account_id, statementDate, parsed.currency);
    if (stored && stored !== nextClose) {
      dirty += 1;
      nextCloseDisagrees = true;
      console.log(`  ✗ next close: the PDF prints ${stored}, the JSON's FechaProxFact is ${nextClose}`);
    } else if (!stored) {
      console.log(`  next close ${nextClose} (FechaProxFact) — ${apply ? "stored on the PDF statement" : "would be stored (--apply)"}`);
      if (apply) fillStatementNextPeriodTo(diff.account_id, statementDate, parsed.currency, nextClose);
    }
  }

  if (owner === "pdf") {
    skippedPdfOwned += 1;
    console.log(
      `  matched ${diff.matched}${diff.matched_by_prefix > 0 ? ` (${diff.matched_by_prefix} by merchant prefix — the PDF layout glued a charge-type column onto the name)` : ""}` +
        (diff.matched_by_rendering > 0
          ? ` (${diff.matched_by_rendering} by merchant rendering — a terminal code only the JSON prints, or punctuation)`
          : "")
    );
    if (diff.only_in_json.length > 0) {
      console.log(`  only in JSON (${diff.only_in_json.length}, of which ${diff.expected_only_in_json} expected payment rows):`);
      for (const l of diff.only_in_json) console.log(`    ${l.merchant} ${l.amount} (cod ${l.cod_txs})`);
    }
    if (diff.only_in_db.length > 0) {
      console.log(`  only in ledger (${diff.only_in_db.length}):`);
      for (const l of diff.only_in_db) console.log(`    ${l.merchant} ${l.amount}`);
    }
    const unexplained = diff.only_in_json.length - diff.expected_only_in_json + diff.only_in_db.length;
    if (unexplained === 0) {
      clean += 1;
      console.log("  ✓ PDF-owned, reconciles (only the payment row differs, as expected)");
      return { statement: parsed, outcome: nextCloseDisagrees ? "dirty" : "clean" };
    }
    dirty += 1;
    console.log(`  ✗ PDF-owned, ${unexplained} unexplained line difference(s)`);
    return { statement: parsed, outcome: "dirty" };
  }

  // The international header is empty (all nulls); its pay-by and titular card come from
  // the national twin of the same facturación.
  const payByRaw = parsed.header.pay_by ?? national.header.pay_by ?? null;
  const statementLast4 = parsed.header.card_last4 ?? national.header.card_last4 ?? null;

  try {
    assertNoCardRoutingConflict(diff.account_id, statementLast4);
  } catch (err) {
    dirty += 1;
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    return { statement: parsed, outcome: "dirty" };
  }
  // The dateless international endpoint can re-serve the last billed USD cycle on dormant
  // months; a full stale echo is expected there and must not import as new lines.
  if (parsed.currency === "usd" && usdStatementIsStaleEcho(diff.account_id, statementDate, parsed.lines)) {
    console.log("  → every USD row already exists on an earlier statement (stale echo) — not imported");
    return { statement: parsed, outcome: "skipped" };
  }

  const ctx = inheritedStatementCtx(diff.account_id, parsed.currency, statementDate);
  const records = buildSantanderStatementRecords(parsed.currency, parsed.lines, parsed.header, {
    accountId: diff.account_id,
    statementDate,
    cardGroup: ctx.cardGroup,
    periodFrom: ctx.periodFrom,
    payBy: payByRaw ? padCcStatementDate(payByRaw) : null,
    cardLast4: statementLast4,
    nextClose,
  });
  console.log(
    `  → ${owner === "json" ? "JSON-owned, rewrite" : "not in ledger, write"}: ` +
      `${records.length} line(s) as ${records[0]?.source_pdf} (group ${ctx.cardGroup}, period ${ctx.periodFrom} → ${statementDate})`
  );
  return { statement: parsed, outcome: "pending", write: { accountId: diff.account_id, records } };
}

const outcomes = new Map<string, SantanderStatementGroupOutcomes>();

// Groups run oldest extracto first per account, and each facturación is written (and verified)
// before the next is reviewed: a later close's period_from is the previous close in the ledger,
// which may be the one just written.
for (const group of groups) {
  const national = group.national;
  if (!national) {
    unpaired += 1;
    console.log(`\n${group.international!.file}  [usd]  (no statement date)`);
    console.log(
      `  unpaired: no national statement of extracto ${group.extracto} for account ${group.account} — ` +
        `the international feed carries no close of its own, so it is neither dated nor imported`
    );
    continue;
  }

  const reviews = [national, group.international]
    .filter((s): s is ParsedSantanderStatement => s != null)
    .map((statement) => reviewStatement(statement, group, national));

  const pending = reviews.filter((r) => r.write != null);
  if (apply && pending.length > 0) {
    // One facturación's currencies merge together: a traspaso month needs both legs in one
    // transaction for the link relinker.
    const accountId = pending[0]!.write!.accountId;
    const result = writeSantanderStatements(accountId, pending.flatMap((r) => r.write!.records));
    written += result.currencies.length;
    console.log(
      `\nWROTE account ${accountId} ${result.statementDate}: ${result.currencies.join("+")} ` +
        `(${result.lineCount} lines inserted)`
    );
    // Verify what was just written reconciles against itself.
    for (const review of pending) {
      const post = diffStatementAgainstLedger(review.statement, group.statement_date);
      const unexplained = post.only_in_json.length - post.expected_only_in_json + post.only_in_db.length;
      if (unexplained !== 0) {
        throw new Error(
          `Post-write verification failed for ${post.file}: ${unexplained} unexplained difference(s)`
        );
      }
      review.outcome = "written";
    }
    console.log("  ✓ post-write verification clean");
  }
  outcomes.set(group.key, Object.fromEntries(reviews.map((r) => [r.statement.currency, r.outcome])));
}

const { archive, keep } = selectSantanderStatementGroupsToArchive(groups, outcomes);
if (archive.length > 0 || keep.length > 0) console.log("");
for (const group of keep) {
  console.log(
    `KEPT account ${group.account} extracto ${group.extracto} (${group.statement_date ?? "no close"}): ` +
      `superseded, but not every statement is verified — stays in place`
  );
}
if (apply && archive.length > 0) {
  const archiveDir = path.join(dir, "archive");
  const moves = archive.flatMap((group) =>
    group.files.map((file) => ({ from: path.join(dir, file), to: path.join(archiveDir, file) }))
  );
  // Never overwrite an archived statement, and check every destination before the first move.
  const taken = moves.filter((move) => fs.existsSync(move.to));
  if (taken.length > 0) {
    throw new Error(
      `Cannot archive: ${taken.map((move) => path.relative(dir, move.to)).join(", ")} already exist(s) — a ` +
        `statement archived earlier was staged again. Compare the copies and remove one by hand.`
    );
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const move of moves) fs.renameSync(move.from, move.to);
}
for (const group of archive) {
  console.log(
    `${apply ? "ARCHIVED" : "would archive (--apply)"} account ${group.account} extracto ${group.extracto} ` +
      `(${group.statement_date}): ${group.files.join(", ")}${apply ? " → archive/" : ""}`
  );
}

const writeSummary = apply
  ? `${written} statement(s) written`
  : "nothing written (pass --apply to write the candidates above)";
const archiveSummary = apply
  ? `${archive.length} superseded facturación(es) archived`
  : `${archive.length} superseded facturación(es) to archive with --apply`;
console.log(
  `\n${clean} PDF-owned statement(s) reconcile, ${dirty} problem(s), ${skippedPdfOwned} PDF-owned skip(s), ` +
    `${unpaired} unpaired international file(s) · ${writeSummary} · ${archiveSummary}`
);
