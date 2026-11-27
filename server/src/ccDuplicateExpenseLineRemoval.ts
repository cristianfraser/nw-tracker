/**
 * Display-duplicate card lines (re-imported PDFs, mixed date formats) removed for good: each
 * duplicate folds into the kept twin the display dedupe stands for it, so the earlier arrival and
 * what was filed on either line survive on the line that stays.
 */
import { applyLinePlan } from "./cards/lineWrites.js";
import { dedupeFlowCcExpenseLinesWithTwins, type CcExpenseLineForDedupe } from "./ccExpenseLineDedupe.js";

export type DuplicateExpenseLinePlan = {
  folds: { accountId: number; fromLineId: number; intoLineId: number }[];
  /** Duplicates of a synthetic line (a plan's cuota) that no stored line stands for: left alone. */
  unfoldable: number[];
};

/** Which stored lines the display dedupe drops, each paired with the kept line it folds into. */
export function planDuplicateExpenseLineFolds(raw: readonly CcExpenseLineForDedupe[]): DuplicateExpenseLinePlan {
  const { twins } = dedupeFlowCcExpenseLinesWithTwins(raw);
  const accountOf = new Map(raw.map((l) => [l.statement_line_id, l.account_id]));
  const folds: DuplicateExpenseLinePlan["folds"] = [];
  const unfoldable: number[] = [];
  for (const [from, into] of twins) {
    if (from <= 0) continue; // not a stored line: nothing to delete
    if (into <= 0) {
      unfoldable.push(from);
      continue;
    }
    folds.push({ accountId: accountOf.get(from)!, fromLineId: from, intoLineId: into });
  }
  return { folds, unfoldable };
}

/** Applies the folds through the card-line write funnel, one write per card; returns the lines removed. */
export function removeDuplicateExpenseLines(folds: DuplicateExpenseLinePlan["folds"]): number {
  const accounts = [...new Set(folds.map((f) => f.accountId))];
  let removed = 0;
  for (const accountId of accounts) {
    const own = folds.filter((f) => f.accountId === accountId);
    removed += applyLinePlan(accountId, "removing duplicate expense lines", {
      deleteLineIds: [],
      carry: [],
      fold: own.map((f) => ({ fromLineId: f.fromLineId, intoLineId: f.intoLineId })),
    });
  }
  return removed;
}
