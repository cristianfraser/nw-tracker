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
import { lineConvertedForWire } from "./lineMoney.js";
import { movementOn } from "./expenseLineDay.js";
import { toWireExpenseLine } from "./wireExpenseLine.js";
import { cardPaymentEvidence, latestCardPayment, loadCardPaymentTransfers, type CardPaymentTransfer } from "./latestCardPayments.js";
import { isPaymentLine } from "./expensePaymentNames.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  arrivalBatchOf,
  compareLatestRowOrderKeys,
  happenedEstimateMs,
  type ArrivalBatch,
  type LatestRowOrderKey,
  type LatestRowRef,
  type LatestRowSources,
  type LatestWriteStamp,
} from "./latestMovementOrder.js";
import { latestRowSources } from "./latestMovementTimes.js";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { checkingMovementShownName, loadDisplayNameContext } from "./expenseDisplayNames.js";
import { textShownName } from "./expenseShownName.js";
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

/** A checking credit's payer as the mail names it and the name the row shows (`checkingMovementShownName`). */
export type IncomeCreditNames = (
  movementId: number,
  accountId: number,
  description: string
) => Pick<LatestIncomeMovement, "transfer_counterparty" | "name" | "name_detail" | "link_label">;

function incomeMovements(
  income: FlowsOverviewIncome,
  foreignAccountIds: ReadonlySet<number>,
  unit: string,
  names: IncomeCreditNames | undefined
): { on: string; income: LatestIncomeMovement; id: number; accountId: number | null }[] {
  const out: { on: string; income: LatestIncomeMovement; id: number; accountId: number | null }[] = [];
  for (const l of income.lines) {
    const key = `checking:${l.movement_id}`;
    out.push({
      on: l.received_on,
      id: l.movement_id,
      accountId: l.account_id,
      income: {
        key,
        source: "checking",
        account_label: l.account_label,
        ...incomeMoneyIn(l.amount_clp, l.amount_usd, foreignAccountIds.has(l.account_id), key, l.received_on, unit, l.native),
        income_kind: income.income_kind_by_movement_id[l.movement_id] ?? null,
        ...(names ? names(l.movement_id, l.account_id, l.description) : { name: textShownName(l.description) }),
      },
    });
  }
  for (const m of income.manual) {
    out.push({
      on: m.received_on,
      id: m.id,
      accountId: null,
      income: {
        key: `manual:${m.id}`,
        source: "manual",
        account_label: null,
        name: textShownName(manualIncomeName(m)),
        ...incomeMoneyIn(m.amount_clp, m.amount_usd, false, `manual:${m.id}`, m.received_on, unit),
        income_kind: null,
      },
    });
  }
  return out;
}

/** A hand-entered income's name: its source, else its note (an entry has one or the other). */
function manualIncomeName(m: { id: number; source: string | null; note: string | null }): string {
  const name = m.source?.trim() || m.note?.trim();
  if (!name) throw new Error(`manual income ${m.id} has neither a source nor a note`);
  return name;
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
  incomeNames?: IncomeCreditNames,
  /** The rows' arrival and moments (`latestMovementOrder.ts`); none = by day, then id. */
  sources?: LatestRowSources
): LatestMovementRow[] {
  type Ranked = { row: LatestMovementRow; ref: LatestRowRef; tie: number };
  const ranked: Ranked[] = [];
  const evidence = cardPaymentEvidence(cardPayments, lines, (l) => isPaymentLine(l as never));
  const evidenceIdx = new Set([...evidence.values()].flat());
  for (const t of cardPayments) {
    if (t.occurred_on > todayYmd) continue;
    const ownIdx = evidence.get(t.movement_id)!;
    const own = ownIdx.map((i) => toWireExpenseLine(lines[i]!, unit));
    const payment = latestCardPayment(t, own, unit, ownIdx.map((i) => lines[i]!));
    ranked.push({
      row: { kind: "card_payment", on: t.occurred_on, payment, arrival_key: payment.key },
      // The money left the paying account: its transfer mail names that side.
      ref: { kind: "movement", movementId: t.movement_id, accountId: t.from_account_id },
      tie: t.movement_id * 1000,
    });
  }
  for (const [i, line] of lines.entries()) {
    if (evidenceIdx.has(i)) continue;
    if (!listedAsLatestMovement(line)) continue;
    const on = movementOn(line, todayYmd);
    if (on > todayYmd) continue;
    ranked.push({
      row: { kind: "expense", on, line: toWireExpenseLine(line, unit), arrival_key: `line:${line.source}-${line.statement_line_id}-${line.purchase_key}` },
      ref: { kind: "line", line },
      tie: line.statement_line_id * 1000 + (line.piece_seq ?? 0),
    });
  }
  for (const m of incomeMovements(income, foreignAccountIds, unit, incomeNames)) {
    if (m.on > todayYmd) continue;
    ranked.push({
      row: { kind: "income", on: m.on, income: m.income, arrival_key: m.income.key },
      ref: m.accountId != null ? { kind: "movement", movementId: m.id, accountId: m.accountId } : { kind: "none" },
      tie: m.id * 1000,
    });
  }
  // Newest arrival first (`latestMovementOrder.ts`): the batches the list reaches are resolved and
  // put in order by moment; rows with no write stamp follow, by day.
  const stamps = sources ? sources.stamps(ranked.map((r) => r.ref)) : ranked.map(() => null);
  const stamped: (Ranked & { stamp: LatestWriteStamp; batch: ArrivalBatch })[] = [];
  const unstamped: (Ranked & { key: LatestRowOrderKey })[] = [];
  ranked.forEach((r, i) => {
    const stamp = stamps[i];
    if (stamp && sources) stamped.push({ ...r, stamp, batch: arrivalBatchOf(stamp.atMs, sources.runs) });
    else unstamped.push({ ...r, key: { stamped: false, on: r.row.on } });
  });
  stamped.sort((a, b) => b.batch.atMs - a.batch.atMs);
  const lastBatchAt = stamped[Math.min(limit, stamped.length) - 1]?.batch.atMs;
  const reached = lastBatchAt === undefined ? [] : stamped.filter((r) => r.batch.atMs >= lastBatchAt);
  const times = sources && reached.length > 0 ? sources.times(reached.map((r) => r.ref)) : [];
  const keyed = [
    ...reached.map((r, i) => ({
      ...r,
      key: {
        stamped: true,
        batchAtMs: r.batch.atMs,
        happenedMs: happenedEstimateMs(times[i]!, r.stamp, r.batch),
        seq: r.stamp.seq,
      } as LatestRowOrderKey,
    })),
    ...(reached.length < limit ? unstamped : []),
  ];
  keyed.sort((a, b) => compareLatestRowOrderKeys(a.key, b.key) || b.tie - a.tie);
  const shownRows = keyed.slice(0, limit);
  // A row is the same row for as long as its flow lives (a re-import, a cartola replacing the daily
  // row, a payment conversion keep it).
  const flows = sources ? sources.flows(shownRows.map((r) => r.ref)) : [];
  const rows = shownRows.map((r, i): LatestMovementRow => {
    const flowId = flows[i];
    return flowId == null ? r.row : { ...r.row, arrival_key: `flow:${flowId}` };
  });
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
    return {
      ...(counterparty ? { transfer_counterparty: counterparty } : {}),
      ...checkingMovementShownName(description, accountId, counterparty, ctx, `income credit ${movementId}`),
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
      checkingCreditNames(),
      latestRowSources()
    ),
    categories,
    big_groups: listCcExpenseBigGroups(),
  };
}
