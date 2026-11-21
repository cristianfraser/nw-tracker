/**
 * The checking account page (cuenta corriente / cuenta vista): its head (`CheckingGlanceDto`: today's
 * balance and the balance strip) and its statement (`CheckingStatementResponse`: every movement
 * newest first with the balance after it, grouped by month, each month opening and closing).
 *
 * One walk of the ledger feeds both, with the balance reader's accounting (`accountFlowRows` →
 * `signedClpDeltaForAccountMovement`, transfer legs included): a row the bank dates after today counts
 * today (`displayLedgerCutoffYmd`) and is listed under today. The walk's end must equal the balance the
 * rest of the app shows (`checkingMovementBalanceLive`), or this throws. The ledger anchor (the opening
 * balance carrier) is the statement's first line, not a movement of its month.
 *
 * Amounts are the account's own pesos: a checking ledger is a document in its coin.
 */
import {
  addCalendarMonths,
  addDaysIso,
  daysBetweenIso,
  monthEndUtcYmd,
  ymCompare,
} from "nw-tracker-contracts";
import type {
  CheckingBalanceStripDto,
  CheckingGlanceDto,
  CheckingMonthReconciliation,
  CheckingStatementKindFilter,
  CheckingStatementMonthDto,
  CheckingStatementResponse,
  CheckingStatementRowDto,
  CheckingStatementRowKind,
  CheckingStatementVendorDto,
  CheckingStripRange,
} from "nw-tracker-contracts/dto/accounts";
import { HOME_CURRENCY } from "./displayUnits.js";
import { accountFlowRows, type FlowsApiRow } from "./flowsApi.js";
import { checkingMovementBalanceAtMonthEnd, checkingMovementBalanceLive, isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { loadCartolaImportsByMonth } from "./checkingCartolaMonthSummary.js";
import { cachedFlowsIncome } from "./flowsOverview.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { checkingMovementShownName, checkingTransferParty, loadDisplayNameContext } from "./expenseDisplayNames.js";
import { shownNameSearchText } from "./expenseShownName.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";
import { listMovementRowsForAccount, signedClpDeltaForAccountMovement } from "./movementTransfer.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

/** The account kinds whose page is the checking page. */
export const CHECKING_PAGE_KIND_SLUGS: ReadonlySet<string> = new Set(["cuenta_corriente", "cuenta_vista"]);

/** A statement page reads whole months, newest first, until it holds at least this many rows. */
const STATEMENT_PAGE_MIN_ROWS = 40;

type LedgerRow = {
  row: CheckingStatementRowDto;
  /** The day the row counts on: its own, or today for a row the bank dates later. */
  on: string;
  /** Searchable text: description, account name, stored note, type label. */
  haystack: string;
};

type Ledger = {
  currency: string;
  today: string;
  /** Oldest first (the walk's order). */
  rows: LedgerRow[];
  opening: { occurred_on: string; amount: number } | null;
  balance: number;
};

const postingsStmt = db.prepare(
  `SELECT movement_id, posted_on FROM movement_bank_postings WHERE account_id = ?`
);

function rowKind(r: FlowsApiRow, incomeIds: ReadonlySet<number>): CheckingStatementRowKind {
  if (r.flow_kind === "cash_fee") return "fee";
  if (r.counterpart_account_id != null && r.from_account_id != null) {
    return r.flow_kind === "pago_tarjeta" || kindSlugForAccount(r.counterpart_account_id) === "credit_card"
      ? "card_payment"
      : "own_transfer";
  }
  return incomeIds.has(r.id) ? "income" : "other";
}

/** The ledger of a checking page account, oldest first, each row with the balance after it. */
function loadLedger(accountId: number): Ledger {
  const kind = kindSlugForAccount(accountId);
  if (kind == null || !CHECKING_PAGE_KIND_SLUGS.has(kind)) {
    throw new Error(`checking statement: account ${accountId} is not a cuenta corriente / cuenta vista (${kind})`);
  }
  // A cartola checking account is a peso ledger by its kind (its balance reader signs the peso leg).
  const currency = HOME_CURRENCY;
  const flows = accountFlowRows(accountId);
  if (flows == null) throw new Error(`checking statement: account ${accountId} not found`);
  const today = chileCalendarTodayYmd();
  const postedOn = new Map(
    (postingsStmt.all(accountId) as { movement_id: number; posted_on: string }[]).map((p) => [p.movement_id, p.posted_on])
  );
  const income = cachedFlowsIncome();
  const incomeIds = new Set(income.lines.filter((l) => l.account_id === accountId).map((l) => l.movement_id));

  const ordered = [...flows].sort((a, b) => {
    const da = a.occurred_on > today ? today : a.occurred_on;
    const dbb = b.occurred_on > today ? today : b.occurred_on;
    return da < dbb ? -1 : da > dbb ? 1 : a.id - b.id;
  });

  // Each row moves the account by its peso leg, signed for this account: the balance reader's
  // accounting, so a currency exchange (a dollar leg with a peso counter leg) counts its pesos.
  const pesoDelta = new Map(
    listMovementRowsForAccount(accountId).map((m) => [m.id!, signedClpDeltaForAccountMovement(m, accountId)])
  );

  // A bank movement's names: the expense rows' own rule (catalog, counterparty from a transfer mail).
  const counterparties = transferCounterpartiesByMovementSide();
  const nameContext = loadDisplayNameContext([]);

  let balance = 0;
  let opening: Ledger["opening"] = null;
  const rows: LedgerRow[] = [];
  for (const r of ordered) {
    const amount = pesoDelta.get(r.id);
    if (amount == null) throw new Error(`checking statement: movement ${r.id} on account ${accountId} has no ledger row`);
    balance += amount;
    if (isCheckingLedgerAnchorNote(r.note)) {
      if (rows.length > 0 || opening != null) {
        throw new Error(`checking statement: account ${accountId}'s ledger anchor ${r.id} is not its first movement`);
      }
      opening = { occurred_on: r.occurred_on, amount };
      continue;
    }
    const kind = rowKind(r, incomeIds);
    const transfer = r.counterpart_account_id != null && r.from_account_id != null;
    const posted = postedOn.get(r.id);
    let vendor: CheckingStatementVendorDto | null = null;
    let party: CheckingStatementRowDto["party"] = null;
    if (!transfer) {
      const merchant = cartolaDescriptionFromNote(r.note);
      const counterparty = counterparties.get(`${r.id}|${accountId}`);
      vendor = {
        ...checkingMovementShownName(merchant, accountId, counterparty, nameContext, `movement ${r.id}`),
        ...(counterparty ? { transfer_counterparty: counterparty } : {}),
      };
      const found = checkingTransferParty({ merchant, transfer_counterparty: counterparty }, nameContext);
      party = found ? { direction: found.direction, label: found.label } : null;
    }
    rows.push({
      on: r.occurred_on > today ? today : r.occurred_on,
      haystack: [
        vendor ? shownNameSearchText(vendor.name) : null,
        vendor?.name_detail?.bank_text,
        vendor?.link_label?.text,
        vendor?.transfer_counterparty?.name,
        party?.label,
        r.note,
        r.counterpart_account_name,
        r.flow_type_label,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase(),
      row: {
        movement_id: r.id,
        occurred_on: r.occurred_on,
        posted_on: posted != null && posted !== r.occurred_on ? posted : null,
        forward_posted: r.forward_posted,
        kind,
        income_kind: kind === "income" ? (income.income_kind_by_movement_id[r.id] ?? null) : null,
        vendor,
        party,
        type_label: r.flow_type_label,
        counterpart: transfer
          ? {
              account_id: r.counterpart_account_id!,
              name: r.counterpart_account_name ?? "",
              direction: r.transfer_direction === "in" ? "in" : "out",
            }
          : null,
        amount,
        balance_after: Math.round(balance),
      },
    });
  }
  const live = checkingMovementBalanceLive(accountId).value_clp;
  if (Math.round(balance) !== live) {
    throw new Error(`checking statement: account ${accountId}'s walk ends at ${Math.round(balance)}, the balance reads ${live}`);
  }
  return { currency, today, rows, opening, balance: live };
}

/** End-of-day balance on `day`: the last row on or before it (rows oldest first), else the opening, else 0. */
function makeEndOfDay(ledger: Ledger): (day: string) => number {
  const days: string[] = [];
  const values: number[] = [];
  for (const { on, row } of ledger.rows) {
    if (days.length > 0 && days[days.length - 1] === on) values[values.length - 1] = row.balance_after;
    else {
      days.push(on);
      values.push(row.balance_after);
    }
  }
  const before = ledger.opening != null ? Math.round(ledger.opening.amount) : 0;
  return (day) => {
    let lo = 0;
    let hi = days.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid]! <= day) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return hit >= 0 ? values[hit]! : before;
  };
}

const STRIP_RANGES: readonly CheckingStripRange[] = ["90d", "1y", "5y", "total"];

function stripFrom(range: CheckingStripRange, today: string, firstDay: string): string {
  const from =
    range === "90d"
      ? addDaysIso(today, -89)
      : range === "1y"
        ? addDaysIso(today, -365)
        : range === "5y"
          ? addDaysIso(today, -5 * 365 - 1)
          : firstDay;
  return from < firstDay ? firstDay : from;
}

function buildStrip(
  range: CheckingStripRange,
  ledger: Ledger,
  endOfDay: (day: string) => number,
  firstDay: string
): CheckingBalanceStripDto {
  const to = ledger.today;
  const from = stripFrom(range, to, firstDay);
  const span = Math.max(1, daysBetweenIso(from, to));
  const raw: { date: string; balance: number }[] = [{ date: from, balance: endOfDay(from) }];
  for (const { on, row } of ledger.rows) {
    if (on <= from) continue;
    const last = raw[raw.length - 1]!;
    if (last.date === on) last.balance = row.balance_after;
    else raw.push({ date: on, balance: row.balance_after });
  }
  const last = raw[raw.length - 1]!;
  if (last.date !== to) raw.push({ date: to, balance: last.balance });
  const low = Math.min(...raw.map((p) => p.balance));
  const high = Math.max(...raw.map((p) => p.balance));
  const yMin = Math.min(0, low);
  const yMax = Math.max(0, high);
  const yOf = (v: number) => (yMax === yMin ? 0 : (v - yMin) / (yMax - yMin));
  const xOf = (d: string) => Math.min(1, Math.max(0, daysBetweenIso(from, d) / span));
  const months: CheckingBalanceStripDto["months"] = [];
  for (let ym = from.slice(0, 7); ymCompare(ym, to.slice(0, 7)) <= 0; ym = addCalendarMonths(ym, 1)) {
    const start = `${ym}-01` < from ? from : `${ym}-01`;
    const end = monthEndUtcYmd(ym) > to ? to : addDaysIso(monthEndUtcYmd(ym), 1);
    months.push({ period_month: ym, x0: xOf(start), x1: xOf(end) });
  }
  return {
    range,
    from,
    to,
    low,
    high,
    zero_y: yOf(0),
    points: raw.map((p) => ({ date: p.date, balance: p.balance, x: xOf(p.date), y: yOf(p.balance) })),
    months,
    label_every: months.length > 15 ? "year" : "month",
  };
}

/** The checking page's head; null when the account is not a checking page account. */
export function buildCheckingGlanceForAccount(accountId: number): CheckingGlanceDto | null {
  const kind = kindSlugForAccount(accountId);
  if (kind == null || !CHECKING_PAGE_KIND_SLUGS.has(kind)) return null;
  const ledger = loadLedger(accountId);
  const endOfDay = makeEndOfDay(ledger);
  const today = ledger.today;
  const firstDay = ledger.opening?.occurred_on ?? ledger.rows[0]?.on ?? today;
  return {
    currency: ledger.currency,
    balance: ledger.balance,
    as_of: today,
    strips: STRIP_RANGES.map((r) => buildStrip(r, ledger, endOfDay, firstDay)),
  };
}

export type CheckingStatementQuery = {
  /** Only months before this one (YYYY-MM); absent = from today's month. */
  before?: string;
  kind?: CheckingStatementKindFilter;
  /** Text in the description, account, note or type; or, all digits once «$ . ,» are dropped, the exact amount. */
  q?: string;
  /** Leave out transfers between own accounts. */
  hideOwn?: boolean;
};

function rowMatches(r: LedgerRow, query: CheckingStatementQuery): boolean {
  const kind = r.row.kind;
  if (query.hideOwn && kind === "own_transfer") return false;
  if (query.kind && kind !== query.kind) return false;
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const digits = q.replace(/[$.,\s]/g, "");
    if (/^\d+$/.test(digits)) return Math.round(Math.abs(r.row.amount)) === Number(digits);
    return r.haystack.includes(q);
  }
  return true;
}

function reconciliation(
  accountId: number,
  periodMonth: string,
  todayMonth: string,
  imports: ReturnType<typeof loadCartolaImportsByMonth>
): CheckingMonthReconciliation {
  if (periodMonth === todayMonth) return { status: "open" };
  const imp = imports?.get(periodMonth);
  if (imp?.saldo_final_clp == null) return { status: "no_statement" };
  const difference = checkingMovementBalanceAtMonthEnd(accountId, periodMonth) - imp.saldo_final_clp;
  return difference === 0 ? { status: "matches" } : { status: "differs", difference };
}

/** A page of the statement: whole months, newest first, with the query's rows. */
export function buildCheckingStatement(accountId: number, query: CheckingStatementQuery = {}): CheckingStatementResponse {
  const ledger = loadLedger(accountId);
  const todayMonth = ledger.today.slice(0, 7);
  const imports = loadCartolaImportsByMonth(accountId);
  const opening = ledger.opening != null ? Math.round(ledger.opening.amount) : 0;

  const byMonth = new Map<string, LedgerRow[]>();
  for (const r of ledger.rows) {
    const ym = r.on.slice(0, 7);
    const list = byMonth.get(ym);
    if (list) list.push(r);
    else byMonth.set(ym, [r]);
  }
  const monthKeys = [...byMonth.keys()].sort((a, b) => ymCompare(b, a));
  // The current month always opens the statement, with or without rows.
  if (query.before == null && !byMonth.has(todayMonth)) monthKeys.unshift(todayMonth);
  const closingBefore = (ym: string): number => {
    // The last row of the newest month before `ym`, else the opening balance.
    for (const key of monthKeys) {
      if (ymCompare(key, ym) >= 0) continue;
      const rows = byMonth.get(key);
      if (rows && rows.length > 0) return rows[rows.length - 1]!.row.balance_after;
    }
    return opening;
  };

  const months: CheckingStatementMonthDto[] = [];
  let shown = 0;
  let nextBefore: string | null = null;
  let lastRead: string | null = null;
  const candidates = monthKeys.filter((ym) => query.before == null || ymCompare(ym, query.before) < 0);
  for (const ym of candidates) {
    if (shown >= STATEMENT_PAGE_MIN_ROWS) {
      nextBefore = lastRead;
      break;
    }
    lastRead = ym;
    const all = byMonth.get(ym) ?? [];
    const kept = all.filter((r) => rowMatches(r, query));
    const filtered = kept.length !== all.length;
    if (filtered && kept.length === 0) continue;
    const openingBalance = closingBefore(ym);
    let moneyIn = 0;
    let moneyOut = 0;
    for (const r of all) {
      if (r.row.amount > 0) moneyIn += r.row.amount;
      else moneyOut -= r.row.amount;
    }
    const hiddenRows = all.filter((r) => !kept.includes(r));
    months.push({
      period_month: ym,
      opening_balance: openingBalance,
      closing_balance: all.length > 0 ? all[all.length - 1]!.row.balance_after : openingBalance,
      money_in: Math.round(moneyIn),
      money_out: Math.round(moneyOut),
      reconciliation: reconciliation(accountId, ym, todayMonth, imports),
      rows: kept.map((r) => r.row).reverse(),
      hidden:
        hiddenRows.length > 0
          ? { count: hiddenRows.length, net: Math.round(hiddenRows.reduce((s, r) => s + r.row.amount, 0)) }
          : null,
    });
    shown += kept.length;
  }
  return {
    account_id: accountId,
    currency: ledger.currency,
    months,
    next_before: nextBefore,
    opening: nextBefore == null && ledger.opening != null ? { ...ledger.opening, amount: opening } : null,
  };
}
