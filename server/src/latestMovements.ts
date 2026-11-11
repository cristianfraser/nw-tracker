/**
 * The home dashboard's «Últimos movimientos» table (`GET /api/dashboard/latest-movements`): the
 * newest movements, each on the day it happened. Read from the inputs the flows overview caches —
 * the expense lines the Expenses page builds (`cachedFlowsExpenseLines`) and the income the income
 * page counts (`cachedFlowsIncome`) — so there is no second pipeline.
 *
 * Expense lines: every line the Expenses page lists in «Total» mode, whether it counts toward
 * gastos or not (internal transfers, «no cuenta», deposits, card payments, credit notes and the
 * purchases they annul). A purchase in cuotas shows once, at its whole price on its purchase day
 * (the plan's total line — also a purchase that pays another card's facturado); its cuota lines
 * and the «Por cuota» split lines never show. Payroll deductions are left out.
 *
 * Dates (`movementOn`): a card credit is dated by the day it reached the ledger, never by its
 * printed transaction date, which a bank often sets to the original purchase's day. In order: the
 * day its flow was first seen, else the printed posting date when later than the transaction date,
 * else the statement close (or the transaction date while the close is still ahead: an open
 * facturación's close is a future date). Any other line keeps its purchase day (the movement's day
 * for checking). Nothing after Chile today is listed.
 */
import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import type {
  LatestIncomeMovement,
  LatestMovementRow,
  LatestMovementsResponse,
} from "nw-tracker-contracts/dto/flows";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCcExpenseBigGroups } from "./ccExpenseBigGroups.js";
import { isInstallmentCuotaZeroLine, listCcExpenseCategories } from "./ccExpenseCategories.js";
import { isPreTaxExpenseLine, type FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines, cachedFlowsIncome, type FlowsOverviewIncome } from "./flowsOverview.js";

export const LATEST_MOVEMENTS_DEFAULT_LIMIT = 15;
export const LATEST_MOVEMENTS_MAX_LIMIT = 100;

/** A line the Expenses page lists in «Total» mode (counted or not), cuota lines aside. */
export function listedAsLatestMovement(line: FlowCcExpenseLineRow): boolean {
  if (isPreTaxExpenseLine(line)) return false;
  if (line.line_role === "installment_cuota") return false;
  if (line.gastos_scope === "split_only") return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  return true;
}

/** The day an expense line happened (see the module comment). */
export function movementOn(line: FlowCcExpenseLineRow, todayYmd: string): string {
  const purchaseOn = line.purchase_on ?? line.occurred_on;
  if (line.source !== "cc" || line.amount_clp >= 0) return purchaseOn;
  if (line.first_seen_on) return line.first_seen_on;
  if (line.posting_on && line.posting_on > purchaseOn) return line.posting_on;
  return line.occurred_on <= todayYmd ? line.occurred_on : purchaseOn;
}

function incomeMovements(income: FlowsOverviewIncome): { on: string; income: LatestIncomeMovement; id: number }[] {
  const out: { on: string; income: LatestIncomeMovement; id: number }[] = [];
  for (const l of income.lines) {
    out.push({
      on: l.received_on,
      id: l.movement_id,
      income: {
        key: `checking:${l.movement_id}`,
        source: "checking",
        account_label: l.account_label,
        description: l.description,
        amount_clp: l.amount_clp,
        amount_usd: l.amount_usd,
        income_kind: income.income_kind_by_movement_id[l.movement_id] ?? null,
      },
    });
  }
  for (const m of income.manual) {
    out.push({
      on: m.received_on,
      id: m.id,
      income: {
        key: `manual:${m.id}`,
        source: "manual",
        account_label: null,
        description: m.source ?? m.note ?? "",
        amount_clp: m.amount_clp,
        amount_usd: m.amount_usd,
        income_kind: null,
      },
    });
  }
  return out;
}

export function latestMovementRows(
  lines: readonly FlowCcExpenseLineRow[],
  income: FlowsOverviewIncome,
  knownCategories: ReadonlySet<string>,
  limit: number,
  todayYmd: string
): LatestMovementRow[] {
  type Ranked = { row: LatestMovementRow; tie: number };
  const ranked: Ranked[] = [];
  for (const line of lines) {
    if (!listedAsLatestMovement(line)) continue;
    const on = movementOn(line, todayYmd);
    if (on > todayYmd) continue;
    ranked.push({ row: { kind: "expense", on, line }, tie: line.statement_line_id * 1000 + (line.piece_seq ?? 0) });
  }
  for (const m of incomeMovements(income)) {
    if (m.on > todayYmd) continue;
    ranked.push({ row: { kind: "income", on: m.on, income: m.income }, tie: m.id * 1000 });
  }
  ranked.sort((a, b) => b.row.on.localeCompare(a.row.on) || b.tie - a.tie);
  const rows = ranked.slice(0, limit).map((r) => r.row);
  for (const r of rows) {
    if (r.kind === "expense" && !knownCategories.has(r.line.category_slug)) {
      throw new Error(
        `latest movements: line ${r.line.source}:${r.line.statement_line_id} has unknown category ${r.line.category_slug}`
      );
    }
  }
  return rows;
}

export function buildLatestMovements(limit: number): LatestMovementsResponse {
  const categories = listCcExpenseCategories();
  return {
    schema_version: DTO_SCHEMA_VERSIONS.latest_movements,
    rows: latestMovementRows(
      cachedFlowsExpenseLines(),
      cachedFlowsIncome(),
      new Set(categories.map((c) => c.slug)),
      limit,
      chileCalendarTodayYmd()
    ),
    categories,
    big_groups: listCcExpenseBigGroups(),
  };
}
