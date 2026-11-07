/**
 * The `X-Live-Inputs` response header (docs/untangle-plan.md F8): which live inputs a GET API
 * response read — `none`, or the tickers whose live quote it read plus `$fx` (the live dollar) and
 * `$dimming` (the dashboard's sync dimming), comma-separated. The server writes it
 * (`server/src/liveInputsHeader.ts`), the client reads it to refetch a query only when one of its
 * inputs moved (`client/src/liveInputs.ts`).
 */

export const LIVE_INPUTS_HEADER = "X-Live-Inputs";

const FX_TOKEN = "$fx";
const DIMMING_TOKEN = "$dimming";
const NONE_TOKEN = "none";

export type LiveInputs = { tickers: ReadonlySet<string>; fx: boolean; dimming: boolean };

/** What moved since the stamp the client saw (`GET /api/live-quotes/stamp?since=`). */
export type LiveQuoteMoves = { all: boolean; tickers: string[]; fx: boolean; dimming: boolean };

export function formatLiveInputs(inputs: { tickers: Iterable<string>; fx: boolean; dimming: boolean }): string {
  const tokens = [...inputs.tickers].sort();
  if (inputs.fx) tokens.unshift(FX_TOKEN);
  if (inputs.dimming) tokens.unshift(DIMMING_TOKEN);
  return tokens.length > 0 ? tokens.join(",") : NONE_TOKEN;
}

/** Null when there is no header (the response names nothing: refetch it on every move). */
export function parseLiveInputs(header: string | null): LiveInputs | null {
  if (header == null) return null;
  const tickers = new Set<string>();
  let fx = false;
  let dimming = false;
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (token === "" || token === NONE_TOKEN) continue;
    if (token === FX_TOKEN) fx = true;
    else if (token === DIMMING_TOKEN) dimming = true;
    else tickers.add(token.toUpperCase());
  }
  return { tickers, fx, dimming };
}
