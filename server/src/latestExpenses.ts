/**
 * The home dashboard's «Últimos gastos» table (`GET /api/dashboard/latest-expenses`): the newest
 * expense lines across every source (card, checking, manual, payroll), read from the same lines
 * the Expenses page builds (`buildFlowsExpenseLines`, held by the flows overview's cached inputs:
 * `cachedFlowsExpenseLines`) — no second pipeline.
 *
 * A line is listed when it counts toward gasto del mes in «Total» mode (`countsTowardGastosMes`):
 * a purchase in cuotas shows once, at its whole price on its purchase day, and a refund shows as
 * a negative line in its category. Dated by the purchase day (the movement's day for checking),
 * never after Chile today.
 */
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCcExpenseCategories } from "./ccExpenseCategories.js";
import type { FlowCcExpenseLineRow, FlowCcExpenseLineSource } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines } from "./flowsOverview.js";
import { countsTowardGastosMes, expenseLineGastosAmount, type GastosUnit } from "./flowsExpensesGastos.js";

export const LATEST_EXPENSES_DEFAULT_LIMIT = 15;
export const LATEST_EXPENSES_MAX_LIMIT = 100;

export type LatestExpenseRow = {
  key: string;
  /** ISO day the money was spent. */
  date: string;
  merchant: string | null;
  category_slug: string;
  /** The parent of a subcategory (the client labels «Parent › Child»); null for a top-level one. */
  category_parent_slug: string | null;
  source: FlowCcExpenseLineSource;
  /** Card last4 or account name, as the Expenses page's origin column shows it. */
  origin_label: string;
  /** In the response unit; negative for a refund. */
  amount: number;
  /** Cuota count of a purchase in cuotas, else null. */
  installments: number | null;
};

export type LatestExpensesResponse = {
  unit: GastosUnit;
  rows: LatestExpenseRow[];
};

function lineDate(line: FlowCcExpenseLineRow): string {
  return line.purchase_on ?? line.occurred_on;
}

export function latestExpensesFromLines(
  lines: readonly FlowCcExpenseLineRow[],
  parentSlugByCategory: ReadonlyMap<string, string | null>,
  unit: GastosUnit,
  limit: number,
  todayYmd: string
): LatestExpensesResponse {
  const listed = lines
    .filter((l) => countsTowardGastosMes(l, "total") && lineDate(l) <= todayYmd)
    .sort(
      (a, b) =>
        lineDate(b).localeCompare(lineDate(a)) ||
        b.statement_line_id - a.statement_line_id ||
        (b.piece_seq ?? 0) - (a.piece_seq ?? 0)
    )
    .slice(0, limit);
  const rows = listed.map((l, i): LatestExpenseRow => {
    if (!parentSlugByCategory.has(l.category_slug)) {
      throw new Error(`latest expenses: line ${l.source}:${l.statement_line_id} has unknown category ${l.category_slug}`);
    }
    return {
      key: `${i}:${l.source}:${l.statement_line_id}:${l.purchase_key}`,
      date: lineDate(l),
      merchant: l.merchant,
      category_slug: l.category_slug,
      category_parent_slug: parentSlugByCategory.get(l.category_slug) ?? null,
      source: l.source,
      origin_label: l.origin_label,
      amount: expenseLineGastosAmount(l, unit),
      installments: l.line_role === "installment_purchase_total" ? l.nro_cuota_total : null,
    };
  });
  return { unit, rows };
}

export function buildLatestExpenses(unit: GastosUnit, limit: number): LatestExpensesResponse {
  const parentSlugByCategory = new Map(listCcExpenseCategories().map((c) => [c.slug, c.parent_slug]));
  return latestExpensesFromLines(
    cachedFlowsExpenseLines(),
    parentSlugByCategory,
    unit,
    limit,
    chileCalendarTodayYmd()
  );
}
