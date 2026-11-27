/**
 * Removing card statements outright (the orphan prune of `list-missing-cc-statement-pdfs.ts`): the
 * lines go through the card-line write funnel (evidence date read first, valuations and billing
 * re-synced), and a statement whose lines carry something the user filed is refused unless the
 * caller says those assignments may go: they have no other row to live on.
 */
import { db } from "./db.js";
import { cardLineWrite, deleteLines } from "./cards/lineWrites.js";
import { flowHoldsAssignments } from "./flows/mirrorLegFlows.js";

export type StatementPruneReport = {
  statementId: number;
  accountId: number;
  lines: number;
  /** Lines whose flow holds a category, note, big group, pieces, link or refund mark, or that carry a per-line category. */
  lines_with_assignments: number;
};

/** What pruning each statement would delete, and how many of its lines carry user-filed work. */
export function reportStatementPrune(statementIds: readonly number[]): StatementPruneReport[] {
  return statementIds.map((statementId) => {
    const stmt = db.prepare(`SELECT account_id FROM cc_statements WHERE id = ?`).get(statementId) as { account_id: number } | undefined;
    if (!stmt) throw new Error(`statement ${statementId} is not on file`);
    const lines = db.prepare(`SELECT id, flow_id FROM cc_statement_lines WHERE statement_id = ?`).all(statementId) as {
      id: number;
      flow_id: number | null;
    }[];
    const override = db.prepare(`SELECT 1 FROM cc_expense_line_categories WHERE statement_line_id = ?`);
    const withAssignments = lines.filter(
      (l) => override.get(l.id) != null || (l.flow_id != null && flowHoldsAssignments(l.flow_id, db))
    ).length;
    return { statementId, accountId: stmt.account_id, lines: lines.length, lines_with_assignments: withAssignments };
  });
}

/**
 * Deletes the statements and their lines through the funnel, one card-line write per card. Throws
 * before any write when a statement's lines carry assignments and `allowAssignmentLoss` is not set.
 * Returns the report it acted on.
 */
export function pruneStatements(statementIds: readonly number[], opts: { allowAssignmentLoss: boolean }): StatementPruneReport[] {
  const report = reportStatementPrune(statementIds);
  const held = report.filter((r) => r.lines_with_assignments > 0);
  if (held.length > 0 && !opts.allowAssignmentLoss) {
    throw new Error(
      `refusing to prune: ${held.map((r) => `statement ${r.statementId} (${r.lines_with_assignments} line(s) with filed assignments)`).join(", ")}; ` +
        `those assignments have no other row to live on`
    );
  }
  for (const accountId of new Set(report.map((r) => r.accountId))) {
    const own = report.filter((r) => r.accountId === accountId);
    cardLineWrite(accountId, "pruning statements without a PDF", () => {
      for (const r of own) {
        const ids = (db.prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ?`).all(r.statementId) as { id: number }[]).map((l) => l.id);
        deleteLines(accountId, ids, { what: "pruning statements without a PDF" });
        db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(r.statementId);
      }
    });
  }
  return report;
}
