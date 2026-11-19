/**
 * What each broker calls the lines it holds (`broker_instruments`, migration 361), from its
 * positions read (`broker.positions`). Broker-neutral: Fintual's feeder sends it today, any broker's
 * can. Three uses, in order:
 *
 *  1. `registerBrokerPositionSymbols` (before the transaction): a symbol the instrument registry has
 *     never seen is registered from the price provider, so a first buy of it can create its account.
 *  2. `applyBrokerPositions`: the broker's symbol and name are kept, the name following the latest read.
 *  3. `brokerSymbolForFundName`: a notification that names only the company («… acciones de
 *     Anthropic PBC») resolves to the symbol the broker printed beside that same name.
 *
 * The name is compared as the broker prints it (case and spacing aside) — the broker's own
 * statement, never a fuzzy match: a share booked against the wrong holding is not recoverable.
 */
import type { BrokerPositionsApplyDetails, BrokerPositionsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { marketSymbol } from "./marketSymbols.js";
import { ensureRegisteredInstrument } from "./priceProviders/index.js";

export type BrokerSlugWithPositions = BrokerPositionsPayload["broker"];

export type BrokerPositionRegistration = {
  registered: string[];
  unregistered: { symbol: string; error: string }[];
};

/** The comparison key of a broker's name for a line: trimmed, single spaces, lower case. */
export function brokerInstrumentNameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Registers every position symbol the instrument registry lacks (Yahoo states its market and
 * currency). Runs before the receiver's transaction because it asks the network; on a dry run it
 * only lists what it would register. A symbol the provider cannot describe is reported, not thrown:
 * the read is still stored, and a buy of that symbol stays for a person (`not registered`).
 */
export async function registerBrokerPositionSymbols(
  payload: BrokerPositionsPayload,
  opts: { dryRun: boolean }
): Promise<BrokerPositionRegistration> {
  const out: BrokerPositionRegistration = { registered: [], unregistered: [] };
  for (const p of payload.positions) {
    if (marketSymbol(p.symbol) != null) continue;
    if (opts.dryRun) {
      out.registered.push(p.symbol);
      continue;
    }
    try {
      await ensureRegisteredInstrument(p.symbol, "yahoo");
      out.registered.push(p.symbol);
    } catch (err) {
      out.unregistered.push({ symbol: p.symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Keeps the broker's symbol → name pairs of one positions read. */
export function applyBrokerPositions(
  payload: BrokerPositionsPayload,
  registration: BrokerPositionRegistration
): BrokerPositionsApplyDetails {
  const existing = new Set(
    (db.prepare(`SELECT symbol FROM broker_instruments WHERE broker = ?`).all(payload.broker) as { symbol: string }[]).map(
      (r) => r.symbol
    )
  );
  const upsert = db.prepare(
    `INSERT INTO broker_instruments (broker, symbol, name, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (broker, symbol) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`
  );
  const newSymbols: string[] = [];
  for (const p of payload.positions) {
    if (!existing.has(p.symbol)) newSymbols.push(p.symbol);
    upsert.run(payload.broker, p.symbol, p.name.trim(), payload.read_at, payload.read_at);
  }
  return {
    broker: payload.broker,
    positions: payload.positions.length,
    new_symbols: newSymbols,
    registered: registration.registered,
    unregistered: registration.unregistered,
  };
}

/**
 * The symbol `broker` prints beside `fundName`: exactly one stored line with that name, else null
 * (none, or two symbols sharing a name — a person decides).
 */
export function brokerSymbolForFundName(broker: BrokerSlugWithPositions, fundName: string): string | null {
  const key = brokerInstrumentNameKey(fundName);
  const hits = (db.prepare(`SELECT symbol, name FROM broker_instruments WHERE broker = ?`).all(broker) as {
    symbol: string;
    name: string;
  }[]).filter((r) => brokerInstrumentNameKey(r.name) === key);
  return hits.length === 1 ? hits[0]!.symbol : null;
}
