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
import { listForeignCheckingAccountIds } from "./checkingCartolaLoaders.js";
import { lineAmount, lineConvertedForWire } from "./lineMoney.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";
import { cardPaymentEvidence, latestCardPayment, loadCardPaymentTransfers, type CardPaymentTransfer } from "./latestCardPayments.js";
import { isPaymentLine } from "./expensePaymentNames.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { checkingMovementDisplayNames, loadDisplayNameContext } from "./expenseDisplayNames.js";
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
 * An income credit's money: a foreign checking account's credit is in its currency (its pesos and
 * dollars at the day's rate; a dollar one's dollars its own), any other in pesos (its dollars at
 * the day's rate, when the day has one).
 */
function incomeMoney(
  amountClp: number,
  amountUsd: number | null,
  inDollars: boolean,
  key: string,
  native?: { currency: string; amount: number }
): { amount: Money; values: Record<string, LineUnitValue> } {
  if (native != null) {
    const values: Record<string, LineUnitValue> = { clp: { value: amountClp, rate_source: "day" } };
    if (amountUsd != null) values.usd = { value: amountUsd, rate_source: "day" };
    return { amount: { value: native.amount, currency: native.currency }, values };
  }
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

/** An income credit's money in the requested unit: its own amount and `converted`. */
function incomeMoneyIn(
  amountClp: number,
  amountUsd: number | null,
  inDollars: boolean,
  key: string,
  receivedOn: string,
  unit: string,
  native?: { currency: string; amount: number }
): Pick<LatestIncomeMovement, "amount" | "converted"> {
  const m = incomeMoney(amountClp, amountUsd, inDollars, key, native);
  return { amount: m.amount, converted: lineConvertedForWire({ ...m, occurred_on: receivedOn }, unit) };
}

/** A checking credit's payer as the mail names it and the name the row shows (`checkingMovementDisplayNames`). */
export type IncomeCreditNames = (
  movementId: number,
  accountId: number,
  description: string
) => Pick<LatestIncomeMovement, "transfer_counterparty" | "display_merchant" | "link_label">;

function incomeMovements(
  income: FlowsOverviewIncome,
  foreignAccountIds: ReadonlySet<number>,
  unit: string,
  names: IncomeCreditNames | undefined
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
        ...incomeMoneyIn(l.amount_clp, l.amount_usd, foreignAccountIds.has(l.account_id), key, l.received_on, unit, l.native),
        income_kind: income.income_kind_by_movement_id[l.movement_id] ?? null,
        ...(names ? names(l.movement_id, l.account_id, l.description) : {}),
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
        ...incomeMoneyIn(m.amount_clp, m.amount_usd, false, `manual:${m.id}`, m.received_on, unit),
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
  /** The foreign checking accounts (`listForeignCheckingAccountIds`): their income is in their currency. */
  foreignAccountIds: ReadonlySet<number>,
  /** The card payments (`loadCardPaymentTransfers`): each one row, its evidence lines folded in. */
  cardPayments: readonly CardPaymentTransfer[] = [],
  /** The display unit every row's `converted` is in. */
  unit: string = "clp",
  /** Each checking credit's payer and shown name; none = the bank's description alone. */
  incomeNames?: IncomeCreditNames
): LatestMovementRow[] {
  type Ranked = { row: LatestMovementRow; tie: number };
  const ranked: Ranked[] = [];
  const evidence = cardPaymentEvidence(cardPayments, lines, (l) => isPaymentLine(l as never));
  const evidenceIdx = new Set([...evidence.values()].flat());
  for (const t of cardPayments) {
    if (t.occurred_on > todayYmd) continue;
    const ownIdx = evidence.get(t.movement_id)!;
    const own = ownIdx.map((i) => toWireExpenseLine(lines[i]!, unit));
    const payment = latestCardPayment(t, own, unit, ownIdx.map((i) => lines[i]!));
    ranked.push({ row: { kind: "card_payment", on: t.occurred_on, payment }, tie: t.movement_id * 1000 });
  }
  for (const [i, line] of lines.entries()) {
    if (evidenceIdx.has(i)) continue;
    if (!listedAsLatestMovement(line)) continue;
    const on = movementOn(line, todayYmd);
    if (on > todayYmd) continue;
    ranked.push({ row: { kind: "expense", on, line: toWireExpenseLine(line, unit) }, tie: line.statement_line_id * 1000 + (line.piece_seq ?? 0) });
  }
  for (const m of incomeMovements(income, foreignAccountIds, unit, incomeNames)) {
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

/** The live names of checking credits: their mail's counterparty, through the vendor catalog. */
function checkingCreditNames(): IncomeCreditNames {
  const counterparties = transferCounterpartiesByMovementSide();
  const ctx = loadDisplayNameContext([]);
  return (movementId, accountId, description) => {
    const counterparty = counterparties.get(`${movementId}|${accountId}`);
    const names = checkingMovementDisplayNames(description, accountId, counterparty, ctx);
    return {
      ...(counterparty ? { transfer_counterparty: counterparty } : {}),
      ...(names.display_merchant ? { display_merchant: names.display_merchant } : {}),
      ...(names.link_label ? { link_label: names.link_label } : {}),
    };
  };
}

export function buildLatestMovements(limit: number, unit: string = "clp"): LatestMovementsResponse {
  const categories = listCcExpenseCategories();
  return {
    schema_version: DTO_SCHEMA_VERSIONS.latest_movements,
    rows: latestMovementRows(
      cachedFlowsExpenseLines(),
      cachedFlowsIncome(),
      new Set(categories.map((c) => c.slug)),
      limit,
      chileCalendarTodayYmd(),
      new Set(listForeignCheckingAccountIds()),
      loadCardPaymentTransfers(),
      unit,
      checkingCreditNames()
    ),
    categories,
    big_groups: listCcExpenseBigGroups(),
  };
}
