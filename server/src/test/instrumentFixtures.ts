/**
 * Synthetic instruments for Vitest. Every ticker a test values must be in the instrument registry
 * (`market_symbols`) — a reader never guesses a market or a currency from a ticker's spelling — so
 * fixtures declare theirs here, source `declared`, as the demo generator does for its own.
 */
import { marketSymbol, registerInstrument, type InstrumentFacts, type MarketSymbolRow } from "../marketSymbols.js";

const US_ETF: Omit<InstrumentFacts, "display_symbol"> = {
  quote_currency: "usd",
  market_kind: "nyse",
  exchange: null,
  name: null,
  instrument_type: "ETF",
};

/** Registers `ticker` with `facts` (a US-listed dollar ETF unless stated), source `declared`. */
export function declareTestInstrument(ticker: string, facts: Partial<InstrumentFacts> = {}): MarketSymbolRow {
  return registerInstrument(ticker, { ...US_ETF, display_symbol: ticker, ...facts }, "declared");
}

const SANTIAGO: Partial<InstrumentFacts> = { market_kind: "santiago", quote_currency: "clp" };
const LONDON: Partial<InstrumentFacts> = { market_kind: "london", quote_currency: "usd" };
const COIN: Partial<InstrumentFacts> = { market_kind: "crypto24", quote_currency: "usd", instrument_type: "CRYPTOCURRENCY" };

/**
 * The synthetic and well-known tickers the suites value. Registered once per test file (missing
 * rows only) by `vitest.setup.ts`, so a fixture that writes an account on one of them finds it.
 */
export const VITEST_INSTRUMENTS: Readonly<Record<string, Partial<InstrumentFacts>>> = {
  "VITEST.SN": { ...SANTIAGO, display_symbol: "VITEST" },
  "CFIETFIPSA.SN": { ...SANTIAGO, display_symbol: "CFIETFIPSA" },
  "VITEST.L": { ...LONDON, display_symbol: "VITEST" },
  "CSPX.L": { ...LONDON, display_symbol: "CSPX" },
  "VWRA.L": { ...LONDON, display_symbol: "VWRA" },
  "BTC-USD": COIN,
  "ETH-USD": COIN,
  // Synthetic Bolsa de Santiago lines (each suite's own).
  "VITESTDAILY.SN": { ...SANTIAGO, display_symbol: "VITESTDAILY" },
  "VITESTART107.SN": { ...SANTIAGO, display_symbol: "VITESTART107" },
  "VITESTWATERFALLA.SN": { ...SANTIAGO, display_symbol: "VITESTWATERFALLA" },
  "VITESTMARKS.SN": { ...SANTIAGO, display_symbol: "VITESTMARKS" },
  "VITESTRET.SN": { ...SANTIAGO, display_symbol: "VITESTRET" },
  "VITESTMARKTOT.SN": { ...SANTIAGO, display_symbol: "VITESTMARKTOT" },
  "VITEST_WL.SN": { ...SANTIAGO, display_symbol: "VITEST_WL" },
  "VTIPSA.SN": { ...SANTIAGO, display_symbol: "VTIPSA" },
  "VITESTWATERFALLB.SN": { ...SANTIAGO, display_symbol: "VITESTWATERFALLB" },
  // The ICE dollar index: points on the New York calendar.
  "DX-Y.NYB": { quote_currency: "none", market_kind: "nyse", instrument_type: "INDEX", display_symbol: "DX-Y" },
  // US-listed dollar lines (synthetic suites' tickers and a few real ones the suites hold).
  VITEST: {},
  SPY_TEST_DELTA: {},
  VTSPLITX: {},
  VTSPLITM: {},
  VTPB1: {},
  VTST: {},
  VTEST: {},
  VTOPTX: {},
  VTRACBUY: {},
  VTLK: {},
  VITESTRNA: {},
  VITESTRNC: {},
  VITESTRNE: {},
  VITESTRNSCA: {},
  VITESTRNSCB: {},
  VITESTRNB: {},
  VITESTRND: {},
  VITESTRNF: {},
  VTPB2: {},
  VITESTUC: {},
  VITESTHOLDUSD: {},
  VITEST_WL_USD: {},
  VITEST_PM_USD: {},
  ZZBENCHTEST: {},
  VHFU2: {},
  VUSD: {},
  VFIRST: {},
  VDRC: {},
  LIVE_DB_TEST: {},
  QQQ: {},
  VEA: {},
  OILK: {},
  SOXQ: {},
  SOXX: {},
};

export function ensureVitestInstrumentFixtures(): void {
  for (const [ticker, facts] of Object.entries(VITEST_INSTRUMENTS)) {
    if (marketSymbol(ticker) == null) declareTestInstrument(ticker, facts);
  }
}
