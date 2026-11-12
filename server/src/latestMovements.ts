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
  LineUnitValue,
  Money,
} from "nw-tracker-contracts/dto/flows";
import { listDollarCheckingAccountIds } from "./checkingCartolaLoaders.js";
import { lineAmount } from "./lineMoney.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";
import { cardPaymentEvidence, latestCardPayment, loadCardPaymentTransfers, type CardPaymentTransfer } from "./latestCardPayments.js";
import { isPaymentLine } from "./expensePaymentNames.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { listCcExpenseBigGroups } from "./ccExpenseBigGroups.js";
import { isInstallmentCuotaZeroLine, listCcExpenseCategories } from "./ccExpenseCategories.js";
import { isPreTaxExpenseLine, type FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cachedFlowsExpenseLines, cachedFlowsIncome, type FlowsOverviewIncome } from "./flowsOverview.js";

export const LATEST_MOVEMENTS_DEFAULT_LIMIT = 15;
export const LATEST_MOVEMENTS_MAX_LIMIT = 100;

/** A line the Expenses page lists in «Total» mode (counted or not), cuota lines aside. */
export function listedAsLatestMovement(
  line: Pick<FlowCcExpenseLineRow, "source" | "line_role" | "gastos_scope" | "installment_flag" | "nro_cuota_current">
): boolean {
  if (isPreTaxExpenseLine(line)) return false;
  if (line.line_role === "installment_cuota") return false;
  if (line.gastos_scope === "split_only") return false;
  if (isInstallmentCuotaZeroLine(line)) return false;
  return true;
}

/** The day an expense line happened (see the module comment). */
export function movementOn(
  line: Pick<FlowCcExpenseLineRow, "source" | "purchase_on" | "occurred_on" | "first_seen_on" | "posting_on" | "amount">,
  todayYmd: string
): string {
  const purchaseOn = line.purchase_on ?? line.occurred_on;
  if (line.source !== "cc" || lineAmount(line).value >= 0) return purchaseOn;
  if (line.first_seen_on) return line.first_seen_on;
  if (line.posting_on && line.posting_on > purchaseOn) return line.posting_on;
  return line.occurred_on <= todayYmd ? line.occurred_on : purchaseOn;
}

/**
 * An income credit's money: a dollar checking account's credit is in dollars (its pesos at the
 * day's rate), any other in pesos (its dollars at the day's rate, when the day has one).
 */
function incomeMoney(
  amountClp: number,
  amountUsd: number | null,
  inDollars: boolean,
  key: string
): { amount: Money; values: Record<string, LineUnitValue> } {
  if (inDollars) {
    if (amountUsd == null) throw new Error(`latest movements: dollar income ${key} without its dollars`);
    return {
      amount: { value: amountUsd, currency: "usd" },
      values: { clp: { value: amountClp, rate_source: "day" }, usd: { value: amountUsd, rate_source: "native" } },
    };
  }
  const values: Record<string, LineUnitValue> = { clp: { value: amountClp, rate_source: "native" } };
  if (amountUsd != null) values.usd = { value: amountUsd, rate_source: "day" };
  return { amount: { value: amountClp, currency: "clp" }, values };
}

function incomeMovements(
  income: FlowsOverviewIncome,
  dollarAccountIds: ReadonlySet<number>
): { on: string; income: LatestIncomeMovement; id: number }[] {
  const out: { on: string; income: LatestIncomeMovement; id: number }[] = [];
  for (const l of income.lines) {
    const key = `checking:${l.movement_id}`;
    out.push({
      on: l.received_on,
      id: l.movement_id,
      income: {
        key,
        source: "checking",
        account_label: l.account_label,
        description: l.description,
        ...incomeMoney(l.amount_clp, l.amount_usd, dollarAccountIds.has(l.account_id), key),
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
        ...incomeMoney(m.amount_clp, m.amount_usd, false, `manual:${m.id}`),
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
  todayYmd: string,
  /** The dollar checking accounts (`listDollarCheckingAccountIds`): their income is in dollars. */
  dollarAccountIds: ReadonlySet<number>,
  /** The card payments (`loadCardPaymentTransfers`): each one row, its evidence lines folded in. */
  cardPayments: readonly CardPaymentTransfer[] = []
): LatestMovementRow[] {
  type Ranked = { row: LatestMovementRow; tie: number };
  const ranked: Ranked[] = [];
  const evidence = cardPaymentEvidence(cardPayments, lines, (l) => isPaymentLine(l as never));
  const evidenceIdx = new Set([...evidence.values()].flat());
  for (const t of cardPayments) {
    if (t.occurred_on > todayYmd) continue;
    const own = evidence.get(t.movement_id)!.map((i) => toWireExpenseLine(lines[i]!));
    ranked.push({ row: { kind: "card_payment", on: t.occurred_on, payment: latestCardPayment(t, own) }, tie: t.movement_id * 1000 });
  }
  for (const [i, line] of lines.entries()) {
    if (evidenceIdx.has(i)) continue;
    if (!listedAsLatestMovement(line)) continue;
    const on = movementOn(line, todayYmd);
    if (on > todayYmd) continue;
    ranked.push({ row: { kind: "expense", on, line: toWireExpenseLine(line) }, tie: line.statement_line_id * 1000 + (line.piece_seq ?? 0) });
  }
  for (const m of incomeMovements(income, dollarAccountIds)) {
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
      chileCalendarTodayYmd(),
      new Set(listDollarCheckingAccountIds()),
      loadCardPaymentTransfers()
    ),
    categories,
    big_groups: listCcExpenseBigGroups(),
  };
}
