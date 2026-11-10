/**
 * The shape of a Yahoo symbol — the only place in the server that reads a ticker's spelling.
 *
 * Pure (no database, no network): migration 305's hook imports it while `db.ts` is still loading.
 * Everything else asks the instrument registry (`marketSymbols.ts`) for an instrument's facts.
 */

/**
 * Yahoo's exchange suffixes and the ISO 10383 code of the exchange each names. A suffix is Yahoo's
 * spelling of a listing, never a fact the app values by: it only decides what a symbol shows
 * without the suffix ({@link yahooDisplaySymbol}).
 */
const YAHOO_EXCHANGE_SUFFIXES: Readonly<Record<string, string | null>> = {
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
export function yahooDisplaySymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const dot = upper.lastIndexOf(".");
  if (dot <= 0) return upper;
  const suffix = upper.slice(dot);
  return suffix in YAHOO_EXCHANGE_SUFFIXES ? upper.slice(0, dot) : upper;
}

/** Yahoo's chart `exchangeName` codes → ISO 10383. Unknown codes read null, never a throw. */
const YAHOO_EXCHANGE_CODE_MIC: Readonly<Record<string, string>> = {
  NMS: "XNAS",
  NGM: "XNAS",
  NCM: "XNAS",
  NAS: "XNAS",
  NYQ: "XNYS",
  NYS: "XNYS",
  PCX: "ARCX",
  ASE: "XASE",
  BTS: "BATS",
  LSE: "XLON",
  SGO: "XSGO",
};

/** Yahoo's `fullExchangeName` → ISO 10383 (what the rows of 210–304 stored as `exchange`). */
const YAHOO_FULL_EXCHANGE_NAME_MIC: Readonly<Record<string, string>> = {
  NasdaqGS: "XNAS",
  NasdaqGM: "XNAS",
  NasdaqCM: "XNAS",
  Nasdaq: "XNAS",
  NYSE: "XNYS",
  NYSEArca: "ARCX",
  "NYSE American": "XASE",
  "Cboe US": "BATS",
  BATS: "BATS",
  LSE: "XLON",
  Santiago: "XSGO",
};

/**
 * The ISO 10383 code of the exchange Yahoo names, from its code (`PCX`) or else its full name
 * (`NYSEArca`); null when Yahoo names none the table knows (a coin, an index, an exchange the app
 * does not value on).
 */
export function yahooExchangeMic(exchangeCode: string | null | undefined, fullExchangeName: string | null | undefined): string | null {
  const code = exchangeCode?.trim();
  if (code && YAHOO_EXCHANGE_CODE_MIC[code]) return YAHOO_EXCHANGE_CODE_MIC[code]!;
  const full = fullExchangeName?.trim();
  if (full && YAHOO_FULL_EXCHANGE_NAME_MIC[full]) return YAHOO_FULL_EXCHANGE_NAME_MIC[full]!;
  return null;
}
