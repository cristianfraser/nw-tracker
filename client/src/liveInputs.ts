import { replaceEqualDeep } from "@tanstack/react-query";

/**
 * Which live prices a server response read (2026-11-04). The server names them in
 * `X-Live-Inputs` (`server/src/liveInputsHeader.ts`): `none`, or tickers plus `$fx` (the live
 * dollar) and `$dimming` (the dashboard's sync dimming). The payload carries them under a
 * non-enumerable symbol, so on a live-price change the client refetches only the queries whose
 * response read something that moved (`useLiveQuotesStampInvalidation`). A payload without
 * them (no header, a scalar) is refetched on every change, as before.
 */

export type LiveInputs = { tickers: ReadonlySet<string>; fx: boolean; dimming: boolean };

/** What moved since the stamp the client saw (`GET /api/live-quotes/stamp?since=`). */
export type LiveQuoteMoves = { all: boolean; tickers: string[]; fx: boolean; dimming: boolean };

export const LIVE_INPUTS_HEADER = "X-Live-Inputs";

const LIVE_INPUTS = Symbol("liveInputs");

export function parseLiveInputs(header: string | null): LiveInputs | null {
  if (header == null) return null;
  const tickers = new Set<string>();
  let fx = false;
  let dimming = false;
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (token === "" || token === "none") continue;
    if (token === "$fx") fx = true;
    else if (token === "$dimming") dimming = true;
    else tickers.add(token.toUpperCase());
  }
  return { tickers, fx, dimming };
}

function canCarry(data: unknown): data is object {
  return data !== null && typeof data === "object";
}

/** Stores `inputs` on a parsed payload (objects and arrays only). */
export function attachLiveInputs<T>(data: T, inputs: LiveInputs | null): T {
  if (inputs != null && canCarry(data)) {
    Object.defineProperty(data, LIVE_INPUTS, { value: inputs, enumerable: false, configurable: true, writable: true });
  }
  return data;
}

export function liveInputsOf(data: unknown): LiveInputs | null {
  return canCarry(data) ? ((data as Record<symbol, LiveInputs | undefined>)[LIVE_INPUTS] ?? null) : null;
}

/**
 * React-query's structural sharing, keeping the new payload's inputs: when the new data equals
 * the old (or partly does), the result is (or contains) the old object, which carries the old
 * inputs or none.
 */
export function shareKeepingLiveInputs(oldData: unknown, newData: unknown): unknown {
  const shared = replaceEqualDeep(oldData, newData);
  const inputs = liveInputsOf(newData);
  if (inputs != null && shared !== newData) attachLiveInputs(shared, inputs);
  return shared;
}

/** Whether a query must refetch after `moves`: unknown inputs always do. */
export function queryReadsMovedPrice(data: unknown, moves: LiveQuoteMoves): boolean {
  if (moves.all) return true;
  const inputs = liveInputsOf(data);
  if (inputs == null) return true;
  if (moves.fx && inputs.fx) return true;
  if (moves.dimming && inputs.dimming) return true;
  return moves.tickers.some((t) => inputs.tickers.has(t.toUpperCase()));
}
