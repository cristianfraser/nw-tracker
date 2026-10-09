/**
 * What the dollars leaving a USD cash account cost in pesos, traced through the client's own
 * dollar accounts — so a card's dollar debt paid in DOLLARS (a `pago_tarjeta` transfer from a USD
 * cash account, `currency = 'usd'`, no counter leg) counts at the pesos those dollars were bought
 * with, not at the day's rate.
 *
 * Dollar lots (integer cents, pesos as a float) are walked FIFO through every USD cash account in
 * scope, over its whole history:
 * - scope: the USD cash accounts a dollar card payment leaves from, plus, recursively, every USD
 *   cash account that transferred dollars into one in scope;
 * - lots: `purchase` (a transfer in with a CLP leg and a USD counter leg: its pesos),
 *   `own_transfer` (dollars from another account in scope: the pesos the source's outflow
 *   consumed), `market` (any other dollar inflow — dividends, sales, interest, plain deposits —
 *   at the stored USD/CLP close on or before its date, `fxRowOnOrBefore`, the reference rate the
 *   USD-cash capital flows use for dollars with no pesos of their own; a missing rate throws);
 * - outflows (purchases of shares, transfers out, fees, withdrawals) consume FIFO; a shortfall
 *   above one cent throws.
 *
 * **Withdrawal requests reserve at request time.** A broker dollar withdrawal
 * (`broker_withdrawal_requests`) sets its gross aside from the source account's queue the moment
 * it is requested: later buys cannot spend those dollars. Its booking (`incoming_wire_bookings`)
 * draws the net through the transfer, which carries ALL the reservation's pesos (the delivered
 * dollars bear the fee's cost), and the rest through the fee at no pesos; the reservation must end
 * empty. A request not booked yet keeps its reservation.
 *
 * **Order.** Events run by Chile date; within a day by time when every event of the day has one
 * (`movement_event_times`, a request's `requested_at`), else arrivals first, then by movement id, with each request
 * placed among its own account's events by time. A request's day must have a time on every other
 * event of its account — otherwise the order around the request cannot be told, and it throws.
 */
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fintualUsdAccountId } from "./fintualEmailImport.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { movementClpLegOrZero, movementUsdLeg } from "./movementAmounts.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import {
  isMovementTransferRow,
  isUsdCashAccount,
  signedUsdDeltaForAccountMovement,
  type MovementTransferRow,
} from "./movementTransfer.js";

export type UsdLotSource = "purchase" | "own_transfer" | "market";

export type UsdOutflowLot = { source: UsdLotSource; usd: number; clp: number; movement_id: number };

export type UsdOutflowPesoCost = { usd: number; clp: number; lots: UsdOutflowLot[] };

type Lot = { source: UsdLotSource; movement_id: number; cents: number; clp: number };

type Row = MovementTransferRow & { id: number };

type Request = {
  message_id: string;
  requested_at: string;
  gross_cents: number;
  net_cents: number;
  account_id: number;
  date: string;
  time_ms: number;
};

type Reservation = { request: Request; lots: Lot[]; cents: number; clp: number };

type BookingDraw = { request: Request; role: "transfer" | "fee" };

type Event =
  | { kind: "movement"; date: string; id: number; time_ms: number | null; accounts: number[]; row: Row }
  | { kind: "request"; date: string; time_ms: number; accounts: number[]; request: Request };

const cents = (usd: number) => Math.round(usd * 100);

/** The USD cash accounts a dollar card payment leaves from (`pago_tarjeta`, USD, no counter leg). */
function dollarCardPaymentSources(): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT from_account_id AS id FROM movements
       WHERE flow_kind = 'pago_tarjeta' AND account_id IS NULL AND from_account_id IS NOT NULL
         AND currency = 'usd' AND counter_currency IS NULL`
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id).filter((id) => isUsdCashAccount(id));
}

/** The sources plus every USD cash account that sent dollars into one already in scope. */
function scopeAccounts(sources: readonly number[]): Set<number> {
  const scope = new Set(sources);
  const feeders = db.prepare(
    `SELECT DISTINCT from_account_id AS id FROM movements
     WHERE account_id IS NULL AND from_account_id IS NOT NULL AND to_account_id = ?
       AND (currency = 'usd' OR counter_currency = 'usd')`
  );
  const pending = [...sources];
  while (pending.length > 0) {
    const accountId = pending.pop()!;
    for (const r of feeders.all(accountId) as { id: number }[]) {
      if (scope.has(r.id) || !isUsdCashAccount(r.id)) continue;
      scope.add(r.id);
      pending.push(r.id);
    }
  }
  return scope;
}

function loadRows(scope: ReadonlySet<number>): Row[] {
  const ids = [...scope];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount,
              counter_currency, occurred_on, note, units_delta, flow_kind, ticker
       FROM movements
       WHERE account_id IN (${ph}) OR from_account_id IN (${ph}) OR to_account_id IN (${ph})
       ORDER BY occurred_on, id`
    )
    .all(...ids, ...ids, ...ids) as Row[];
}

/** Requests and their booked movements, for requests whose source account is in scope. */
function loadRequests(scope: ReadonlySet<number>): { requests: Request[]; draws: Map<number, BookingDraw> } {
  const stored = db
    .prepare(
      `SELECT message_id, broker, requested_at, gross_amount, net_amount
       FROM broker_withdrawal_requests ORDER BY requested_at, message_id`
    )
    .all() as { message_id: string; broker: string; requested_at: string; gross_amount: number; net_amount: number }[];
  const requests: Request[] = [];
  const draws = new Map<number, BookingDraw>();
  if (stored.length === 0) return { requests, draws };
  const bookingStmt = db.prepare(
    `SELECT transfer_movement_id, fee_movement_id FROM incoming_wire_bookings WHERE request_message_id = ?`
  );
  for (const r of stored) {
    if (r.broker !== "fintual") throw new Error(`withdrawal request ${r.message_id}: unmapped broker ${r.broker}`);
    const accountId = fintualUsdAccountId();
    if (!scope.has(accountId)) continue;
    const time_ms = Date.parse(r.requested_at);
    if (!Number.isFinite(time_ms)) {
      throw new Error(`withdrawal request ${r.message_id}: unparsable requested_at ${JSON.stringify(r.requested_at)}`);
    }
    const request: Request = {
      message_id: r.message_id,
      requested_at: r.requested_at,
      gross_cents: cents(r.gross_amount),
      net_cents: cents(r.net_amount),
      account_id: accountId,
      date: chileWallClockAt(new Date(time_ms)).ymd,
      time_ms,
    };
    requests.push(request);
    const booking = bookingStmt.get(r.message_id) as
      | { transfer_movement_id: number | null; fee_movement_id: number | null }
      | undefined;
    if (!booking) continue;
    if (booking.transfer_movement_id == null) {
      throw new Error(
        `withdrawal request ${r.message_id} is booked but its transfer movement is gone — the dollars it ` +
          "reserved cannot be traced; restore the transfer or remove the booking"
      );
    }
    draws.set(booking.transfer_movement_id, { request, role: "transfer" });
    if (booking.fee_movement_id != null) draws.set(booking.fee_movement_id, { request, role: "fee" });
  }
  return { requests, draws };
}

/**
 * One day's events in walk order: by time when every event has one, else by movement id with each
 * request placed before the first event of its account timed after it.
 */
function orderDay(movements: Event[], requests: Event[], inflowOnly: (id: number) => boolean): Event[] {
  // Without times, a day's arrivals come first: the ledger records a purchase and the wire that
  // funded it on the same day in either id order (the 2024-12-10 SPY buy precedes its wire), and a
  // day can only spend what it holds. Which dollars an outflow spends is still FIFO.
  const idOf = (e: Event) => (e as { id: number }).id;
  const byId = [...movements].sort((a, b) => {
    const ia = inflowOnly(idOf(a)) ? 0 : 1;
    const ib = inflowOnly(idOf(b)) ? 0 : 1;
    return ia - ib || idOf(a) - idOf(b);
  });
  for (const req of requests) {
    const accountId = req.accounts[0]!;
    for (const m of byId) {
      if (m.accounts.includes(accountId) && m.time_ms == null) {
        throw new Error(
          `movement ${(m as { id: number }).id} (${m.date}) has no time, but a withdrawal request on account ` +
            `${accountId} falls on that day — the order around the request cannot be told`
        );
      }
    }
  }
  if (requests.length === 0) return byId;
  const sortedRequests = [...requests].sort((a, b) => a.time_ms! - b.time_ms!);
  if (byId.every((m) => m.time_ms != null)) {
    return [...byId, ...sortedRequests].sort((a, b) => {
      if (a.time_ms !== b.time_ms) return a.time_ms! - b.time_ms!;
      if (a.kind !== b.kind) return a.kind === "movement" ? -1 : 1;
      return a.kind === "movement" ? a.id - (b as { id: number }).id : 0;
    });
  }
  const out: Event[] = [...byId];
  for (const req of sortedRequests) {
    const accountId = req.accounts[0]!;
    const own = out.filter((e) => e.kind === "movement" && e.accounts.includes(accountId));
    for (let i = 1; i < own.length; i++) {
      if (own[i]!.time_ms! < own[i - 1]!.time_ms!) {
        throw new Error(
          `account ${accountId} on ${req.date}: movement ids and their times disagree — the order around ` +
            "a withdrawal request cannot be told"
        );
      }
    }
    const later = own.find((e) => e.time_ms! > req.time_ms!);
    const lastOwn = own.length > 0 ? out.indexOf(own[own.length - 1]!) : out.length - 1;
    const at = later ? out.indexOf(later) : lastOwn + 1;
    out.splice(at, 0, req);
  }
  return out;
}

function lotOut(l: Lot): UsdOutflowLot {
  return { source: l.source, usd: l.cents / 100, clp: l.clp, movement_id: l.movement_id };
}

/**
 * Walks every USD cash account in scope and returns the peso cost of each dollar outflow from one
 * of them, by movement id (see the module doc). Empty when no dollar card payment exists.
 */
export function usdOutflowPesoCostByMovement(): Map<number, UsdOutflowPesoCost> {
  const result = new Map<number, UsdOutflowPesoCost>();
  const sources = dollarCardPaymentSources();
  if (sources.length === 0) return result;
  const scope = scopeAccounts(sources);
  const rows = loadRows(scope);
  const { requests, draws } = loadRequests(scope);
  const times = movementEventTimesMs();

  const deltas = new Map<number, Map<number, number>>();
  const byDate = new Map<string, { movements: Event[]; requests: Event[] }>();
  const dayOf = (date: string) => {
    let d = byDate.get(date);
    if (!d) byDate.set(date, (d = { movements: [], requests: [] }));
    return d;
  };
  for (const row of rows) {
    const perAccount = new Map<number, number>();
    for (const accountId of new Set([row.account_id, row.from_account_id, row.to_account_id])) {
      if (accountId == null || !scope.has(accountId)) continue;
      const delta = cents(signedUsdDeltaForAccountMovement(row, accountId));
      if (delta !== 0) perAccount.set(accountId, delta);
    }
    if (perAccount.size === 0) continue;
    deltas.set(row.id, perAccount);
    dayOf(row.occurred_on).movements.push({
      kind: "movement",
      date: row.occurred_on,
      id: row.id,
      time_ms: times.get(row.id) ?? null,
      accounts: [...perAccount.keys()],
      row,
    });
  }
  for (const request of requests) {
    dayOf(request.date).requests.push({
      kind: "request",
      date: request.date,
      time_ms: request.time_ms,
      accounts: [request.account_id],
      request,
    });
  }

  const queues = new Map<number, Lot[]>();
  const queueOf = (accountId: number) => {
    let q = queues.get(accountId);
    if (!q) queues.set(accountId, (q = []));
    return q;
  };
  const reservations = new Map<string, Reservation>();

  /** Takes `need` cents FIFO from `lots` (mutated); throws on a shortfall above one cent. */
  const take = (lots: Lot[], need: number, what: () => string): Lot[] => {
    const available = lots.reduce((s, l) => s + l.cents, 0);
    if (available < need - 1) {
      throw new Error(`${what()}: needs US$${(need / 100).toFixed(2)} but only US$${(available / 100).toFixed(2)} is there`);
    }
    const taken: Lot[] = [];
    let left = Math.min(need, available);
    while (left > 0) {
      const lot = lots[0]!;
      const cut = Math.min(left, lot.cents);
      const clp = cut === lot.cents ? lot.clp : (lot.clp * cut) / lot.cents;
      taken.push({ source: lot.source, movement_id: lot.movement_id, cents: cut, clp });
      lot.cents -= cut;
      lot.clp -= clp;
      if (lot.cents === 0) lots.shift();
      left -= cut;
    }
    return taken;
  };

  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    const inflowOnly = (id: number) => [...deltas.get(id)!.values()].every((d) => d > 0);
    for (const event of orderDay(day.movements, day.requests, inflowOnly)) {
      if (event.kind === "request") {
        const r = event.request;
        const lots = take(queueOf(r.account_id), r.gross_cents, () =>
          `withdrawal request ${r.message_id} (${r.requested_at}) on account ${r.account_id}`
        );
        reservations.set(r.message_id, {
          request: r,
          lots,
          cents: r.gross_cents,
          clp: lots.reduce((s, l) => s + l.clp, 0),
        });
        continue;
      }
      const row = event.row;
      const perAccount = deltas.get(row.id)!;
      let carried: { cents: number; clp: number } | null = null;
      for (const [accountId, delta] of perAccount) {
        if (delta >= 0) continue;
        const draw = draws.get(row.id);
        if (draw && draw.request.account_id === accountId) {
          const reservation = reservations.get(draw.request.message_id);
          if (!reservation) {
            throw new Error(
              `movement ${row.id} (${row.occurred_on}) draws on withdrawal request ${draw.request.message_id} ` +
                `before it was requested (${draw.request.requested_at})`
            );
          }
          if (-delta > reservation.cents) {
            throw new Error(
              `movement ${row.id}: draws US$${(-delta / 100).toFixed(2)} from request ` +
                `${draw.request.message_id}, which has US$${(reservation.cents / 100).toFixed(2)} left`
            );
          }
          if (draw.role === "transfer" && -delta !== draw.request.net_cents) {
            throw new Error(
              `movement ${row.id}: the booked transfer of request ${draw.request.message_id} moves ` +
                `US$${(-delta / 100).toFixed(2)}, not its net US$${(draw.request.net_cents / 100).toFixed(2)}`
            );
          }
          reservation.cents += delta;
          const clp = draw.role === "transfer" ? reservation.clp : 0;
          if (draw.role === "transfer") reservation.clp = 0;
          result.set(row.id, {
            usd: -delta / 100,
            clp,
            lots: draw.role === "transfer" ? reservation.lots.map(lotOut) : [],
          });
          carried = { cents: -delta, clp };
          continue;
        }
        const lots = take(queueOf(accountId), -delta, () => `movement ${row.id} (${row.occurred_on}) on account ${accountId}`);
        const clp = lots.reduce((s, l) => s + l.clp, 0);
        result.set(row.id, { usd: -delta / 100, clp, lots: lots.map(lotOut) });
        carried = { cents: -delta, clp };
      }
      for (const [accountId, delta] of perAccount) {
        if (delta <= 0) continue;
        let lot: Lot;
        if (isMovementTransferRow(row) && row.from_account_id != null && perAccount.has(row.from_account_id)) {
          if (!carried) throw new Error(`movement ${row.id}: dollars arrive from account ${row.from_account_id} but none left it`);
          lot = { source: "own_transfer", movement_id: row.id, cents: delta, clp: carried.clp };
        } else if (isMovementTransferRow(row) && row.currency === "clp" && row.counter_currency === "usd") {
          const clp = Math.abs(movementClpLegOrZero(row));
          if (!(clp > 0) || !(Math.abs(movementUsdLeg(row) ?? 0) > 0)) {
            throw new Error(`movement ${row.id}: a dollar purchase needs positive pesos and dollars`);
          }
          lot = { source: "purchase", movement_id: row.id, cents: delta, clp };
        } else {
          const fx = fxRowOnOrBefore(row.occurred_on);
          if (!fx || !(fx.clp_per_usd > 0)) {
            throw new Error(`movement ${row.id}: no USD/CLP rate on or before ${row.occurred_on} to value its dollars`);
          }
          lot = { source: "market", movement_id: row.id, cents: delta, clp: (delta / 100) * fx.clp_per_usd };
        }
        queueOf(accountId).push(lot);
      }
    }
  }

  for (const reservation of reservations.values()) {
    const booked = [...draws.values()].some((d) => d.request === reservation.request);
    if (booked && reservation.cents !== 0) {
      throw new Error(
        `withdrawal request ${reservation.request.message_id}: its booked movements leave ` +
          `US$${(reservation.cents / 100).toFixed(2)} of the reserved gross unaccounted for`
      );
    }
  }
  return result;
}
