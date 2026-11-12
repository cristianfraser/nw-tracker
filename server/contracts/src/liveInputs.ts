/**
 * The `X-Live-Inputs` response header (docs/untangle-plan.md F8): which live inputs a GET API
 * response read — `none`, or the tickers whose live quote it read plus one token per live
 * exchange rate it read and `$dimming` (the dashboard's sync dimming), comma-separated. A live rate
 * is named by its pair key (`<BASE>_<QUOTE>`, upper case, as `live_market_quotes` stores it): `$fx`
 * is USD/CLP (the live dollar, the token it has always had), `$fx:EUR_USD` any other pair
 * (2026-11-12). The server writes it (`server/src/liveInputsHeader.ts`), the client reads it to
 * refetch a query only when one of its inputs moved (`client/src/liveInputs.ts`).
 */

export const LIVE_INPUTS_HEADER = "X-Live-Inputs";

/** The live dollar's pair key. */
export const USD_CLP_PAIR_KEY = "USD_CLP";

const FX_TOKEN = "$fx";
const FX_PAIR_PREFIX = "$fx:";
const DIMMING_TOKEN = "$dimming";
const NONE_TOKEN = "none";

/** `fx`: the pair keys of the live rates read (`USD_CLP`, `EUR_USD`, …). */
export type LiveInputs = { tickers: ReadonlySet<string>; fx: ReadonlySet<string>; dimming: boolean };

/** What moved since the stamp the client saw (`GET /api/live-quotes/stamp?since=`); `fx`: pair keys. */
export type LiveQuoteMoves = { all: boolean; tickers: string[]; fx: string[]; dimming: boolean };

function fxToken(pairKey: string): string {
  return pairKey === USD_CLP_PAIR_KEY ? FX_TOKEN : `${FX_PAIR_PREFIX}${pairKey}`;
}

/** USD/CLP first, then the other pairs by key. */
export function sortFxPairKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) =>
    a === USD_CLP_PAIR_KEY ? -1 : b === USD_CLP_PAIR_KEY ? 1 : a < b ? -1 : a > b ? 1 : 0
  );
}

export function formatLiveInputs(inputs: { tickers: Iterable<string>; fx: Iterable<string>; dimming: boolean }): string {
  const tokens = [...inputs.tickers].sort();
  tokens.unshift(...sortFxPairKeys(inputs.fx).map(fxToken));
  if (inputs.dimming) tokens.unshift(DIMMING_TOKEN);
  return tokens.length > 0 ? tokens.join(",") : NONE_TOKEN;
}

/** Null when there is no header (the response names nothing: refetch it on every move). */
export function parseLiveInputs(header: string | null): LiveInputs | null {
  if (header == null) return null;
  const tickers = new Set<string>();
  const fx = new Set<string>();
  let dimming = false;
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (token === "" || token === NONE_TOKEN) continue;
    if (token === FX_TOKEN) fx.add(USD_CLP_PAIR_KEY);
    else if (token.startsWith(FX_PAIR_PREFIX)) fx.add(token.slice(FX_PAIR_PREFIX.length).toUpperCase());
    else if (token === DIMMING_TOKEN) dimming = true;
    else tickers.add(token.toUpperCase());
  }
  return { tickers, fx, dimming };
}
