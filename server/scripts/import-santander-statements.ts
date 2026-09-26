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
  diffStatementAgainstLedger,
  listSantanderStatementFiles,
  parseSantanderStatementFile,
  resolveSantanderStatementJsonDir,
  type ParsedSantanderStatement,
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

const parsedFiles = files
  .map((f) => ({ file: f, parsed: parseSantanderStatementFile(f) }))
  .filter((x): x is { file: string; parsed: ParsedSantanderStatement } => x.parsed != null);

// The international feed has no statement date of its own; take it from the national
// statement of the same card. Two different national closes for one account in a single
// batch would make that pairing ambiguous — import such dirs one facturación at a time.
const nationalDateByAccount = new Map<string, string>();
const nationalByAccount = new Map<string, ParsedSantanderStatement>();
for (const { parsed } of parsedFiles) {
  if (parsed.currency !== "clp" || !parsed.header.statement_date || !parsed.header.account) continue;
  const prev = nationalDateByAccount.get(parsed.header.account);
  if (prev && prev !== parsed.header.statement_date) {
    throw new Error(
      `Two national closes for account ${parsed.header.account} in one batch ` +
        `(${prev} vs ${parsed.header.statement_date}) — international files cannot be paired; ` +
        `import per capture dir instead`
    );
  }
  nationalDateByAccount.set(parsed.header.account, parsed.header.statement_date);
  nationalByAccount.set(parsed.header.account, parsed);
}

let clean = 0;
let dirty = 0;
let written = 0;
let skippedPdfOwned = 0;

// Group writable statements per account so one facturación's currencies merge atomically
// (a traspaso month needs both legs in one transaction for the link relinker). A capture dir
// can hold the same statement twice (retried fetch) — first parse wins.
const pendingWrites = new Map<number, CcStatementCsvRecord[]>();
const queuedCloses = new Set<string>();

for (const { parsed } of parsedFiles) {
  if (parsed.lines.length === 0) continue;

  const statementDateRaw = parsed.header.statement_date ?? nationalDateByAccount.get(parsed.header.account);
  const diff = diffStatementAgainstLedger(parsed, statementDateRaw);
  const header = `${diff.file}  [${diff.currency}]  ${diff.statement_date ?? "(no statement date)"}`;
  console.log(`\n${header}`);
  console.log(`  account_id ${diff.account_id ?? "?"} · json ${diff.json_lines} lines · ledger ${diff.db_lines ?? "not imported"}`);

  if (diff.account_id == null || !statementDateRaw) {
    dirty += 1;
    console.log("  ✗ cannot resolve account or statement date — not importable");
    continue;
  }

  const statementDate = padCcStatementDate(statementDateRaw);
  const owner = statementSourceOwnerForClose(diff.account_id, statementDate, parsed.currency);

  // FechaProxFact is the same printed «próximo período» end the PDF carries; a PDF-owned close
  // gets it filled when the PDF format predates the line, and a disagreement is a problem.
  const nextCloseRaw = parsed.header.next_close ?? nationalByAccount.get(parsed.header.account)?.header.next_close ?? null;
  const nextClose = nextCloseRaw ? padCcStatementDate(nextCloseRaw) : null;
  if (owner === "pdf" && nextClose && parsed.currency === "clp") {
    const stored = statementNextPeriodTo(diff.account_id, statementDate, parsed.currency);
    if (stored && stored !== nextClose) {
      dirty += 1;
      console.log(`  ✗ next close: the PDF prints ${stored}, the JSON's FechaProxFact is ${nextClose}`);
    } else if (!stored) {
      console.log(`  next close ${nextClose} (FechaProxFact) — ${apply ? "stored on the PDF statement" : "would be stored (--apply)"}`);
      if (apply) fillStatementNextPeriodTo(diff.account_id, statementDate, parsed.currency, nextClose);
    }
  }

  if (owner === "pdf") {
    skippedPdfOwned += 1;
    console.log(
      `  matched ${diff.matched}${diff.matched_by_prefix > 0 ? ` (${diff.matched_by_prefix} by merchant prefix — the PDF layout glued a charge-type column onto the name)` : ""}`
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
    } else {
      dirty += 1;
      console.log(`  ✗ PDF-owned, ${unexplained} unexplained line difference(s)`);
    }
    continue;
  }

  // The international header is empty (all nulls); its pay-by and titular card come from
  // the national twin of the same facturación.
  const national = nationalByAccount.get(parsed.header.account);
  const payByRaw = parsed.header.pay_by ?? national?.header.pay_by ?? null;
  const statementLast4 = parsed.header.card_last4 ?? national?.header.card_last4 ?? null;

  try {
    assertNoCardRoutingConflict(diff.account_id, statementLast4);
  } catch (err) {
    dirty += 1;
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  // The dateless international endpoint can re-serve the last billed USD cycle on dormant
  // months; a full stale echo is expected there and must not import as new lines.
  if (parsed.currency === "usd" && usdStatementIsStaleEcho(diff.account_id, statementDate, parsed.lines)) {
    console.log("  → every USD row already exists on an earlier statement (stale echo) — not imported");
    continue;
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
  if (apply) {
    const closeKey = `${diff.account_id}|${parsed.currency}|${statementDate}`;
    if (queuedCloses.has(closeKey)) {
      console.log("  (same statement already queued from an earlier file — skipped)");
      continue;
    }
    queuedCloses.add(closeKey);
    const queue = pendingWrites.get(diff.account_id) ?? [];
    queue.push(...records);
    pendingWrites.set(diff.account_id, queue);
  }
}

if (apply) {
  for (const [accountId, records] of pendingWrites) {
    const result = writeSantanderStatements(accountId, records);
    written += result.currencies.length;
    console.log(
      `\nWROTE account ${accountId} ${result.statementDate}: ${result.currencies.join("+")} ` +
        `(${result.lineCount} lines inserted)`
    );
    // Verify what was just written reconciles against itself.
    for (const { parsed } of parsedFiles) {
      if (parsed.lines.length === 0) continue;
      const sd = parsed.header.statement_date ?? nationalDateByAccount.get(parsed.header.account);
      const post = diffStatementAgainstLedger(parsed, sd);
      if (post.account_id !== accountId) continue;
      const unexplained = post.only_in_json.length - post.expected_only_in_json + post.only_in_db.length;
      if (unexplained !== 0) {
        throw new Error(
          `Post-write verification failed for ${post.file}: ${unexplained} unexplained difference(s)`
        );
      }
    }
    console.log("  ✓ post-write verification clean");
  }
}

const writeSummary = apply
  ? `${written} statement(s) written`
  : "nothing written (pass --apply to write the candidates above)";
console.log(
  `\n${clean} PDF-owned statement(s) reconcile, ${dirty} problem(s), ${skippedPdfOwned} PDF-owned skip(s) · ${writeSummary}`
);
