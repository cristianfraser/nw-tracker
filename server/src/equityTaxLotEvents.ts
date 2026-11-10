/**
 * The purchases and sales of one equity account (`accounts.equity_ticker`), as tax-lot events.
 * A purchase is the `stock_buy` transfer INTO the account, a sale the `stock_sell` transfer OUT
 * of it; both carry the share count in `units_delta` (unsigned on transfers) and the amount in
 * the currency the trade settled in (USD, or CLP for a `.SN` listing). A reinvested dividend is
 * an ordinary `stock_buy`. Dividend payouts move no shares and are not lot events; any other
 * movement that moves shares throws, since its tax meaning is unknown.
 */
import { db } from "./db.js";
import { transferToLegUnits } from "./movementTransfer.js";
import type { TaxLotEvent } from "./taxLots.js";

export type EquityTaxLotRow = {
  id: number;
  occurred_on: string;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  flow_kind: string | null;
  amount: number;
  currency: string;
  units_delta: number | null;
  counter_units_delta?: number | null;
};

/**
 * What an option assignment adds to a share trade it settled (`optionTaxLotEvents.ts`): a signed
 * USD delta applied to the trade's amount — proceeds on a `stock_sell`, cost on a `stock_buy` —
 * keyed by the trade's movement id. No entry (the default) leaves the trade as the ledger has it.
 */
export type EquityTradeAdjustments = ReadonlyMap<number, number>;

/** `currency` is null only when the account has no trades. */
export type EquityTaxLotEvents = { currency: string | null; events: TaxLotEvent[] };

/** Maps an account's movements (any order) to date-ordered lot events; purchases first within a day. */
export function equityTaxLotEventsFromRows(
  accountId: number,
  rows: readonly EquityTaxLotRow[],
  adjustments: EquityTradeAdjustments = new Map()
): EquityTaxLotEvents {
  const currencies = new Set<string>();
  const events: TaxLotEvent[] = [];
  const splits: EquityTaxLotRow[] = [];
  for (const r of rows) {
    const units = r.units_delta == null ? null : Math.abs(r.units_delta);
    if (r.flow_kind === "stock_buy" && r.to_account_id === accountId) {
      // The to-leg's own count (`transferToLegUnits`); a share buy never carries a counter today.
      const bought = transferToLegUnits(r);
      if (bought == null) throw new Error(`Tax lots: purchase ${r.id} has no share count`);
      currencies.add(r.currency);
      events.push({ kind: "acquire", date: r.occurred_on, movementId: r.id, units: Math.abs(bought), cost: r.amount + (adjustments.get(r.id) ?? 0) });
    } else if (r.flow_kind === "stock_sell" && r.from_account_id === accountId) {
      if (units == null) throw new Error(`Tax lots: sale ${r.id} has no share count`);
      currencies.add(r.currency);
      events.push({ kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: r.amount + (adjustments.get(r.id) ?? 0) });
    } else if (r.flow_kind === "dividend_payout" && r.from_account_id === accountId && units == null) {
      continue;
    } else if (r.flow_kind === "stock_split" && r.account_id === accountId) {
      if (r.units_delta == null || r.units_delta === 0) throw new Error(`Tax lots: split ${r.id} adds no shares`);
      splits.push(r);
    } else {
      throw new Error(
        `Tax lots: account ${accountId} movement ${r.id} (${r.flow_kind ?? "no flow kind"}) is neither a purchase, a sale nor a dividend`
      );
    }
  }
  if (currencies.size > 1) {
    throw new Error(`Tax lots: account ${accountId} trades in ${[...currencies].join(" and ")}`);
  }
  // A split takes effect at the open of its ex-date: before that day's trades.
  const rank = (e: TaxLotEvent) => (e.kind === "split" ? 0 : e.kind === "acquire" ? 1 : 2);
  const sharesDelta = (e: TaxLotEvent) => (e.kind === "acquire" ? e.units : e.kind === "dispose" ? -e.units : 0);
  events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
  // A split's ratio is the shares it added over those held before it.
  let held = 0;
  const withSplits: TaxLotEvent[] = [];
  const pending = [...splits].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.id - b.id);
  const flushSplitsThrough = (date: string, inclusive: boolean) => {
    while (pending.length > 0 && (inclusive ? pending[0]!.occurred_on <= date : pending[0]!.occurred_on < date)) {
      const s = pending.shift()!;
      if (!(held > 0)) throw new Error(`Tax lots: split ${s.id} on account ${accountId} with no shares held`);
      const ratio = (held + s.units_delta!) / held;
      withSplits.push({ kind: "split", date: s.occurred_on, movementId: s.id, units: s.units_delta!, ratio });
      held *= ratio;
    }
  };
  for (const e of events) {
    flushSplitsThrough(e.date, true);
    withSplits.push(e);
    held += sharesDelta(e);
  }
  flushSplitsThrough("9999-12-31", true);
  return { currency: [...currencies][0] ?? null, events: withSplits };
}

export function loadEquityTaxLotEvents(accountId: number, adjustments?: EquityTradeAdjustments): EquityTaxLotEvents {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, from_account_id, to_account_id, flow_kind, amount, currency, units_delta,
              counter_units_delta
         FROM movements
        WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
    )
    .all(accountId, accountId, accountId) as EquityTaxLotRow[];
  return equityTaxLotEventsFromRows(accountId, rows, adjustments);
}
