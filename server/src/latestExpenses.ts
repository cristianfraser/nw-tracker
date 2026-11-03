/**
 * The home dashboard's «Últimos gastos» table (`GET /api/dashboard/latest-expenses`): the newest
 * expense lines across every source (card, checking, manual, payroll), read from the same lines
 * the Expenses page builds (`buildFlowsExpenseLines`, held by the flows overview's cached inputs:
 * `cachedFlowsExpenseLines`) — no second pipeline. The lines go out whole, with the categories
 * and big groups, so the panel draws them with the Expenses page's own row.
 *
 * A line is listed when it counts toward gasto del mes in «Total» mode (`countsTowardGastosMes`):
 * a purchase in cuotas shows once, at its whole price on its purchase day, and a refund shows as
 * a negative line in its category. Dated by the purchase day (the movement's day for checking),
 * never after Chile today.
 */
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCcExpenseBigGroups, type CcExpenseBigGroupRow } from "./ccExpenseBigGroups.js";
import { listCcExpenseCategories, type CcExpenseCategoryRow } from "./ccExpenseCategories.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines } from "./flowsOverview.js";
import { countsTowardGastosMes } from "./flowsExpensesGastos.js";

export const LATEST_EXPENSES_DEFAULT_LIMIT = 15;
export const LATEST_EXPENSES_MAX_LIMIT = 100;

export type LatestExpensesResponse = {
  /** Newest first. */
  lines: FlowCcExpenseLineRow[];
  categories: CcExpenseCategoryRow[];
  big_groups: CcExpenseBigGroupRow[];
};

function lineDate(line: FlowCcExpenseLineRow): string {
  return line.purchase_on ?? line.occurred_on;
}

export function latestExpenseLines(
  lines: readonly FlowCcExpenseLineRow[],
  knownCategories: ReadonlySet<string>,
  limit: number,
  todayYmd: string
): FlowCcExpenseLineRow[] {
  const listed = lines
    .filter((l) => countsTowardGastosMes(l, "total") && lineDate(l) <= todayYmd)
    .sort(
      (a, b) =>
        lineDate(b).localeCompare(lineDate(a)) ||
        b.statement_line_id - a.statement_line_id ||
        (b.piece_seq ?? 0) - (a.piece_seq ?? 0)
    )
    .slice(0, limit);
  for (const l of listed) {
    if (!knownCategories.has(l.category_slug)) {
      throw new Error(`latest expenses: line ${l.source}:${l.statement_line_id} has unknown category ${l.category_slug}`);
    }
  }
  return listed;
}

export function buildLatestExpenses(limit: number): LatestExpensesResponse {
  const categories = listCcExpenseCategories();
  return {
    lines: latestExpenseLines(
      cachedFlowsExpenseLines(),
      new Set(categories.map((c) => c.slug)),
      limit,
      chileCalendarTodayYmd()
    ),
    categories,
    big_groups: listCcExpenseBigGroups(),
  };
}
