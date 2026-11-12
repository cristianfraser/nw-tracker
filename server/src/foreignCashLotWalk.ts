/**
 * The one walk of the client's foreign cash accounts (any currency but pesos: the dollar accounts,
 * a euro account — `cashCurrency.ts`) that both the cost tracer (`foreignCashCostLots.ts`: what a
 * card payment made in a foreign currency cost in pesos) and the tax module
 * (`foreignCashTaxLotEvents.ts`: the exchange result the SII taxes) run on. It knows amounts of each
 * account's currency, order and queues; what an inflow is worth in pesos is the caller's
 * (`priceInflow`).
 *
 * **Queues.** One FIFO queue of slices per account in scope, in the account's currency (the scope
 * maps each account to the currency it holds). A slice is part of one acquisition: `acquiredOn` /
 * `acquireMovementId` name the row that brought the money into the client's accounts (a purchase,
 * a dividend, …) and never change afterwards; `minor` is an integer count of the currency's
 * smallest coin (`currencyMinorDigits`: cents for the dollar and the euro); `clp` the pesos the
 * slice carries; `source` how it was acquired (`purchase`: a pesos → currency transfer;
 * `conversion`: a transfer from another account in scope holding ANOTHER foreign currency;
 * `market`: any other inflow); `carriedBy` the own transfer that last moved the slice into its
 * current account (null while it sits where it was acquired).
 *
 * **Events.** Every row with a non-zero delta in the account's currency on an account in scope
 * (`signedNativeDeltaForAccountMovement`), plus the broker withdrawal requests whose source account
 * is in scope. They run by Chile date; within a day by time when every event of the day has one
 * (`movement_event_times`, a request's `requested_at`), else arrivals first and then by movement
 * id, with each request placed among its own account's events by time — a request's day must
 * have a time on every other event of its account, or the order around it cannot be told and
 * the walk throws.
 *
 * **Outflows** consume FIFO; a shortfall above one smallest coin throws. **Own transfers** (a
 * transfer between two accounts in scope holding the SAME currency) move the consumed slices
 * intact to the destination queue — original acquisition date, movement and pesos — marked
 * `carriedBy`. **A conversion between two foreign currencies** (a transfer between two accounts in
 * scope holding DIFFERENT currencies: its from-leg in one, its counter leg in the other) is a
 * disposal of the first (an outflow with `convertedTo` set; nothing is carried) and an acquisition
 * of the second (an inflow of source `conversion`, priced by the caller, who is handed the slices
 * the same row consumed: the tracer carries their pesos over, the tax module prices the new lot at
 * its own observado). **Inflows** push one slice priced by the caller.
 *
 * **Withdrawal requests reserve at request time.** A request takes its gross FIFO off its
 * account's queue the moment it is requested, so later buys cannot spend that money. A booked
 * request splits the reserved slices at once, whatever the order its booked movements run in:
 * the net's slices are the first `net` minor units (FIFO), the fee's the rest. With `feeCostToNet`
 * the net's slices carry ALL the reservation's pesos and the fee's none (the cost tracer: the
 * delivered money bears the fee's cost); without it every slice keeps its own pesos (the tax
 * module: the fee's cost is lost, not part of the net's). The booked transfer draws exactly the
 * net, the booked fee exactly the rest, and a booked reservation must end empty; an unbooked
 * request keeps its reservation.
 */
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { fintualUsdAccountId } from "./brokerAdapter.js";
import { accountCashCurrency } from "./cashCurrency.js";
import { currencyMinorDigits, isHomeCurrency } from "./displayUnits.js";
import { movementEventTimesMs } from "./movementEventTimes.js";
import { isMovementTransferRow, signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";

export type ForeignLotSource = "purchase" | "conversion" | "market";

export type ForeignLotSlice = {
  acquiredOn: string;
  acquireMovementId: number;
  /** Integer count of the currency's smallest coin. */
  minor: number;
  clp: number;
  source: ForeignLotSource;
  /** The own transfer that last moved the slice into its current account; null where it was acquired. */
  carriedBy: number | null;
};

export type ForeignWalkRow = MovementTransferRow & { id: number };

export type ForeignWalkRequest = {
  message_id: string;
  requested_at: string;
  gross_minor: number;
  net_minor: number;
  account_id: number;
  booking: { transfer_movement_id: number; fee_movement_id: number | null } | null;
};

export type ForeignWalkInflow = {
  row: ForeignWalkRow;
  accountId: number;
  currency: string;
  minor: number;
  source: ForeignLotSource;
  clp: number;
};

export type ForeignWalkOutflow = {
  row: ForeignWalkRow;
  accountId: number;
  currency: string;
  minor: number;
  /** The slices the outflow consumed, oldest first; Σ minor = `minor`. */
  slices: ForeignLotSlice[];
  /** The account the slices were carried to, for an own transfer; null for a disposal. */
  carriedTo: number | null;
  /** The account (and its currency) a conversion between two foreign currencies bought; null otherwise. */
  convertedTo: { accountId: number; currency: string } | null;
  /** Set when the movement drew on a withdrawal request's reservation instead of the queue. */
  draw: { message_id: string; role: "transfer" | "fee" } | null;
};

export type ForeignWalkReservation = {
  request: ForeignWalkRequest;
  /** The slices the request reserved, by the part of the booking that draws them (`fee` empty when gross = net). */
  net: ForeignLotSlice[];
  fee: ForeignLotSlice[];
  netDrawn: boolean;
  feeDrawn: boolean;
};

export type ForeignWalkResult = {
  /** Every outflow from an account in scope, in walk order. */
  outflows: ForeignWalkOutflow[];
  /** Every inflow acquired on an account in scope (own transfers are not acquisitions), in walk order. */
  inflows: ForeignWalkInflow[];
  /** The slices still held, per account, oldest first. */
  queues: Map<number, ForeignLotSlice[]>;
  reservations: Map<string, ForeignWalkReservation>;
  /** Rows touching an account in scope that move none of its currency (the caller decides whether that is an error). */
  skippedRows: ForeignWalkRow[];
};

export type ForeignWalkInflowToPrice = {
  row: ForeignWalkRow;
  accountId: number;
  currency: string;
  minor: number;
  source: ForeignLotSource;
  /** For a `conversion`: the slices the same row took off the account it converted from; else null. */
  consumed: readonly ForeignLotSlice[] | null;
};

export type ForeignWalkInput = {
  /** The accounts walked, each with the foreign currency it holds. */
  scope: ReadonlyMap<number, string>;
  rows: readonly ForeignWalkRow[];
  requests: readonly ForeignWalkRequest[];
  /** Movement id → epoch ms, for the rows that have a stated time. */
  eventTimes: ReadonlyMap<number, number>;
  /** The pesos an inflow (not an own transfer) carries into its queue. */
  priceInflow: (inflow: ForeignWalkInflowToPrice) => number;
  /**
   * How a booked withdrawal's reservation splits its pesos: `true` — the net's slices carry ALL
   * the reserved pesos and the fee's none (the cost tracer: the delivered money bears the fee);
   * `false` — every slice keeps its own pesos (the tax module: the fee's cost is lost, never part
   * of the net's cost).
   */
  feeCostToNet: boolean;
};

type Request = ForeignWalkRequest & { date: string; time_ms: number };

type Event =
  | { kind: "movement"; date: string; id: number; time_ms: number | null; accounts: number[]; row: ForeignWalkRow }
  | { kind: "request"; date: string; time_ms: number; accounts: number[]; request: Request };

/** An amount of `currency` as an integer count of its smallest coin. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyMinorDigits(currency));
}

/** An integer count of `currency`'s smallest coin back as an amount. */
export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyMinorDigits(currency);
}

const fmtAmount = (minor: number, currency: string) =>
  `${fromMinor(minor, currency).toFixed(currencyMinorDigits(currency))} ${currency.toUpperCase()}`;

/**
 * One day's events in walk order: by time when every event has one, else by movement id with each
 * request placed before the first event of its account timed after it.
 */
function orderDay(movements: Event[], requests: Event[], inflowOnly: (id: number) => boolean): Event[] {
  // Without times, a day's arrivals come first: the ledger records a purchase and the wire that
  // funded it on the same day in either id order (the 2024-12-10 SPY buy precedes its wire), and a
  // day can only spend what it holds. Which money an outflow spends is still FIFO.
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

/** Takes `need` minor units FIFO from `slices` (mutated); throws on a shortfall above one smallest coin. */
function take(slices: ForeignLotSlice[], need: number, currency: string, what: () => string): ForeignLotSlice[] {
  const available = slices.reduce((s, l) => s + l.minor, 0);
  if (available < need - 1) {
    throw new Error(`${what()}: needs ${fmtAmount(need, currency)} but only ${fmtAmount(available, currency)} is there`);
  }
  const taken: ForeignLotSlice[] = [];
  let left = Math.min(need, available);
  while (left > 0) {
    const slice = slices[0]!;
    const cut = Math.min(left, slice.minor);
    const clp = cut === slice.minor ? slice.clp : (slice.clp * cut) / slice.minor;
    taken.push({ ...slice, minor: cut, clp });
    slice.minor -= cut;
    slice.clp -= clp;
    if (slice.minor === 0) slices.shift();
    left -= cut;
  }
  return taken;
}

/** Pure: replays the rows and requests over the scope's queues (see the module doc). */
export function walkForeignCashLots(input: ForeignWalkInput): ForeignWalkResult {
  const { scope, rows, eventTimes, priceInflow, feeCostToNet } = input;
  for (const [accountId, currency] of scope) {
    if (isHomeCurrency(currency)) throw new Error(`account ${accountId}: the foreign-cash walk holds no ${currency}`);
  }
  const currencyOf = (accountId: number): string => {
    const c = scope.get(accountId);
    if (c == null) throw new Error(`account ${accountId} is not in scope`);
    return c;
  };
  const requests: Request[] = input.requests.map((r) => {
    const time_ms = Date.parse(r.requested_at);
    if (!Number.isFinite(time_ms)) {
      throw new Error(`withdrawal request ${r.message_id}: unparsable requested_at ${JSON.stringify(r.requested_at)}`);
    }
    if (!scope.has(r.account_id)) throw new Error(`withdrawal request ${r.message_id}: account ${r.account_id} is not in scope`);
    return { ...r, time_ms, date: chileWallClockAt(new Date(time_ms)).ymd };
  });
  const draws = new Map<number, { request: Request; role: "transfer" | "fee" }>();
  for (const request of requests) {
    if (!request.booking) continue;
    draws.set(request.booking.transfer_movement_id, { request, role: "transfer" });
    if (request.booking.fee_movement_id != null) draws.set(request.booking.fee_movement_id, { request, role: "fee" });
  }

  const deltas = new Map<number, Map<number, number>>();
  const byDate = new Map<string, { movements: Event[]; requests: Event[] }>();
  const dayOf = (date: string) => {
    let d = byDate.get(date);
    if (!d) byDate.set(date, (d = { movements: [], requests: [] }));
    return d;
  };
  const skippedRows: ForeignWalkRow[] = [];
  for (const row of rows) {
    const perAccount = new Map<number, number>();
    for (const accountId of new Set([row.account_id, row.from_account_id, row.to_account_id])) {
      if (accountId == null || !scope.has(accountId)) continue;
      const currency = currencyOf(accountId);
      const delta = toMinor(signedNativeDeltaForAccountMovement(row, accountId, currency), currency);
      if (delta !== 0) perAccount.set(accountId, delta);
    }
    if (perAccount.size === 0) {
      skippedRows.push(row);
      continue;
    }
    deltas.set(row.id, perAccount);
    dayOf(row.occurred_on).movements.push({
      kind: "movement",
      date: row.occurred_on,
      id: row.id,
      time_ms: eventTimes.get(row.id) ?? null,
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

  const queues = new Map<number, ForeignLotSlice[]>();
  const queueOf = (accountId: number) => {
    let q = queues.get(accountId);
    if (!q) queues.set(accountId, (q = []));
    return q;
  };
  const reservations = new Map<string, ForeignWalkReservation>();
  const outflows: ForeignWalkOutflow[] = [];
  const inflows: ForeignWalkInflow[] = [];

  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    const inflowOnly = (id: number) => [...deltas.get(id)!.values()].every((d) => d > 0);
    for (const event of orderDay(day.movements, day.requests, inflowOnly)) {
      if (event.kind === "request") {
        const r = event.request;
        const cur = currencyOf(r.account_id);
        const reserved = take(queueOf(r.account_id), r.gross_minor, cur, () =>
          `withdrawal request ${r.message_id} (${r.requested_at}) on account ${r.account_id}`
        );
        const reservedClp = reserved.reduce((s, l) => s + l.clp, 0);
        const feeMinor = r.gross_minor - r.net_minor;
        if (feeMinor < 0) {
          throw new Error(
            `withdrawal request ${r.message_id}: net ${fmtAmount(r.net_minor, cur)} above gross ${fmtAmount(r.gross_minor, cur)}`
          );
        }
        if (feeMinor > 0 && r.booking && r.booking.fee_movement_id == null) {
          throw new Error(
            `withdrawal request ${r.message_id}: booked without a fee movement, but gross − net is ${fmtAmount(feeMinor, cur)}`
          );
        }
        const net = take(reserved, r.net_minor, cur, () => `withdrawal request ${r.message_id}: splitting its reservation`);
        const fee = reserved.splice(0);
        if (feeCostToNet) {
          // The delivered money bears the whole reservation's pesos; the fee's carries none.
          const netClp = net.reduce((s, l) => s + l.clp, 0);
          if (netClp > 0) for (const l of net) l.clp = (l.clp * reservedClp) / netClp;
          else if (net.length > 0) net[0]!.clp = reservedClp;
          else if (reservedClp > 0) throw new Error(`withdrawal request ${r.message_id}: reserved pesos with a zero net`);
          for (const l of fee) l.clp = 0;
        }
        reservations.set(r.message_id, { request: r, net, fee, netDrawn: false, feeDrawn: false });
        continue;
      }
      const row = event.row;
      const perAccount = deltas.get(row.id)!;
      let carried: ForeignLotSlice[] | null = null;
      const bothInScope =
        isMovementTransferRow(row) &&
        row.from_account_id != null &&
        row.to_account_id != null &&
        perAccount.has(row.from_account_id) &&
        perAccount.has(row.to_account_id);
      const ownTransfer = bothInScope && currencyOf(row.from_account_id!) === currencyOf(row.to_account_id!);
      const conversion = bothInScope && !ownTransfer;
      for (const [accountId, delta] of perAccount) {
        if (delta >= 0) continue;
        const currency = currencyOf(accountId);
        const draw = draws.get(row.id);
        let slices: ForeignLotSlice[];
        if (draw && draw.request.account_id === accountId) {
          const reservation = reservations.get(draw.request.message_id);
          if (!reservation) {
            throw new Error(
              `movement ${row.id} (${row.occurred_on}) draws on withdrawal request ${draw.request.message_id} ` +
                `before it was requested (${draw.request.requested_at})`
            );
          }
          const part = draw.role === "transfer" ? reservation.net : reservation.fee;
          const partMinor = part.reduce((s, l) => s + l.minor, 0);
          const drawn = draw.role === "transfer" ? reservation.netDrawn : reservation.feeDrawn;
          if (drawn) throw new Error(`movement ${row.id}: request ${draw.request.message_id}'s ${draw.role} was already drawn`);
          if (-delta !== partMinor) {
            throw new Error(
              `movement ${row.id}: the booked ${draw.role} of request ${draw.request.message_id} moves ` +
                `${fmtAmount(-delta, currency)}, not its ${draw.role === "transfer" ? "net" : "fee"} ${fmtAmount(partMinor, currency)}`
            );
          }
          if (draw.role === "transfer") reservation.netDrawn = true;
          else reservation.feeDrawn = true;
          slices = part.map((l) => ({ ...l }));
        } else {
          slices = take(queueOf(accountId), -delta, currency, () => `movement ${row.id} (${row.occurred_on}) on account ${accountId}`);
        }
        outflows.push({
          row,
          accountId,
          currency,
          minor: -delta,
          slices,
          carriedTo: ownTransfer ? row.to_account_id : null,
          convertedTo: conversion ? { accountId: row.to_account_id!, currency: currencyOf(row.to_account_id!) } : null,
          draw: draw && draw.request.account_id === accountId ? { message_id: draw.request.message_id, role: draw.role } : null,
        });
        carried = slices;
      }
      for (const [accountId, delta] of perAccount) {
        if (delta <= 0) continue;
        const currency = currencyOf(accountId);
        if (ownTransfer) {
          if (!carried) throw new Error(`movement ${row.id}: ${currency} arrives from account ${row.from_account_id} but none left it`);
          const carriedMinor = carried.reduce((s, l) => s + l.minor, 0);
          if (carriedMinor !== delta) {
            throw new Error(
              `movement ${row.id}: ${fmtAmount(carriedMinor, currency)} left account ${row.from_account_id} but ` +
                `${fmtAmount(delta, currency)} arrive on ${accountId}`
            );
          }
          queueOf(accountId).push(...carried.map((l) => ({ ...l, carriedBy: row.id })));
          continue;
        }
        if (conversion && !carried) {
          throw new Error(`movement ${row.id}: ${currency} bought from account ${row.from_account_id}, but nothing left it`);
        }
        const source: ForeignLotSource = conversion
          ? "conversion"
          : isMovementTransferRow(row) && isHomeCurrency(row.currency) && row.counter_currency === currency
            ? "purchase"
            : "market";
        const clp = priceInflow({ row, accountId, currency, minor: delta, source, consumed: conversion ? carried : null });
        if (!Number.isFinite(clp) || clp < 0) throw new Error(`movement ${row.id}: priced at ${clp} pesos`);
        queueOf(accountId).push({ acquiredOn: row.occurred_on, acquireMovementId: row.id, minor: delta, clp, source, carriedBy: null });
        inflows.push({ row, accountId, currency, minor: delta, source, clp });
      }
    }
  }

  for (const reservation of reservations.values()) {
    const r = reservation.request;
    if (!r.booking) continue;
    const left =
      (reservation.netDrawn ? 0 : reservation.net.reduce((s, l) => s + l.minor, 0)) +
      (reservation.feeDrawn ? 0 : reservation.fee.reduce((s, l) => s + l.minor, 0));
    if (left !== 0) {
      throw new Error(
        `withdrawal request ${r.message_id}: its booked movements leave ${fmtAmount(left, currencyOf(r.account_id))} ` +
          "of the reserved gross unaccounted for"
      );
    }
  }
  return { outflows, inflows, queues, reservations, skippedRows };
}

// ---- DB loaders (thin; the walk itself is pure) ----

/** The given foreign cash accounts, each with the currency it holds: a walk's scope (throws on any other account). */
export function foreignCashScope(accountIds: Iterable<number>): Map<number, string> {
  const scope = new Map<number, string>();
  for (const id of accountIds) {
    const currency = accountCashCurrency(id);
    if (currency == null || isHomeCurrency(currency)) throw new Error(`account ${id} is not a foreign cash account`);
    scope.set(id, currency);
  }
  return scope;
}

/** Every movement touching an account in scope, oldest first. */
export function loadForeignWalkRows(scope: ReadonlyMap<number, string>): ForeignWalkRow[] {
  const ids = [...scope.keys()];
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount,
              counter_currency, occurred_on, note, units_delta, flow_kind
       FROM movements
       WHERE account_id IN (${ph}) OR from_account_id IN (${ph}) OR to_account_id IN (${ph})
       ORDER BY occurred_on, id`
    )
    .all(...ids, ...ids, ...ids) as ForeignWalkRow[];
}

/** The broker withdrawal requests whose source account is in scope, with their bookings. */
export function loadForeignWalkRequests(scope: ReadonlyMap<number, string>): ForeignWalkRequest[] {
  const stored = db
    .prepare(
      `SELECT message_id, broker, requested_at, gross_amount, net_amount
       FROM broker_withdrawal_requests ORDER BY requested_at, message_id`
    )
    .all() as { message_id: string; broker: string; requested_at: string; gross_amount: number; net_amount: number }[];
  const requests: ForeignWalkRequest[] = [];
  if (stored.length === 0) return requests;
  const bookingStmt = db.prepare(
    `SELECT transfer_movement_id, fee_movement_id FROM incoming_wire_bookings WHERE request_message_id = ?`
  );
  for (const r of stored) {
    if (r.broker !== "fintual") throw new Error(`withdrawal request ${r.message_id}: unmapped broker ${r.broker}`);
    const accountId = fintualUsdAccountId();
    const currency = scope.get(accountId);
    if (currency == null) continue;
    const booking = bookingStmt.get(r.message_id) as
      | { transfer_movement_id: number | null; fee_movement_id: number | null }
      | undefined;
    if (booking && booking.transfer_movement_id == null) {
      throw new Error(
        `withdrawal request ${r.message_id} is booked but its transfer movement is gone — the money it ` +
          "reserved cannot be traced; restore the transfer or remove the booking"
      );
    }
    requests.push({
      message_id: r.message_id,
      requested_at: r.requested_at,
      gross_minor: toMinor(r.gross_amount, currency),
      net_minor: toMinor(r.net_amount, currency),
      account_id: accountId,
      booking: booking ? { transfer_movement_id: booking.transfer_movement_id!, fee_movement_id: booking.fee_movement_id } : null,
    });
  }
  return requests;
}

/** The walk over the DB's rows, requests and event times for `scope`. */
export function walkForeignCashLotsFromDb(
  scope: ReadonlyMap<number, string>,
  opts: Pick<ForeignWalkInput, "priceInflow" | "feeCostToNet">
): ForeignWalkResult {
  return walkForeignCashLots({
    scope,
    rows: loadForeignWalkRows(scope),
    requests: loadForeignWalkRequests(scope),
    eventTimes: movementEventTimesMs(),
    ...opts,
  });
}
