/**
 * Fintual's stock positions, read from its own `/gql/` (`stocksPositionsV2`, the query its
 * «Acciones» page sends, with the asset's symbol and name): each line's symbol, Fintual's name for
 * it and the shares. Sent as `broker.positions`, so a buy mail that names only the company resolves
 * to the symbol Fintual prints beside that name, and a symbol the app has never priced is
 * registered before the buy books. A changed shape throws.
 */
import type { BrokerPositionsPayload } from "nw-tracker-contracts";
import { fintualGql } from "./gql.js";

const OPERATION = "NwTrackerStocksPositions";
const QUERY = `query ${OPERATION} { stocksPositionsV2 { positions { id shares asset { id symbol name } } } }`;

type Position = BrokerPositionsPayload["positions"][number];

/** Shares as the decimal string the contract carries (Fintual answers a JSON number). */
function sharesString(shares: number, symbol: string): string {
  if (!Number.isFinite(shares) || shares < 0) throw new Error(`Fintual position ${symbol}: shares ${shares}`);
  const s = String(shares);
  if (/e/i.test(s)) return shares.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export function decodeFintualPositions(data: unknown): Position[] {
  const positions = (data as { stocksPositionsV2?: { positions?: unknown } } | null)?.stocksPositionsV2?.positions;
  if (!Array.isArray(positions)) throw new Error("Fintual /gql: stocksPositionsV2.positions missing or not a list");
  return positions.map((p: unknown) => {
    const { shares, asset } = (p ?? {}) as { shares?: unknown; asset?: { symbol?: unknown; name?: unknown } };
    const symbol = asset?.symbol;
    const name = asset?.name;
    if (typeof symbol !== "string" || !symbol.trim()) throw new Error(`Fintual position without a symbol: ${JSON.stringify(p)}`);
    if (typeof name !== "string" || !name.trim()) throw new Error(`Fintual position ${symbol} without a name`);
    if (typeof shares !== "number") throw new Error(`Fintual position ${symbol}: shares ${JSON.stringify(shares)}`);
    return { symbol: symbol.trim().toUpperCase(), name: name.trim(), shares: sharesString(shares, symbol) };
  });
}

export async function fetchFintualPositions(): Promise<Position[]> {
  return decodeFintualPositions(await fintualGql(OPERATION, QUERY, {}, { referer: "https://fintual.cl/f/stocks/" }));
}
