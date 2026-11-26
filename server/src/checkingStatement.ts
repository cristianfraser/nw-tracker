/**
 * The checking account page (a cuenta corriente / cuenta vista, and every other cash ledger: a
 * broker's cash, a foreign-currency account, `isCheckingPageAccount`): its head (`CheckingGlanceDto`: today's
 * balance and the balance strip) and its statement (`CheckingStatementResponse`: every movement
 * newest first with the balance after it, grouped by month, each month opening and closing).
 *
 * One walk of the ledger feeds both, with the balance reader's accounting (`accountFlowRows` →
 * `signedClpDeltaForAccountMovement` for a peso ledger, `signedNativeDeltaForAccountMovement` for a
 * foreign one, transfer legs included): a row the bank dates after today counts today
 * (`displayLedgerCutoffYmd`) and is listed under today. The walk's end must equal the balance the
 * rest of the app shows (the account's own balance reader), or this throws. The ledger anchor (the
 * opening balance carrier of a cartola account) is the statement's first line, not a movement of
 * its month.
 *
 * Amounts are in the account's own currency: a cash ledger is a document in its coin. The one
 * display-unit figure is the head's `display_value`, the account's value converted once
 * (`accountValueAt`).
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
import { HOME_CURRENCY, isHomeCurrency, roundToCurrency, currencyMinorDigits, currencySmallestCoin } from "./displayUnits.js";
import { accountIdsUnderCheckingAccounts } from "./movementBalanceCashAccounts.js";
import { OPTION_PREMIUM_PAID_FLOW_KINDS, OPTION_PREMIUM_RECEIVED_FLOW_KINDS } from "./optionFlowKinds.js";
import { accountProfileOptional } from "./accountProfile.js";
import { accountValueAt } from "./accountValue.js";
import { clpCashBalanceLive } from "./clpCashAccounts.js";
import { foreignCashBalanceAt } from "./foreignCashAccounts.js";
import { isOptionFlowKind } from "./optionFlowKinds.js";
import type { CurrencyCode } from "./rates.js";
import { accountFlowRows, type FlowsApiRow } from "./flowsApi.js";
import { checkingMovementBalanceAtMonthEnd, checkingMovementBalanceLive, isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { loadCartolaImportsByMonth } from "./checkingCartolaMonthSummary.js";
import { cachedFlowsIncome } from "./flowsOverview.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import { transferCounterpartiesByMovementSide } from "./bankTransferNotices.js";
import { checkingMovementShownName, checkingTransferParty, loadDisplayNameContext } from "./expenseDisplayNames.js";
import { shownNameSearchText } from "./expenseShownName.js";
import { cartolaDescriptionFromNote } from "./checkingDescriptionPredicates.js";
import {
  listMovementRowsForAccount,
  signedClpDeltaForAccountMovement,
  signedNativeDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

/**
 * How a checking page account's ledger is read: a cartola account (cuenta corriente / cuenta
 * vista: pesos, bank statements, a ledger anchor) or any other cash ledger in its `currency` (a
 * broker's cash, a foreign-currency account: no statements, no anchor). Null: not a checking page
 * account (its value is not the sum of its movements in one currency).
 */
type CheckingPageLedger = { cartola: boolean; currency: string };

function checkingPageLedger(accountId: number): CheckingPageLedger | null {
  const q = accountProfileOptional(accountId)?.quantity;
  if (q == null) return null;
  // A cartola checking account is a peso ledger by its kind (its balance reader signs the peso leg).
  if (q.kind === "checking_ledger") return { cartola: true, currency: HOME_CURRENCY };
  if (q.kind === "clp_ledger") return { cartola: false, currency: HOME_CURRENCY };
  if (q.kind === "foreign_ledger") return { cartola: false, currency: q.currency };
  return null;
}

/** The accounts whose page is the checking page: every cash ledger (a balance that is the sum of its movements in one currency). */
export function isCheckingPageAccount(accountId: number): boolean {
  return checkingPageLedger(accountId) != null;
}

/** The filter chips in their order; a statement offers the ones its ledger holds. */
const KIND_ORDER: readonly CheckingStatementRowKind[] = [
  "income",
  "card_payment",
  "own_transfer",
  "conversion",
  "trade",
  "dividend",
  "other",
  "fee",
];

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
  /** The account has bank statements (cartolas) and a ledger anchor. */
  cartola: boolean;
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
    if (r.flow_kind === "stock_buy" || r.flow_kind === "stock_sell" || isOptionFlowKind(r.flow_kind)) return "trade";
    if (r.flow_kind === "dividend_payout") return "dividend";
    // A payment is money leaving for the card; money a card sends here (a `carga_tarjeta` top-up)
    // is a transfer between own accounts.
    if (
      r.flow_kind === "pago_tarjeta" ||
      (r.transfer_direction === "out" && kindSlugForAccount(r.counterpart_account_id) === "credit_card")
    ) {
      return "card_payment";
    }
    return r.counter_currency != null ? "conversion" : "own_transfer";
  }
  return incomeIds.has(r.id) ? "income" : "other";
}

/**
 * A conversion's other side, seen from a ledger in `currency`: the stored leg in the other
 * currency and the operation's rate. The rate reads the same on both accounts: home currency per
 * unit of the foreign one; between two foreign currencies, the one whose code sorts later per unit
 * of the other (dollars per euro).
 */
function conversionCounter(m: MovementTransferRow, currency: string): NonNullable<CheckingStatementRowDto["counter"]> {
  if (m.counter_amount == null || m.counter_currency == null) {
    throw new Error(`checking statement: conversion ${m.id} has no counter leg`);
  }
  const legs = [
    { amount: Math.abs(m.amount), currency: m.currency },
    { amount: Math.abs(m.counter_amount), currency: m.counter_currency },
  ];
  const own = legs.find((l) => l.currency === currency);
  const other = legs.find((l) => l.currency !== currency);
  if (!own || !other) throw new Error(`checking statement: conversion ${m.id} has no ${currency} leg`);
  if (!(own.amount > 0) || !(other.amount > 0)) {
    throw new Error(`checking statement: conversion ${m.id} has an empty leg`);
  }
  const ownIsQuote = isHomeCurrency(own.currency) || (!isHomeCurrency(other.currency) && own.currency > other.currency);
  const raw = ownIsQuote ? own.amount / other.amount : other.amount / own.amount;
  // Two decimals for a rate in the hundreds (pesos per dollar), four for one near 1 (dollars per euro).
  const digits = raw >= 20 ? 2 : 4;
  return { amount: other.amount, currency: other.currency, rate: Number(raw.toFixed(digits)) };
}

/** Which side of a trade the movement is, from its kind; null when it is not a trade. */
function tradeSide(flowKind: string | null): CheckingStatementRowDto["trade_side"] {
  if (flowKind === "stock_buy" || (OPTION_PREMIUM_PAID_FLOW_KINDS as readonly string[]).includes(flowKind ?? "")) return "buy";
  if (flowKind === "stock_sell" || (OPTION_PREMIUM_RECEIVED_FLOW_KINDS as readonly string[]).includes(flowKind ?? "")) return "sell";
  return null;
}

/** The balance the rest of the app shows for the account today, in its own currency. */
function liveBalance(accountId: number, ledger: CheckingPageLedger, today: string): number {
  if (ledger.cartola) return checkingMovementBalanceLive(accountId).value_clp;
  return isHomeCurrency(ledger.currency) ? clpCashBalanceLive(accountId).value_clp : foreignCashBalanceAt(accountId, today);
}

/**
 * The ledger of a checking page account, oldest first, each row with the balance after it.
 * `withNames` false (the page's head) leaves every row unnamed and reads neither the transfer
 * mails nor the name catalog: the head needs balances and kinds only.
 */
function loadLedger(accountId: number, withNames = true): Ledger {
  const pageLedger = checkingPageLedger(accountId);
  if (pageLedger == null) {
    throw new Error(`checking statement: account ${accountId} is not a cash ledger (${kindSlugForAccount(accountId)})`);
  }
  const { currency, cartola } = pageLedger;
  const flows = accountFlowRows(accountId);
  if (flows == null) throw new Error(`checking statement: account ${accountId} not found`);
  const today = chileCalendarTodayYmd();
  const postedOn = new Map(
    (postingsStmt.all(accountId) as { movement_id: number; posted_on: string }[]).map((p) => [p.movement_id, p.posted_on])
  );
  // Income credits exist only on the accounts under Checking accounts (the income builder's own
  // list): any other cash ledger (a broker's cash) never asks the income pipeline.
  const income = accountIdsUnderCheckingAccounts().includes(accountId) ? cachedFlowsIncome() : null;
  const incomeIds = new Set(
    (income?.lines ?? []).filter((l) => l.account_id === accountId).map((l) => l.movement_id)
  );

  const ordered = [...flows].sort((a, b) => {
    const da = a.occurred_on > today ? today : a.occurred_on;
    const dbb = b.occurred_on > today ? today : b.occurred_on;
    return da < dbb ? -1 : da > dbb ? 1 : a.id - b.id;
  });

  // Each row moves the account by its leg in the ledger's currency, signed for this account: the
  // balance reader's accounting, so a currency exchange counts the leg this account holds and a
  // share purchase the cash that left.
  const stored = new Map(listMovementRowsForAccount(accountId).map((m) => [m.id!, m]));
  const ledgerDelta = (m: MovementTransferRow): number =>
    isHomeCurrency(currency)
      ? signedClpDeltaForAccountMovement(m, accountId)
      : signedNativeDeltaForAccountMovement(m, accountId, currency);

  // A bank movement's names: the expense rows' own rule (catalog, counterparty from a transfer mail).
  const names = withNames
    ? { counterparties: transferCounterpartiesByMovementSide(), nameContext: loadDisplayNameContext([]) }
    : null;

  let balance = 0;
  let opening: Ledger["opening"] = null;
  const rows: LedgerRow[] = [];
  for (const r of ordered) {
    const movement = stored.get(r.id);
    if (movement == null) throw new Error(`checking statement: movement ${r.id} on account ${accountId} has no ledger row`);
    const amount = ledgerDelta(movement);
    balance += amount;
    if (cartola && isCheckingLedgerAnchorNote(r.note)) {
      if (rows.length > 0 || opening != null) {
        throw new Error(`checking statement: account ${accountId}'s ledger anchor ${r.id} is not its first movement`);
      }
      opening = { occurred_on: r.occurred_on, amount };
      continue;
    }
    // A row that moves nothing in this ledger's currency (units only, another currency's single
    // leg) is not a line of its statement.
    if (amount === 0) continue;
    const kind = rowKind(r, incomeIds);
    const transfer = r.counterpart_account_id != null && r.from_account_id != null;
    const posted = postedOn.get(r.id);
    let vendor: CheckingStatementVendorDto | null = null;
    let party: CheckingStatementRowDto["party"] = null;
    if (!transfer && names != null) {
      const { counterparties, nameContext } = names;
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
        income_kind: kind === "income" ? (income?.income_kind_by_movement_id[r.id] ?? null) : null,
        trade_side: kind === "trade" ? tradeSide(r.flow_kind) : null,
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
        // A conversion's other side; a card's foreign debt paid from this account shows what it paid there too.
        counter:
          kind === "conversion" || (kind === "card_payment" && movement.counter_currency != null)
            ? conversionCounter(movement, currency)
            : null,
        units:
          kind === "trade" && movement.units_delta != null && movement.units_delta !== 0
            ? Math.abs(movement.units_delta)
            : null,
        amount,
        balance_after: roundToCurrency(balance, currency),
      },
    });
  }
  const live = liveBalance(accountId, pageLedger, today);
  // The reader adds the same deltas in its own order and rounds to the coin: the two float sums may
  // sit either side of a half coin, never further apart.
  if (Math.abs(balance - live) > currencySmallestCoin(currency) / 2 + 1e-6) {
    throw new Error(
      `checking statement: account ${accountId}'s walk ends at ${roundToCurrency(balance, currency)}, the balance reads ${live}`
    );
  }
  return { currency, cartola, today, rows, opening, balance: live };
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
  const before = ledger.opening != null ? roundToCurrency(ledger.opening.amount, ledger.currency) : 0;
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

/**
 * Today's balance in `unit`: the account's own value converted once (`accountValueAt`, today's
 * rate at the account's side); null when the unit is the ledger's currency.
 */
function displayValue(accountId: number, ledger: Ledger, unit: CurrencyCode): CheckingGlanceDto["display_value"] {
  if (unit === ledger.currency) return null;
  const v = accountValueAt(accountId, ledger.today, unit);
  // No rate on file for the pair: no figure, like the bundle's own `latest_valuation` (the fx
  // coverage banner names the missing pair).
  return v == null ? null : { value: v.value, currency: unit };
}

/** The checking page's head, its `display_value` in `unit`; null when the account is not a checking page account. */
export function buildCheckingGlanceForAccount(accountId: number, unit: CurrencyCode): CheckingGlanceDto | null {
  if (!isCheckingPageAccount(accountId)) return null;
  const ledger = loadLedger(accountId, false);
  const endOfDay = makeEndOfDay(ledger);
  const today = ledger.today;
  const firstDay = ledger.opening?.occurred_on ?? ledger.rows[0]?.on ?? today;
  const held = new Set(ledger.rows.map((r) => r.row.kind));
  return {
    currency: ledger.currency,
    balance: ledger.balance,
    as_of: today,
    display_value: displayValue(accountId, ledger, unit),
    kinds: KIND_ORDER.filter((k) => held.has(k)),
    strips: STRIP_RANGES.map((r) => buildStrip(r, ledger, endOfDay, firstDay)),
  };
}

export type CheckingStatementQuery = {
  /** Only months before this one (YYYY-MM); absent = from today's month. */
  before?: string;
  kind?: CheckingStatementKindFilter;
  /**
   * Text in the description, account, note or type; or, all digits once «$ . ,» are dropped, the
   * exact amount: whole units («2650») or with the currency's decimals («2.650,00»).
   */
  q?: string;
  /** Leave out transfers between own accounts (conversions between them included). */
  hideOwn?: boolean;
};

/**
 * A search text that is an amount, as a figure copied from the page or typed: a sign, a currency
 * symbol or code and spaces dropped («US$63,52», «−150.000», «$ 2.650,00»). A last mark followed
 * by one digit, or by as many as the currency's decimals, is the decimal mark (`exact`: the row's
 * amount to the coin); any other mark groups thousands and the figure is whole units. Null when
 * the text is not an amount.
 */
function typedAmount(q: string, currency: string): { value: number; exact: boolean } | null {
  const text = q
    .replace(/^[-\u2212+(]\s*/, "")
    .replace(/\)$/, "")
    .replace(/^(?:[a-z]{0,3}\$|[a-z]{3}\b|\u20ac)\s*/, "")
    .replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(text)) return null;
  const minor = currencyMinorDigits(currency);
  const decimals = minor > 0 ? /^(.*)[.,](\d+)$/.exec(text) : null;
  if (decimals && (decimals[2]!.length === 1 || decimals[2]!.length === minor) && decimals[2]!.length <= minor) {
    const whole = decimals[1]!.replace(/[.,]/g, "");
    return { value: Number(`${whole || "0"}.${decimals[2]}`), exact: true };
  }
  return { value: Number(text.replace(/[.,]/g, "")), exact: false };
}

function rowMatches(r: LedgerRow, query: CheckingStatementQuery, currency: string): boolean {
  const kind = r.row.kind;
  if (query.hideOwn && (kind === "own_transfer" || kind === "conversion")) return false;
  if (query.kind && kind !== query.kind) return false;
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const typed = typedAmount(q, currency);
    if (typed != null) {
      const abs = Math.abs(r.row.amount);
      return typed.exact ? roundToCurrency(abs, currency) === typed.value : Math.round(abs) === typed.value;
    }
    return r.haystack.includes(q);
  }
  return true;
}

function reconciliation(
  accountId: number,
  periodMonth: string,
  todayMonth: string,
  imports: ReturnType<typeof loadCartolaImportsByMonth>,
  cartola: boolean
): CheckingMonthReconciliation {
  if (periodMonth === todayMonth) return { status: "open" };
  // No bank statements to hold the month against (a broker's cash, a foreign-currency account).
  if (!cartola) return { status: "none" };
  const imp = imports?.get(periodMonth);
  if (imp?.saldo_final_clp == null) return { status: "no_statement" };
  const difference = checkingMovementBalanceAtMonthEnd(accountId, periodMonth) - imp.saldo_final_clp;
  return difference === 0 ? { status: "matches" } : { status: "differs", difference };
}

/** A page of the statement: whole months, newest first, with the query's rows. */
export function buildCheckingStatement(accountId: number, query: CheckingStatementQuery = {}): CheckingStatementResponse {
  const ledger = loadLedger(accountId);
  const todayMonth = ledger.today.slice(0, 7);
  const imports = ledger.cartola ? loadCartolaImportsByMonth(accountId) : null;
  const round = (v: number) => roundToCurrency(v, ledger.currency);
  const opening = ledger.opening != null ? round(ledger.opening.amount) : 0;

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
    const kept = all.filter((r) => rowMatches(r, query, ledger.currency));
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
      money_in: round(moneyIn),
      money_out: round(moneyOut),
      reconciliation: reconciliation(accountId, ym, todayMonth, imports, ledger.cartola),
      rows: kept.map((r) => r.row).reverse(),
      hidden:
        hiddenRows.length > 0
          ? { count: hiddenRows.length, net: round(hiddenRows.reduce((s, r) => s + r.row.amount, 0)) }
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
