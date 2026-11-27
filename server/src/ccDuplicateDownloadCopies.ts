/**
 * A statement stored from a duplicate download (`scripts/remove-cc-duplicate-download-statements.ts`)
 * is removed without losing what was filed on its lines: each copy line hands its flow to the line
 * of the real statement that stands for it, one to one by the line's identity (date, merchant,
 * amount in the statement's currency, counted as a multiset).
 *
 * - A copy line whose identity the real statement's document still needs a row for moves onto the
 *   real statement as it is (id, flow, arrival, category, note, big group, pieces, links); the
 *   import that follows restates it in place.
 * - A copy line whose identity the real statement already has a row for folds into that row
 *   (`CardLinePlan.fold`: the earlier arrival's assignments win).
 *
 * A pairing whose flows cannot become one (`mirrorLegFlowsConflict`: two different categories, two
 * sets of pieces, a bill on both…) is refused before anything is written.
 */
import { db } from "./db.js";
import { storedCardLineDate, type CardCanonicalStatement } from "nw-tracker-contracts";
import { ccImportFlowItemFromLine } from "./ccStatementsImport.js";
import { importStatementDocuments, type StatementDocumentsImportResult } from "./cards/statementLinePlanApply.js";
import { applyLinePlan, cardLineWrite } from "./cards/lineWrites.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { lineAmountClpSql, lineAmountUsdSql } from "./cards/lineAmountSql.js";
import { assertCcPaymentEvidenceKept, ccPaymentPairingIdsWithEvidence } from "./ccPaymentMirrorEvidence.js";
import { flowHoldsAssignments, mirrorLegFlowsConflict } from "./flows/mirrorLegFlows.js";

export type StoredCopyLine = {
  id: number;
  flow_id: number | null;
  transaction_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

/** Date, merchant and the amount in the statement's own currency (a stored USD line keeps CLP 0). */
export function copyLineIdentity(
  currency: string,
  d: string | null,
  merchant: string | null,
  clp: number | null,
  usd: number | null
): string {
  const iso = parseDdMmYyToIso(String(d ?? "").trim()) ?? String(d ?? "").trim();
  const amount = currency === "usd" ? (usd == null ? "" : usd.toFixed(2)) : String(clp ?? ""); // convention-ok: Santander statements are a peso or a dollar side
  return `${iso}|${String(merchant ?? "").trim().toUpperCase()}|${amount}`;
}

const selLines = db.prepare(
  `SELECT l.id, l.flow_id, l.transaction_date, l.merchant, ${lineAmountClpSql("l")} AS amount_clp, ${lineAmountUsdSql("l")} AS amount_usd
   FROM cc_statement_lines l WHERE l.statement_id = ? ORDER BY l.id`
);

export function storedStatementLines(statementId: number): StoredCopyLine[] {
  return selLines.all(statementId) as StoredCopyLine[];
}

/** The identities of a document's rows, counted. */
export function documentIdentityCounts(statement: CardCanonicalStatement): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of statement.lines) {
    const it = ccImportFlowItemFromLine(line, "");
    const k = copyLineIdentity(
      statement.currency,
      storedCardLineDate(line.printed_transaction_date, line.transaction_date),
      it.description,
      it.amount_clp,
      it.amount_usd
    );
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export type CopyLineHandover = {
  /** Copy lines that move onto the real statement as they are. */
  move: number[];
  /** Copy lines whose flow folds into the real statement's line of the same identity. */
  fold: { fromLineId: number; intoLineId: number }[];
};

/**
 * Pairs the copy's lines with the real statement's, one to one. `targetDocument` is what the real
 * statement's document states; `targetLines` the rows it has on file.
 */
export function planCopyLineHandover(
  currency: string,
  copyLines: readonly StoredCopyLine[],
  targetLines: readonly StoredCopyLine[],
  targetDocument: ReadonlyMap<string, number>
): CopyLineHandover {
  const identity = (l: StoredCopyLine) => copyLineIdentity(currency, l.transaction_date, l.merchant, l.amount_clp, l.amount_usd);
  const onTarget = new Map<string, StoredCopyLine[]>();
  for (const l of targetLines) onTarget.set(identity(l), [...(onTarget.get(identity(l)) ?? []), l]);
  const moved = new Map<string, number>();
  const out: CopyLineHandover = { move: [], fold: [] };
  for (const line of copyLines) {
    const k = identity(line);
    const have = (onTarget.get(k)?.length ?? 0) + (moved.get(k) ?? 0);
    const needs = targetDocument.get(k) ?? 0;
    if (have < needs) {
      out.move.push(line.id);
      moved.set(k, (moved.get(k) ?? 0) + 1);
      continue;
    }
    const into = onTarget.get(k)?.[0];
    if (!into) throw new Error(`copy line ${line.id} (${k}) has no line on the real statement to hand its flow to`);
    out.fold.push({ fromLineId: line.id, intoLineId: into.id });
  }
  return out;
}

/** Everything a copy line's flow or its per-line override holds (the report of what a removal would touch). */
export function copyLinesWithAssignments(lines: readonly StoredCopyLine[]): number[] {
  const override = db.prepare(`SELECT 1 FROM cc_expense_line_categories WHERE statement_line_id = ?`);
  return lines.filter((l) => override.get(l.id) != null || (l.flow_id != null && flowHoldsAssignments(l.flow_id, db))).map((l) => l.id);
}

export type DuplicateDownloadCopy = {
  copyStatementId: number;
  targetStatementId: number;
  currency: string;
  /** What the real statement's document states. */
  targetStatement: CardCanonicalStatement;
  targetKey: string;
};

/** Why a copy's flows cannot be handed over (null when they can): a fold whose two flows conflict. */
export function copyHandoverConflict(copy: DuplicateDownloadCopy): string | null {
  const copyLines = storedStatementLines(copy.copyStatementId);
  const plan = planCopyLineHandover(copy.currency, copyLines, storedStatementLines(copy.targetStatementId), documentIdentityCounts(copy.targetStatement));
  const flowOf = new Map(copyLines.map((l) => [l.id, l.flow_id]));
  const targetFlows = new Map(storedStatementLines(copy.targetStatementId).map((l) => [l.id, l.flow_id]));
  for (const f of plan.fold) {
    const a = flowOf.get(f.fromLineId);
    const b = targetFlows.get(f.intoLineId);
    if (a == null || b == null) continue;
    const conflict = mirrorLegFlowsConflict([a, b]);
    if (conflict) return `line ${f.fromLineId} → ${f.intoLineId}: ${conflict.detail}`;
  }
  const override = db.prepare(`SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`);
  for (const f of plan.fold) {
    const from = override.get(f.fromLineId) as { category_id: number } | undefined;
    const into = override.get(f.intoLineId) as { category_id: number } | undefined;
    if (from && into && from.category_id !== into.category_id) {
      return `line ${f.fromLineId} → ${f.intoLineId}: the lines carry different per-line categories`;
    }
  }
  return null;
}

/**
 * After the re-import: every line that moved onto the real statement is still there, on its own
 * flow. The import restates a moved line in place only when its planner pairs it (parser row id,
 * cuota numbers, identity); a line it does not pair is removed and written again as a new row,
 * which would lose what this hand-over exists to keep. Throws, naming the lines.
 */
export function assertMovedLinesSurvive(moved: ReadonlyMap<number, number | null>, targetStatementId: number): void {
  const lost: number[] = [];
  const sel = db.prepare(`SELECT statement_id, flow_id FROM cc_statement_lines WHERE id = ?`);
  for (const [lineId, flowId] of moved) {
    const row = sel.get(lineId) as { statement_id: number; flow_id: number | null } | undefined;
    if (!row || row.statement_id !== targetStatementId || row.flow_id !== flowId) lost.push(lineId);
  }
  if (lost.length > 0) {
    throw new Error(
      `the re-import did not restate moved line(s) ${lost.join(", ")} of statement ${targetStatementId} in place ` +
        `(removed or re-written under another flow); nothing was written`
    );
  }
}

/**
 * Removes the copies of one card and re-imports each real statement, in one card-line write: the
 * copy's lines hand their flows over first ({@link planCopyLineHandover}), the empty copy goes, the
 * statement's import restates the moved lines in place. Converted card payments that had evidence
 * before must still find it, else the write rolls back.
 */
export function removeDuplicateDownloadCopies(accountId: number, copies: readonly DuplicateDownloadCopy[]): StatementDocumentsImportResult {
  return cardLineWrite(accountId, "removing duplicate-download statements", () => {
    const before = ccPaymentPairingIdsWithEvidence(accountId);
    const moved = new Map<number, { statementId: number; flowId: number | null }>();
    for (const copy of copies) {
      const conflict = copyHandoverConflict(copy);
      if (conflict) throw new Error(`statement ${copy.copyStatementId}: ${conflict}`);
      const plan = planCopyLineHandover(
        copy.currency,
        storedStatementLines(copy.copyStatementId),
        storedStatementLines(copy.targetStatementId),
        documentIdentityCounts(copy.targetStatement)
      );
      for (const id of plan.move) {
        const flowId = (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number | null }).flow_id;
        moved.set(id, { statementId: copy.targetStatementId, flowId });
        db.prepare(`UPDATE cc_statement_lines SET statement_id = ? WHERE id = ?`).run(copy.targetStatementId, id);
      }
      applyLinePlan(accountId, "removing duplicate-download statements", { deleteLineIds: [], carry: [], fold: plan.fold });
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(copy.copyStatementId);
    }
    const merged = importStatementDocuments(accountId, copies.map((c) => c.targetStatement), {
      replaceLedger: false,
      replaceStatementKeys: new Set(copies.map((c) => c.targetKey)),
    });
    for (const copy of copies) {
      assertMovedLinesSurvive(
        new Map([...moved].filter(([, m]) => m.statementId === copy.targetStatementId).map(([id, m]) => [id, m.flowId] as const)),
        copy.targetStatementId
      );
    }
    assertCcPaymentEvidenceKept(accountId, before, "removing the duplicate-download statements");
    return merged;
  });
}
