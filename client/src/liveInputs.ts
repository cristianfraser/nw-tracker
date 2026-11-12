import { replaceEqualDeep } from "@tanstack/react-query";
import type { LiveInputs, LiveQuoteMoves } from "nw-tracker-contracts/liveInputs";

export { LIVE_INPUTS_HEADER, parseLiveInputs } from "nw-tracker-contracts/liveInputs";
export type { LiveInputs, LiveQuoteMoves };

/**
 * Which live prices a server response read (2026-11-04). The server names them in
 * `X-Live-Inputs` (grammar in `nw-tracker-contracts/liveInputs`, shared with
 * `server/src/liveInputsHeader.ts`). The payload carries them under a
 * non-enumerable symbol, so on a live-price change the client refetches only the queries whose
 * response read something that moved (`useLiveQuotesStampInvalidation`). A payload without
 * them (no header, a scalar) is refetched on every change, as before.
 */

const LIVE_INPUTS = Symbol("liveInputs");

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
  if (moves.fx.some((pair) => inputs.fx.has(pair))) return true;
  if (moves.dimming && inputs.dimming) return true;
  return moves.tickers.some((t) => inputs.tickers.has(t.toUpperCase()));
}
