/**
 * The premiums of one option contract account (`option_contracts`, migration 304) as tax-lot
 * events, with short lots (`taxLots.ts`): the contracts are the units, the premium the money, all
 * in USD.
 *
 *   option_sell_open   → open_short   at the premium received (writing the option)
 *   option_buy_close   → close_short  at the premium paid (buying a short back)
 *   option_expire      → on a short:  close_short at 0 on the expiry day (the whole premium is the gain)
 *                      → on a long:   dispose at 0 (the premium paid is the loss)
 *   option_buy_open    → acquire      at the premium paid
 *   option_sell_close  → dispose      at the premium received
 *   option_assign      → the contract leg closes with NO gain or loss of its own (`assigned` /
 *                        `exercised`); its premium instead ADJUSTS the linked share trade.
 *
 * The four assignment cases, by IRC §1234 and IRS Pub. 550, «Puts and Calls» (read 2026-11-10):
 *   short call assigned — «If a call you write is exercised and you sell the underlying stock,
 *     increase your amount realized on the sale of the stock» by the premium → ADDED to the
 *     `stock_sell` proceeds;
 *   short put assigned  — «If a put you write is exercised and you buy the underlying stock,
 *     decrease your basis in the stock» by the premium → SUBTRACTED from the `stock_buy` cost;
 *   long call exercised — «If you exercise a call, add its cost to the basis of the stock you
 *     bought» → premium paid is ADDED to the `stock_buy` cost;
 *   long put exercised  — «If you exercise a put, reduce your amount realized on the sale of the
 *     underlying stock by the cost of the put» → premium paid is SUBTRACTED from the `stock_sell`
 *     proceeds (= added to the basis given up). The married-put and constructive-sale rules
 *     (§1233, §1259) are not modelled.
 * The holding period of shares bought by assignment or exercise starts on that day (Pub. 550: the
 * option's own holding period is not carried over); the equity walk dates the lot by its trade.
 *
 * Expiry of a written option: «If your obligation expires, the amount you received for writing
 * the call or put is short-term capital gain» (Pub. 550). Terms: a written option's result is always short-term (§1234(b)(1)); a long option follows its
 * own dates (`taxLotTerm`: long-term when held more than a year). `optionLotResults` carries
 * `openedOn` / `closedOn` / `term` per slice.
 *
 * Not here: the Schedule D wiring and the demo's option events (docs/demo-app-features-plan.md
 * wave O2).
 */
import { db } from "./db.js";
import type { EquityTaxLotRow, EquityTradeAdjustments } from "./equityTaxLotEvents.js";
import { requireOptionContract, type OptionRight } from "./optionContracts.js";
import { realizeTaxLots, taxLotTerm, type TaxLotEvent, type TaxLotMethod, type TaxLotSelector } from "./taxLots.js";

export type OptionTaxLotRow = EquityTaxLotRow;

export type OptionCloseKind = "buy_close" | "sell_close" | "expire" | "assign";

export type OptionTaxLotEvents = {
  events: TaxLotEvent[];
  /** How each closing event (by movement id) came about. */
  closeKinds: ReadonlyMap<number, OptionCloseKind>;
};

/**
 * Maps one contract account's movements (any order) to date-ordered lot events; openings before
 * closings within a day, then ledger order. Throws on a movement that is not an option premium
 * or expiry/assignment, one with no contract count, an expiry or assignment that does not take
 * the position to zero, or a closing with nothing open.
 */
export function optionTaxLotEventsFromRows(accountId: number, rows: readonly OptionTaxLotRow[]): OptionTaxLotEvents {
  const currencies = new Set<string>();
  const closeKinds = new Map<number, OptionCloseKind>();
  type Raw = { row: OptionTaxLotRow; contracts: number; opening: boolean };
  const raw: Raw[] = [];
  for (const r of rows) {
    const k = r.flow_kind;
    const opening = k === "option_sell_open" || k === "option_buy_open";
    const closing = k === "option_buy_close" || k === "option_sell_close" || k === "option_expire" || k === "option_assign";
    if (!opening && !closing) {
      throw new Error(`Option lots: account ${accountId} movement ${r.id} (${k ?? "no flow kind"}) is not an option movement`);
    }
    if (r.units_delta == null || r.units_delta === 0) throw new Error(`Option lots: movement ${r.id} has no contract count`);
    currencies.add(r.currency);
    raw.push({ row: r, contracts: Math.abs(r.units_delta), opening });
  }
  if ([...currencies].some((c) => c !== "usd")) throw new Error(`Option lots: account ${accountId} has non-USD movements`);
  raw.sort((a, b) => a.row.occurred_on.localeCompare(b.row.occurred_on) || Number(!a.opening) - Number(!b.opening) || a.row.id - b.row.id);

  let held = 0; // signed contracts: a short position is negative
  const events: TaxLotEvent[] = [];
  for (const { row: r, contracts } of raw) {
    const date = r.occurred_on;
    switch (r.flow_kind) {
      case "option_sell_open":
        events.push({ kind: "open_short", date, movementId: r.id, units: contracts, proceeds: r.amount });
        held -= contracts;
        break;
      case "option_buy_open":
        events.push({ kind: "acquire", date, movementId: r.id, units: contracts, cost: r.amount });
        held += contracts;
        break;
      case "option_buy_close":
        if (!(held < 0)) throw new Error(`Option lots: movement ${r.id} buys back contracts but the position is ${held}`);
        events.push({ kind: "close_short", date, movementId: r.id, units: contracts, cost: r.amount });
        closeKinds.set(r.id, "buy_close");
        held += contracts;
        break;
      case "option_sell_close":
        if (!(held > 0)) throw new Error(`Option lots: movement ${r.id} sells contracts but the position is ${held}`);
        events.push({ kind: "dispose", date, movementId: r.id, units: contracts, proceeds: r.amount });
        closeKinds.set(r.id, "sell_close");
        held -= contracts;
        break;
      case "option_expire":
      case "option_assign": {
        const assign = r.flow_kind === "option_assign";
        if (held === 0) throw new Error(`Option lots: movement ${r.id} (${r.flow_kind}) on a flat position`);
        if (Math.abs(contracts - Math.abs(held)) > 1e-9) {
          throw new Error(`Option lots: movement ${r.id} (${r.flow_kind}) takes ${contracts} contracts, the position is ${held}`);
        }
        if (held < 0) {
          events.push({ kind: "close_short", date, movementId: r.id, units: contracts, cost: 0, ...(assign ? { assigned: true } : {}) });
        } else {
          events.push({ kind: "dispose", date, movementId: r.id, units: contracts, proceeds: 0, ...(assign ? { exercised: true } : {}) });
        }
        closeKinds.set(r.id, assign ? "assign" : "expire");
        held = 0;
        break;
      }
      default:
        throw new Error(`Option lots: unreachable flow kind ${r.flow_kind}`);
    }
  }
  return { events, closeKinds };
}

export function loadOptionTaxLotEvents(accountId: number): OptionTaxLotEvents {
  requireOptionContract(accountId);
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, from_account_id, to_account_id, flow_kind, amount, currency, units_delta,
              counter_units_delta
         FROM movements
        WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
    )
    .all(accountId, accountId, accountId) as OptionTaxLotRow[];
  return optionTaxLotEventsFromRows(accountId, rows);
}

export type OptionLotResult = {
  side: "long" | "short";
  how: "bought_back" | "sold" | "expired" | "assigned" | "exercised";
  openedOn: string;
  closedOn: string;
  closeMovementId: number;
  openMovementId: number;
  contracts: number;
  /** USD received (a short's premium; a long's closing premium, 0 on expiry). */
  proceeds: number;
  /** USD paid (a long's premium; a short's buy-back, 0 on expiry). */
  cost: number;
  /** `proceeds − cost`; 0 for assigned / exercised, whose premium moves to the share trade (`carried`). */
  gain: number;
  /** The premium an assignment / exercise carries to the share trade (0 otherwise). */
  carried: number;
  term: "short_term" | "long_term";
};

/** One result per consumed lot slice, in closing order. Premium is split by contracts within a closing. */
export function optionLotResults(
  { events, closeKinds }: OptionTaxLotEvents,
  method: TaxLotMethod | TaxLotSelector = "fifo"
): OptionLotResult[] {
  const { disposals, shortCloses } = realizeTaxLots(events, method);
  const out: OptionLotResult[] = [];
  for (const c of shortCloses) {
    const kind = closeKinds.get(c.movementId);
    const how = c.assigned ? "assigned" : kind === "expire" ? "expired" : "bought_back";
    for (const s of c.slices) {
      const cost = c.assigned ? 0 : (c.cost * s.units) / c.units;
      out.push({
        side: "short",
        how,
        openedOn: s.openedOn,
        closedOn: c.date,
        closeMovementId: c.movementId,
        openMovementId: s.openMovementId,
        contracts: s.units,
        proceeds: s.proceeds,
        cost,
        gain: c.assigned ? 0 : s.proceeds - cost,
        carried: c.assigned ? s.proceeds : 0,
        term: taxLotTerm(s.openedOn, c.date, "short"),
      });
    }
  }
  for (const d of disposals) {
    const kind = closeKinds.get(d.movementId);
    const how = d.exercised ? "exercised" : kind === "expire" ? "expired" : "sold";
    for (const s of d.slices) {
      const proceeds = (d.proceeds * s.units) / d.units;
      out.push({
        side: "long",
        how,
        openedOn: s.acquiredOn,
        closedOn: d.date,
        closeMovementId: d.movementId,
        openMovementId: s.acquireMovementId,
        contracts: s.units,
        proceeds,
        cost: s.cost,
        gain: d.exercised ? 0 : proceeds - s.cost,
        carried: d.exercised ? s.cost : 0,
        term: taxLotTerm(s.acquiredOn, d.date, "long"),
      });
    }
  }
  return out.sort((a, b) => a.closedOn.localeCompare(b.closedOn) || a.closeMovementId - b.closeMovementId);
}

/** The share trade that settles an assignment, and how the contract's premium moves it. */
export function assignmentStockEffect(right: OptionRight, side: "long" | "short"): { stockKind: "stock_sell" | "stock_buy"; sign: 1 | -1 } {
  if (right === "C") return side === "short" ? { stockKind: "stock_sell", sign: 1 } : { stockKind: "stock_buy", sign: 1 };
  return side === "short" ? { stockKind: "stock_buy", sign: -1 } : { stockKind: "stock_sell", sign: -1 };
}

/**
 * The premium each assignment adds to its share trade, by the trade's movement id (signed USD,
 * applied to the trade's amount: proceeds on a sell, cost on a buy). Pure over the contract's
 * lot results; `stockTradeFor` maps the closing `option_assign` movement to its linked trade
 * (`option_assignments`) and states its flow kind. Throws when an assignment has no linked trade
 * or the trade's kind is not the one the contract's right and side settle with.
 */
export function optionAssignmentAdjustmentsFromResults(
  right: OptionRight,
  results: readonly OptionLotResult[],
  stockTradeFor: (optionMovementId: number) => { stockMovementId: number; flowKind: string } | null
): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of results) {
    if (r.how !== "assigned" && r.how !== "exercised") continue;
    const link = stockTradeFor(r.closeMovementId);
    if (!link) throw new Error(`Option lots: option_assign ${r.closeMovementId} has no linked share trade`);
    const { stockKind, sign } = assignmentStockEffect(right, r.side);
    if (link.flowKind !== stockKind) {
      throw new Error(`Option lots: assignment ${r.closeMovementId} settled by a ${link.flowKind}, a ${right} ${r.side} settles with a ${stockKind}`);
    }
    out.set(link.stockMovementId, (out.get(link.stockMovementId) ?? 0) + sign * r.carried);
  }
  return out;
}

/**
 * Every adjustment the options impose on one stock account's trades: feed it to
 * `equityTaxLotEventsFromRows` / `loadEquityTaxLotEvents`. Empty when no assignment settled a
 * trade of this account.
 */
export function optionAssignmentAdjustments(stockAccountId: number, method: TaxLotMethod | TaxLotSelector = "fifo"): EquityTradeAdjustments {
  const links = db
    .prepare(
      `SELECT oa.option_movement_id AS optionId, oa.stock_movement_id AS stockId, om.account_id AS contractId, sm.flow_kind AS stockKind
         FROM option_assignments oa
         JOIN movements om ON om.id = oa.option_movement_id
         JOIN movements sm ON sm.id = oa.stock_movement_id
        WHERE sm.from_account_id = ? OR sm.to_account_id = ?`
    )
    .all(stockAccountId, stockAccountId) as { optionId: number; stockId: number; contractId: number; stockKind: string }[];
  const out = new Map<number, number>();
  const byContract = new Map<number, typeof links>();
  for (const l of links) byContract.set(l.contractId, [...(byContract.get(l.contractId) ?? []), l]);
  for (const [contractId, contractLinks] of byContract) {
    const terms = requireOptionContract(contractId);
    const results = optionLotResults(loadOptionTaxLotEvents(contractId), method);
    const byOption = new Map(contractLinks.map((l) => [l.optionId, { stockMovementId: l.stockId, flowKind: l.stockKind }]));
    // Only this account's assignments are asked for; a contract's other assignments belong to other stock accounts.
    const mine = results.filter((r) => byOption.has(r.closeMovementId) || (r.how !== "assigned" && r.how !== "exercised"));
    for (const [id, delta] of optionAssignmentAdjustmentsFromResults(terms.right, mine, (m) => byOption.get(m) ?? null)) {
      out.set(id, (out.get(id) ?? 0) + delta);
    }
  }
  return out;
}
