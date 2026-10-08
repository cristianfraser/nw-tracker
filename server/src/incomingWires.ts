/**
 * Dollar withdrawals a broker wires to one of the client's own accounts, booked from mail alone.
 *
 * The receiving account (Santander USD) has no movement feed, so mails are the only evidence. Three
 * mails describe one withdrawal:
 *
 * - The broker's confirmation (Fintual «Retiro en dólares confirmado», `broker.notifications`
 *   kind `withdrawal_requested`): gross, fee, net, destination account and the day it will pay.
 *   It can still be cancelled, so it books nothing on its own; it is stored as a request.
 * - The sending bank's copy of the transfer message (Banco Security's MT103: value date, amount,
 *   ordering customer, beneficiary account) and the receiving bank's notice (Santander «orden de
 *   pago recibida»: order number and amount), `bank_account.incoming_wires`. Either one proves
 *   the money moved.
 *
 * A request pairs with the one wire into its destination account for exactly its net amount, from
 * the day it was requested to a week past its pay day. The pair books a transfer broker cash →
 * destination account for the net, on the wire's value date, plus the broker's fee as a `cash_fee`
 * on the broker cash account (gross − net). Every apply re-pairs everything stored; a booking is
 * recorded per request and never repeated, even after its movements are deleted.
 */
import type {
  BankAccountIncomingWiresApplyDetails,
  BankAccountIncomingWiresPayload,
  BrokerNotification,
  IncomingWireBookingReport,
  IncomingWireNotice,
} from "nw-tracker-contracts";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fintualUsdAccountId } from "./fintualEmailImport.js";

/** How long after its pay day a request waits for its wire before it is reported overdue. */
const OVERDUE_AFTER_DUE_DAYS = 3;
/** How far past its pay day a wire may still pay a request. */
const WIRE_AFTER_DUE_DAYS = 7;
/** Notices of one wire: the receiving bank may mail a day after the value date. */
const NOTICES_OF_ONE_WIRE_DAYS = 2;
/** A hand-entered transfer counts as the booked one within this window. */
const EXISTING_TRANSFER_WINDOW_DAYS = 5;

export type WithdrawalRequest = {
  message_id: string;
  broker: "fintual";
  requested_at: string;
  subject: string;
  currency: "usd";
  gross_amount: number;
  net_amount: number;
  destination_account: string;
  due_on: string;
};

const cents = (n: number) => Math.round(n * 100);

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Account numbers compare without leading zeros: the bank prints 005105313120, an MT103 5105313120. */
const bareNumber = (n: string) => n.replace(/^0+/, "");

/** The broker notification as a request, or a throw when it lacks what a request needs. */
export function withdrawalRequestFromNotification(n: BrokerNotification, broker: "fintual"): WithdrawalRequest {
  if (n.kind !== "withdrawal_requested") throw new Error(`notification ${n.message_id} is not a withdrawal request`);
  if (n.currency !== "usd") throw new Error(`withdrawal request ${n.message_id}: only dollar withdrawals are mapped (got ${n.currency})`);
  if (n.amount == null || n.gross_amount == null || !n.destination_account || !n.due_on) {
    throw new Error(`withdrawal request ${n.message_id} does not state net, gross, destination account and pay day`);
  }
  if (cents(n.amount) > cents(n.gross_amount)) {
    throw new Error(`withdrawal request ${n.message_id}: net ${n.amount} above gross ${n.gross_amount}`);
  }
  return {
    message_id: n.message_id,
    broker,
    requested_at: n.occurred_at,
    subject: n.subject,
    currency: "usd",
    gross_amount: n.gross_amount,
    net_amount: n.amount,
    destination_account: n.destination_account,
    due_on: n.due_on,
  };
}

const REQUEST_COLUMNS = [
  "message_id",
  "broker",
  "requested_at",
  "subject",
  "currency",
  "gross_amount",
  "net_amount",
  "destination_account",
  "due_on",
] as const;

const NOTICE_COLUMNS = [
  "message_id",
  "bank",
  "reported_by",
  "sent_at_chile",
  "subject",
  "value_date",
  "currency",
  "amount",
  "beneficiary_bank",
  "beneficiary_account",
  "beneficiary_name",
  "ordering_name",
  "ordering_account",
  "ordering_bank",
  "reference",
  "remittance",
] as const;

function noticeRow(n: IncomingWireNotice): Record<(typeof NOTICE_COLUMNS)[number], string | number | null> {
  return {
    message_id: n.message_id,
    bank: n.bank,
    reported_by: n.reported_by,
    sent_at_chile: n.sent_at_chile,
    subject: n.subject,
    value_date: n.value_date,
    currency: n.currency,
    amount: n.amount,
    beneficiary_bank: n.beneficiary.bank,
    beneficiary_account: n.beneficiary.account,
    beneficiary_name: n.beneficiary.name,
    ordering_name: n.ordering.name,
    ordering_account: n.ordering.account,
    ordering_bank: n.ordering.bank,
    reference: n.reference,
    remittance: n.remittance,
  };
}

function rowNotice(r: Record<string, unknown>): IncomingWireNotice {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    message_id: String(r.message_id),
    bank: String(r.bank),
    reported_by: r.reported_by as IncomingWireNotice["reported_by"],
    sent_at_chile: String(r.sent_at_chile),
    subject: String(r.subject),
    value_date: String(r.value_date),
    currency: "usd",
    amount: Number(r.amount),
    beneficiary: { bank: s(r.beneficiary_bank), account: s(r.beneficiary_account), name: s(r.beneficiary_name) },
    ordering: { name: s(r.ordering_name), account: s(r.ordering_account), bank: s(r.ordering_bank) },
    reference: s(r.reference),
    remittance: s(r.remittance),
  };
}

function sameRow(stored: Record<string, unknown>, row: Record<string, unknown>, columns: readonly string[]): boolean {
  return columns.every((c) => {
    const a = stored[c] ?? null;
    const b = row[c] ?? null;
    return typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : a === b;
  });
}

/** Stores what is new; a resent mail must state the same. Returns how many were new. */
function storeRows(
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): number {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE message_id = ?`);
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`);
  let added = 0;
  for (const row of rows) {
    const old = existing.get(row.message_id) as Record<string, unknown> | undefined;
    if (old) {
      if (!sameRow(old, row, columns)) throw new Error(`${table}: ${String(row.message_id)} was already stored with other content`);
      continue;
    }
    insert.run(row);
    added++;
  }
  return added;
}

export function storeWithdrawalRequests(requests: readonly WithdrawalRequest[]): number {
  return storeRows("broker_withdrawal_requests", REQUEST_COLUMNS, requests);
}

export function storeIncomingWireNotices(notices: readonly IncomingWireNotice[]): number {
  return storeRows("incoming_wire_notices", NOTICE_COLUMNS, notices.map(noticeRow));
}

/** The client's account a number names in a currency (`bank_account_numbers`), or null. */
function accountForNumber(number: string, currency: string, issuer: string | null): number | null {
  const rows = db
    .prepare(`SELECT account_id, issuer, number FROM bank_account_numbers WHERE currency = ?`)
    .all(currency) as { account_id: number; issuer: string; number: string }[];
  const hits = rows.filter((r) => bareNumber(r.number) === bareNumber(number) && (issuer == null || r.issuer === issuer));
  if (hits.length > 1) throw new Error(`account number ${number} (${currency}) is declared ${hits.length} times`);
  return hits[0]?.account_id ?? null;
}

/**
 * The account a notice's wire landed in: the beneficiary account it prints, or, for a receiving
 * bank's notice that prints none, that bank's one account in the currency.
 */
function noticeAccountId(n: IncomingWireNotice): number | null {
  if (n.beneficiary.account) return accountForNumber(n.beneficiary.account, n.currency, n.beneficiary.bank);
  if (n.reported_by !== "receiving_bank") return null;
  const rows = db
    .prepare(`SELECT account_id FROM bank_account_numbers WHERE issuer = ? AND currency = ?`)
    .all(n.bank, n.currency) as { account_id: number }[];
  return rows.length === 1 ? rows[0]!.account_id : null;
}

type Wire = {
  account_id: number | null;
  amount_cents: number;
  /** The sending bank's value date when one mailed, else the receiving bank's notice day. */
  value_date: string;
  notices: IncomingWireNotice[];
};

/** Notices of one wire (same account, amount and dates within two days, one per side) grouped. */
export function groupWireNotices(notices: readonly IncomingWireNotice[], accountOf: (n: IncomingWireNotice) => number | null): Wire[] {
  const ordered = [...notices].sort(
    (a, b) =>
      a.value_date.localeCompare(b.value_date) ||
      (a.reported_by === b.reported_by ? 0 : a.reported_by === "sending_bank" ? -1 : 1) ||
      a.sent_at_chile.localeCompare(b.sent_at_chile)
  );
  const wires: Wire[] = [];
  for (const n of ordered) {
    const account_id = accountOf(n);
    const wire = wires.find(
      (w) =>
        w.account_id === account_id &&
        w.amount_cents === cents(n.amount) &&
        !w.notices.some((x) => x.reported_by === n.reported_by) &&
        w.notices.every((x) => dayDistance(x.value_date, n.value_date) <= NOTICES_OF_ONE_WIRE_DAYS)
    );
    if (wire) {
      wire.notices.push(n);
      if (n.reported_by === "sending_bank") wire.value_date = n.value_date;
    } else {
      wires.push({ account_id, amount_cents: cents(n.amount), value_date: n.value_date, notices: [n] });
    }
  }
  return wires;
}

/** A wire can pay a request of this broker when no notice names another ordering customer. */
function orderedBy(wire: Wire, broker: string): boolean {
  return wire.notices.every((n) => n.ordering.name == null || n.ordering.name.toLowerCase().includes(broker));
}

type Booking = IncomingWireBookingReport["booked"][number];

const findExistingFee = db.prepare(
  `SELECT id FROM movements
   WHERE account_id = ? AND flow_kind = 'cash_fee' AND currency = 'usd' AND ABS(amount - ?) < 0.005
     AND occurred_on BETWEEN ? AND ?`
);

const findExistingTransfer = db.prepare(
  `SELECT id FROM movements
   WHERE from_account_id = ? AND to_account_id = ? AND currency = 'usd' AND ABS(amount - ?) < 0.005
     AND occurred_on BETWEEN ? AND ?`
);

/**
 * Pairs every stored request without a booking with the wire that paid it, and (with `apply`)
 * writes the transfer and the fee. `extra*` are a dry run's unsaved inputs, paired as if stored.
 */
export function bookIncomingWires(opts: {
  apply: boolean;
  extraRequests?: readonly WithdrawalRequest[];
  extraNotices?: readonly IncomingWireNotice[];
}): IncomingWireBookingReport {
  const merge = <T extends { message_id: string }>(stored: T[], extra: readonly T[] = []): T[] => {
    const ids = new Set(stored.map((s) => s.message_id));
    return [...stored, ...extra.filter((e) => !ids.has(e.message_id))];
  };
  const requests = merge(
    db.prepare(`SELECT ${REQUEST_COLUMNS.join(", ")} FROM broker_withdrawal_requests`).all() as WithdrawalRequest[],
    opts.extraRequests
  ).sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  const notices = merge(
    (db.prepare(`SELECT * FROM incoming_wire_notices`).all() as Record<string, unknown>[]).map(rowNotice),
    opts.extraNotices
  );
  const bookedRequests = new Set(
    (db.prepare(`SELECT request_message_id FROM incoming_wire_bookings`).all() as { request_message_id: string }[]).map(
      (r) => r.request_message_id
    )
  );
  const claimedNotices = new Set(
    (db.prepare(`SELECT notice_message_id FROM incoming_wire_booking_notices`).all() as { notice_message_id: string }[]).map(
      (r) => r.notice_message_id
    )
  );
  const wires = groupWireNotices(
    notices.filter((n) => !claimedNotices.has(n.message_id)),
    noticeAccountId
  );
  const today = chileCalendarTodayYmd();
  const report: IncomingWireBookingReport = { booked: [], waiting: [], unmatched: [], ambiguous: [] };
  const used = new Set<Wire>();

  for (const r of requests) {
    if (bookedRequests.has(r.message_id)) continue;
    const toAccount = accountForNumber(r.destination_account, r.currency, null);
    if (toAccount == null) {
      report.ambiguous.push(`request ${r.message_id}: account ${r.destination_account} (${r.currency}) is not in bank_account_numbers`);
      continue;
    }
    const requestedDay = chileWallClockAt(new Date(r.requested_at)).ymd;
    const candidates = wires.filter(
      (w) =>
        !used.has(w) &&
        w.account_id === toAccount &&
        w.amount_cents === cents(r.net_amount) &&
        w.value_date >= requestedDay &&
        w.value_date <= isoAddDays(r.due_on, WIRE_AFTER_DUE_DAYS) &&
        orderedBy(w, r.broker)
    );
    if (candidates.length === 0) {
      report.waiting.push({
        request_message_id: r.message_id,
        due_on: r.due_on,
        net_amount: r.net_amount,
        overdue: today > isoAddDays(r.due_on, OVERDUE_AFTER_DUE_DAYS),
      });
      continue;
    }
    if (candidates.length > 1) {
      report.ambiguous.push(
        `request ${r.message_id} (US$${r.net_amount}): ${candidates.length} wires fit — ${candidates.map((w) => w.value_date).join(", ")}`
      );
      continue;
    }
    const wire = candidates[0]!;
    used.add(wire);
    const from = fintualUsdAccountId();
    const existing = findExistingTransfer.get(
      from,
      toAccount,
      r.net_amount,
      isoAddDays(wire.value_date, -EXISTING_TRANSFER_WINDOW_DAYS),
      isoAddDays(wire.value_date, EXISTING_TRANSFER_WINDOW_DAYS)
    ) as { id: number } | undefined;
    // A transfer entered by hand before this ran is the booked one; so is its fee, when entered too.
    const existingFee = existing
      ? (findExistingFee.get(
          from,
          (cents(r.gross_amount) - cents(r.net_amount)) / 100,
          isoAddDays(wire.value_date, -EXISTING_TRANSFER_WINDOW_DAYS),
          isoAddDays(wire.value_date, EXISTING_TRANSFER_WINDOW_DAYS)
        ) as { id: number } | undefined)
      : undefined;
    report.booked.push({
      request_message_id: r.message_id,
      value_date: wire.value_date,
      currency: "usd",
      net_amount: r.net_amount,
      fee_amount: (cents(r.gross_amount) - cents(r.net_amount)) / 100,
      from_account_id: from,
      to_account_id: toAccount,
      transfer_movement_id: existing?.id ?? null,
      fee_movement_id: existingFee?.id ?? null,
      already_in_ledger: existing != null,
      notices: wire.notices.map((n) => n.message_id),
    });
  }

  for (const w of wires) {
    if (used.has(w)) continue;
    report.unmatched.push({
      value_date: w.value_date,
      amount: w.amount_cents / 100,
      account_id: w.account_id,
      notices: w.notices.map((n) => n.message_id),
    });
  }

  if (opts.apply && report.booked.length > 0) {
    db.transaction(() => {
      for (const b of report.booked) writeBooking(b, requests.find((r) => r.message_id === b.request_message_id)!);
    }).immediate();
    for (const b of report.booked) {
      invalidateAggregationForAccountDate(b.from_account_id, b.value_date);
      invalidateAggregationForAccountDate(b.to_account_id, b.value_date);
    }
  }
  return report;
}

const insTransfer = db.prepare(
  `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
   VALUES (?, ?, ?, 'usd', ?, ?)`
);
const insFee = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
   VALUES (?, ?, 'usd', ?, ?, 'cash_fee')`
);

function writeBooking(b: Booking, r: WithdrawalRequest): void {
  const broker = r.broker === "fintual" ? "Fintual" : r.broker;
  if (b.transfer_movement_id == null) {
    const info = insTransfer.run(
      b.from_account_id,
      b.to_account_id,
      b.net_amount,
      b.value_date,
      `${broker} · retiro en dólares a la cuenta ${r.destination_account} (${r.subject})`.slice(0, 300)
    );
    b.transfer_movement_id = Number(info.lastInsertRowid);
  }
  if (b.fee_amount > 0 && b.fee_movement_id == null) {
    const info = insFee.run(b.from_account_id, b.fee_amount, b.value_date, `${broker} · comisión del retiro en dólares`);
    b.fee_movement_id = Number(info.lastInsertRowid);
  }
  db.prepare(
    `INSERT INTO incoming_wire_bookings (request_message_id, value_date, transfer_movement_id, fee_movement_id)
     VALUES (?, ?, ?, ?)`
  ).run(b.request_message_id, b.value_date, b.transfer_movement_id, b.fee_movement_id);
  const link = db.prepare(`INSERT INTO incoming_wire_booking_notices (notice_message_id, request_message_id) VALUES (?, ?)`);
  for (const id of b.notices) link.run(id, b.request_message_id);
}

/** `bank_account.incoming_wires`: stores the notices (with `apply`) and books what they pay. */
export function applyIncomingWires(payload: BankAccountIncomingWiresPayload): BankAccountIncomingWiresApplyDetails {
  const new_notices = payload.apply
    ? db.transaction(() => storeIncomingWireNotices(payload.notices)).immediate()
    : payload.notices.filter((n) => db.prepare(`SELECT 1 FROM incoming_wire_notices WHERE message_id = ?`).get(n.message_id) == null)
        .length;
  const bookings = bookIncomingWires({ apply: payload.apply, extraNotices: payload.apply ? [] : payload.notices });
  return { applied: payload.apply, received: payload.notices.length, new_notices, bookings };
}
