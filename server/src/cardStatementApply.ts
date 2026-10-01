import type {
  CardStatementApplyDetails,
  CardStatementCurrency,
  CardStatementOutcome,
  CardStatementPayload,
} from "nw-tracker-contracts";
import { diffStatementAgainstLedger } from "./cardStatementCrossCheck.js";
import { padCcStatementDate, statementSourceOwnerForClose } from "./ccStatementJsonSource.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { masterAccountIdForIssuerCardAccount } from "./santanderAccountMap.js";
import {
  assertNoCardRoutingConflict,
  buildSantanderStatementRecords,
  fillStatementNextPeriodTo,
  inheritedStatementCtx,
  isoToCsvDate,
  statementNextPeriodTo,
  usdStatementIsStaleEcho,
  writeSantanderStatements,
} from "./santanderStatementImport.js";

/**
 * A `card.statement` (one facturación) → the ledger, «JSON leads, PDF import guarded»:
 *
 * - a (close, currency) a PDF already holds is never rewritten — that side gets the cross-check
 *   (its lines against the PDF's: the report that has already caught real PDF data loss), and the
 *   announced next close fills the PDF statement when its format predates the printed line;
 * - anything else is a write candidate, written with `apply` through the same merge pipeline as a
 *   PDF, both currencies together (a traspaso month links its two legs in one transaction), then
 *   verified against itself — a write that does not reconcile throws;
 * - a USD side whose every line already sits on an earlier statement is the dateless international
 *   endpoint re-serving an old cycle, and is not written;
 * - a plastic the card registry routes elsewhere than the issuer's account is a problem, never a
 *   side to take.
 *
 * Every side is reported line by line, as the feeder prints it.
 */

type Review = {
  statement: CardStatementCurrency;
  outcome: CardStatementOutcome;
  owner: "pdf" | "json" | null;
  report: string[];
  write?: CcStatementCsvRecord[];
};

function unexplainedDifferences(d: ReturnType<typeof diffStatementAgainstLedger>): number {
  return d.only_in_json.length - d.expected_only_in_json + d.only_in_db.length;
}

function reviewStatement(accountId: number, statementDate: string, payload: CardStatementPayload, statement: CardStatementCurrency): Review {
  const report: string[] = [];
  if (statement.lines.length === 0) return { statement, outcome: "empty", owner: null, report };

  const diff = diffStatementAgainstLedger(accountId, statementDate, statement);
  report.push(`${statement.document}  [${statement.currency}]  ${statementDate}`);
  report.push(
    `  account_id ${accountId} · extracto ${payload.statement_number} · json ${diff.json_lines} lines · ` +
      `ledger ${diff.db_lines ?? "not imported"}`
  );

  const owner = statementSourceOwnerForClose(accountId, statementDate, statement.currency);
  let nextCloseDisagrees = false;
  const nextClose = payload.next_close ? padCcStatementDate(isoToCsvDate(payload.next_close)) : null;
  // The announced next close is the same printed «próximo período» end the PDF carries; a
  // PDF-owned close gets it filled when the PDF format predates the line, and a disagreement is a
  // problem.
  if (owner === "pdf" && nextClose && statement.currency === "clp") {
    const stored = statementNextPeriodTo(accountId, statementDate, statement.currency);
    if (stored && stored !== nextClose) {
      nextCloseDisagrees = true;
      report.push(`  ✗ next close: the PDF prints ${stored}, the JSON's FechaProxFact is ${nextClose}`);
    } else if (!stored) {
      report.push(`  next close ${nextClose} (FechaProxFact) — ${payload.apply ? "stored on the PDF statement" : "would be stored (--apply)"}`);
      if (payload.apply) fillStatementNextPeriodTo(accountId, statementDate, statement.currency, nextClose);
    }
  }

  if (owner === "pdf") {
    report.push(
      `  matched ${diff.matched}${diff.matched_by_prefix > 0 ? ` (${diff.matched_by_prefix} by merchant prefix — the PDF layout glued a charge-type column onto the name)` : ""}` +
        (diff.matched_by_rendering > 0
          ? ` (${diff.matched_by_rendering} by merchant rendering — a terminal code only the JSON prints, or punctuation)`
          : "")
    );
    if (diff.only_in_json.length > 0) {
      report.push(`  only in JSON (${diff.only_in_json.length}, of which ${diff.expected_only_in_json} expected payment rows):`);
      for (const l of diff.only_in_json) report.push(`    ${l.merchant} ${l.amount} (${l.kind})`);
    }
    if (diff.only_in_db.length > 0) {
      report.push(`  only in ledger (${diff.only_in_db.length}):`);
      for (const l of diff.only_in_db) report.push(`    ${l.merchant} ${l.amount}`);
    }
    const unexplained = unexplainedDifferences(diff);
    if (unexplained === 0) {
      report.push("  ✓ PDF-owned, reconciles (only the payment row differs, as expected)");
      return { statement, outcome: nextCloseDisagrees ? "dirty" : "clean", owner, report };
    }
    report.push(`  ✗ PDF-owned, ${unexplained} unexplained line difference(s)`);
    return { statement, outcome: "dirty", owner, report };
  }

  try {
    assertNoCardRoutingConflict(accountId, payload.titular_last4);
  } catch (err) {
    report.push(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    return { statement, outcome: "dirty", owner, report };
  }
  // The dateless international endpoint can re-serve the last billed USD cycle on dormant months;
  // a full stale echo is expected there and must not import as new lines.
  if (statement.currency === "usd" && usdStatementIsStaleEcho(accountId, statementDate, statement.lines)) {
    report.push("  → every USD row already exists on an earlier statement (stale echo) — not imported");
    return { statement, outcome: "skipped", owner, report };
  }

  const ctx = inheritedStatementCtx(accountId, statement.currency, statementDate);
  const records = buildSantanderStatementRecords(statement.currency, statement.lines, statement, {
    accountId,
    statementDate,
    cardGroup: ctx.cardGroup,
    periodFrom: ctx.periodFrom,
    payBy: payload.pay_by ? padCcStatementDate(isoToCsvDate(payload.pay_by)) : null,
    cardLast4: payload.titular_last4,
    nextClose,
  });
  report.push(
    `  → ${owner === "json" ? "JSON-owned, rewrite" : "not in ledger, write"}: ` +
      `${records.length} line(s) as ${records[0]?.source_pdf} (group ${ctx.cardGroup}, period ${ctx.periodFrom} → ${statementDate})`
  );
  return { statement, outcome: "pending", owner, report, write: records };
}

export function applyCardStatement(payload: CardStatementPayload): CardStatementApplyDetails {
  const accountId = masterAccountIdForIssuerCardAccount(payload.account);
  const statementDate = padCcStatementDate(isoToCsvDate(payload.close));
  const reviews = payload.statements.map((s) => reviewStatement(accountId, statementDate, payload, s));

  let written: CardStatementApplyDetails["written"] = null;
  const pending = reviews.filter((r) => r.write != null);
  if (payload.apply && pending.length > 0) {
    const result = writeSantanderStatements(accountId, pending.flatMap((r) => r.write!));
    written = { currencies: result.currencies, lines_inserted: result.lineCount };
    for (const review of pending) {
      const post = diffStatementAgainstLedger(accountId, statementDate, review.statement);
      const unexplained = unexplainedDifferences(post);
      if (unexplained !== 0) {
        throw new Error(`Post-write verification failed for ${post.file}: ${unexplained} unexplained difference(s)`);
      }
      review.outcome = "written";
      review.report.push(`  ✓ written (${result.lineCount} line(s) inserted across ${result.currencies.join("+")}), post-write verification clean`);
    }
  }
  return {
    account_id: accountId,
    statements: reviews.map((r) => ({
      currency: r.statement.currency,
      document: r.statement.document,
      outcome: r.outcome,
      owner: r.owner,
      report: r.report,
    })),
    written,
  };
}
