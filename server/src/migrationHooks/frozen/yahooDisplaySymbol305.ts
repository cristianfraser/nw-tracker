/**
 * Frozen for migration 305's hook (`instrumentRegistry305.ts`): the Yahoo display-symbol rule as
 * `priceProviders/yahooSymbol.ts` stated it on 2026-11-15. A copy on purpose — the hook must keep
 * producing what it produced when its migration was written, whatever the adapter learns later.
 * Do not import this from runtime code and do not update it.
 */

/**
 * Yahoo's exchange suffixes and the ISO 10383 code of the exchange each names. A suffix is Yahoo's
 * spelling of a listing, never a fact the app values by: it only decides what a symbol shows
 * without the suffix ({@link yahooDisplaySymbol305}).
 */
const YAHOO_EXCHANGE_SUFFIXES_305: Readonly<Record<string, string | null>> = {
  ".SN": "XSGO",
  ".L": "XLON",
  ".NYB": null, // ICE Futures US (the dollar index DX-Y.NYB)
  ".TO": "XTSE",
  ".V": "XTSX",
  ".PA": "XPAR",
  ".AS": "XAMS",
  ".DE": "XETR",
  ".F": "XFRA",
  ".MI": "XMIL",
  ".MC": "XMAD",
  ".SW": "XSWX",
  ".HK": "XHKG",
  ".T": "XTKS",
  ".AX": "XASX",
  ".SA": "BVMF",
  ".MX": "XMEX",
  ".BA": "XBUE",
};

/**
 * The symbol without Yahoo's exchange suffix: `CFIETFIPSA.SN` → `CFIETFIPSA`, `CSPX.L` → `CSPX`,
 * `SPY` → `SPY`. A coin pair (`BTC-USD`), an index (`^GSPC`), an fx pair (`CLP=X`) and a symbol
 * whose last dot is not a known exchange suffix are kept whole.
 */
export function yahooDisplaySymbol305(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const dot = upper.lastIndexOf(".");
  if (dot <= 0) return upper;
  const suffix = upper.slice(dot);
  return suffix in YAHOO_EXCHANGE_SUFFIXES_305 ? upper.slice(0, dot) : upper;
}
