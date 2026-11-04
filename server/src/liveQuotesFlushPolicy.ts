/**
 * When streamed prices are written (`yahooPriceStream.ts`), as a pure decision.
 *
 * The stream delivers several prices a second, and each write that moves a price rebuilds the
 * dashboard caches and makes the client refetch, flashing the cells that changed. The rule
 * (user's choice, 2026-11-04): a flash means the price really moved, and a holding flashes at
 * most about every 30 s. So every check writes every unit whose pending price differs from the
 * one it last wrote and whose next write is due — several at once when several really moved —
 * but never sooner than `minFlushGapMs` after the previous write that changed something, which
 * bounds the rebuilds. The caller sets each unit's next due time after writing it with a random
 * spread (`nextUnitDueAtMs`): with a fixed interval, every liquid ETF written together at connect
 * stayed due together and flashed together every 30 s (seen on the first rehearsal).
 *
 * A unit is one symbol, except the members of a basket valued together (the Risky Norris proxy,
 * one APV mark): they are written together, so the account moves once per interval rather than
 * every time one of its ETFs is due.
 *
 * Re-stamps keep a quiet symbol's row inside the readers' freshness window: a symbol the stream
 * still covers whose row is `restampAfterMs` old is written again at the same price, which
 * changes nothing and invalidates nothing.
 */

export type StreamPrice = {
  symbol: string;
  price: number;
  timeMs: number;
  previousClose: number | null;
};

export type WrittenPrice = { quote: StreamPrice; atMs: number };

export type FlushInput = {
  nowMs: number;
  /** Latest in-session price per symbol, not yet compared with what was written. */
  pending: ReadonlyMap<string, StreamPrice>;
  /** What each symbol's row holds, and when it was written. */
  written: ReadonlyMap<string, WrittenPrice>;
  /** Symbol → unit key; symbols absent are their own unit. */
  unitOf: ReadonlyMap<string, string>;
  /** When each unit may be written again; absent = now. */
  unitDueAtMs: ReadonlyMap<string, number>;
  /** The last write that changed something, or null. */
  lastChangeWriteAtMs: number | null;
  /** Symbols the stream covers now (eligible for a re-stamp). */
  covered: ReadonlySet<string>;
  minFlushGapMs: number;
  restampAfterMs: number;
};

export type FlushPlan = {
  /** Prices that differ from their row: written, stamped and invalidated. */
  changes: StreamPrice[];
  /** Unit keys the changes belong to (set their next due time). */
  units: string[];
  /** Unchanged prices written again so their row stays fresh. */
  restamps: StreamPrice[];
};

function differs(pending: StreamPrice, written: WrittenPrice | undefined): boolean {
  return written == null || written.quote.price !== pending.price;
}

export function pickNextFlush(input: FlushInput): FlushPlan {
  const { nowMs } = input;
  const unitKey = (symbol: string) => input.unitOf.get(symbol) ?? symbol;

  const changes: StreamPrice[] = [];
  const units = new Set<string>();
  const gapOk =
    input.lastChangeWriteAtMs == null || nowMs - input.lastChangeWriteAtMs >= input.minFlushGapMs;
  if (gapOk) {
    const dueUnits = new Set<string>();
    for (const [symbol, quote] of input.pending) {
      if (!differs(quote, input.written.get(symbol))) continue;
      const unit = unitKey(symbol);
      const due = input.unitDueAtMs.get(unit);
      if (due == null || nowMs >= due) dueUnits.add(unit);
    }
    for (const [symbol, quote] of input.pending) {
      const unit = unitKey(symbol);
      if (!dueUnits.has(unit) || !differs(quote, input.written.get(symbol))) continue;
      changes.push(quote);
      units.add(unit);
    }
  }

  const changed = new Set(changes.map((q) => q.symbol));
  const restamps: StreamPrice[] = [];
  for (const [symbol, w] of input.written) {
    if (changed.has(symbol) || !input.covered.has(symbol)) continue;
    if (nowMs - w.atMs >= input.restampAfterMs) restamps.push(w.quote);
  }

  const bySymbol = (a: StreamPrice, b: StreamPrice) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  return { changes: changes.sort(bySymbol), units: [...units].sort(), restamps: restamps.sort(bySymbol) };
}

/**
 * When a unit just written may be written again: `minIntervalMs` plus a random share of
 * `spreadMs` (`random` in [0, 1)), so units written together drift apart.
 */
export function nextUnitDueAtMs(nowMs: number, minIntervalMs: number, spreadMs: number, random: number): number {
  return nowMs + minIntervalMs + Math.floor(random * spreadMs);
}
