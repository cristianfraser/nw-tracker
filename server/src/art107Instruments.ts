/**
 * Which equity accounts hold an art. 107 LIR instrument (`art107_instruments`, migration 230):
 * cuotas of a fondo de inversión or fondo mutuo (`fund`, art. 107 N°2, F22 code 1813) or a
 * Chilean S.A. share (`share`, N°1, code 1809). The table is the only source — a `.SN` ticker is
 * not an art. 107 instrument unless it is listed there.
 */
import { db } from "./db.js";

export type Art107Kind = "fund" | "share";

export type Art107Account = { id: number; name: string; ticker: string; kind: Art107Kind };

export function art107InstrumentKind(ticker: string): Art107Kind | null {
  const r = db.prepare(`SELECT kind FROM art107_instruments WHERE ticker = ?`).get(ticker) as
    | { kind: Art107Kind }
    | undefined;
  return r?.kind ?? null;
}

/** Accounts whose `equity_ticker` is an art. 107 instrument, by id. */
export function listArt107Accounts(): Art107Account[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.equity_ticker AS ticker, i.kind
         FROM accounts a
         JOIN art107_instruments i ON i.ticker = a.equity_ticker
        ORDER BY a.id`
    )
    .all() as Art107Account[];
}
