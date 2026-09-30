/**
 * The purchases and sales of one equity account (`accounts.equity_ticker`), as tax-lot events.
 * A purchase is the `stock_buy` transfer INTO the account, a sale the `stock_sell` transfer OUT
 * of it; both carry the share count in `units_delta` (unsigned on transfers) and the amount in
 * the currency the trade settled in (USD, or CLP for a `.SN` listing). A reinvested dividend is
 * an ordinary `stock_buy`. Dividend payouts move no shares and are not lot events; any other
 * movement that moves shares throws, since its tax meaning is unknown.
 */
import { db } from "./db.js";
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
};

/** `currency` is null only when the account has no trades. */
export type EquityTaxLotEvents = { currency: string | null; events: TaxLotEvent[] };

/** Maps an account's movements (any order) to date-ordered lot events; purchases first within a day. */
export function equityTaxLotEventsFromRows(accountId: number, rows: readonly EquityTaxLotRow[]): EquityTaxLotEvents {
  const currencies = new Set<string>();
  const events: TaxLotEvent[] = [];
  for (const r of rows) {
    const units = r.units_delta == null ? null : Math.abs(r.units_delta);
    if (r.flow_kind === "stock_buy" && r.to_account_id === accountId) {
      if (units == null) throw new Error(`Tax lots: purchase ${r.id} has no share count`);
      currencies.add(r.currency);
      events.push({ kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost: r.amount });
    } else if (r.flow_kind === "stock_sell" && r.from_account_id === accountId) {
      if (units == null) throw new Error(`Tax lots: sale ${r.id} has no share count`);
      currencies.add(r.currency);
      events.push({ kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: r.amount });
    } else if (r.flow_kind === "dividend_payout" && r.from_account_id === accountId && units == null) {
      continue;
    } else {
      throw new Error(
        `Tax lots: account ${accountId} movement ${r.id} (${r.flow_kind ?? "no flow kind"}) is neither a purchase, a sale nor a dividend`
      );
    }
  }
  if (currencies.size > 1) {
    throw new Error(`Tax lots: account ${accountId} trades in ${[...currencies].join(" and ")}`);
  }
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
  return { currency: [...currencies][0] ?? null, events };
}

export function loadEquityTaxLotEvents(accountId: number): EquityTaxLotEvents {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, account_id, from_account_id, to_account_id, flow_kind, amount, currency, units_delta
         FROM movements
        WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
    )
    .all(accountId, accountId, accountId) as EquityTaxLotRow[];
  return equityTaxLotEventsFromRows(accountId, rows);
}
