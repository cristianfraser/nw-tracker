/**
 * Bolsa de Santiago point history (unofficial site API). Daily EOD closes for `.SN`
 * instruments whose history Yahoo does not carry (e.g. CFIETFIPSA.SN — Yahoo bars
 * only accumulate from 2026-07-02 onward).
 *
 * `GET /api/RV_Instrumentos/getPointHistGAT?nemo=<NEMO>` returns daily OHLC bars
 * (exchange trading days, CLP) for up to ~10 years back, capped at the instrument's
 * listing date (CFIETFIPSA started trading 2025-05-12 — inception Mayo 2025).
 * Works without cookies/auth; requires a normal browser User-Agent.
 */

import { requireMarketSymbol } from "./marketSymbols.js";
import type { EodCloseSeries } from "./equityYahooEod.js";
import { BROWSER_USER_AGENT, fetchOutboundText } from "./outboundFetch.js";

type BolsaPointHistRow = {
  DATE?: string;
  CLOSE?: number;
};

type BolsaPointHistJson = {
  listaResult?: BolsaPointHistRow[];
};

/**
 * Bolsa de Santiago nemo of a registered Santiago instrument: its display symbol
 * (CFIETFIPSA.SN → CFIETFIPSA), read from the instrument registry, never from the ticker's spelling.
 */
export function bolsaSantiagoNemoForTicker(ticker: string): string {
  const row = requireMarketSymbol(ticker);
  if (row.market_kind !== "santiago" || row.quote_currency !== "clp") { // convention-ok: the Bolsa de Santiago quotes in pesos
    throw new Error(`bolsaSantiagoNemoForTicker: ${ticker} is registered as ${row.market_kind}/${row.quote_currency}, not a Bolsa de Santiago peso instrument`);
  }
  const nemo = row.display_symbol;
  if (!/^[A-Z0-9]+$/.test(nemo)) {
    throw new Error(`bolsaSantiagoNemoForTicker: invalid nemo '${nemo}' for ${ticker}`);
  }
  return nemo;
}

/** Daily closes (CLP, ascending trade dates) from Bolsa de Santiago. Throws on invalid payload. */
export async function fetchBolsaSantiagoDailyCloses(ticker: string): Promise<EodCloseSeries> {
  const nemo = bolsaSantiagoNemoForTicker(ticker);
  const url = `https://www.bolsadesantiago.com/api/RV_Instrumentos/getPointHistGAT?nemo=${encodeURIComponent(nemo)}`;
  const res = await fetchOutboundText({
    label: `bolsa-santiago:${nemo}`,
    url,
    userAgent: BROWSER_USER_AGENT,
    accept: "application/json",
  });
  if (!res.ok) {
    throw new Error(`Bolsa de Santiago point history HTTP ${res.status} for ${nemo}`);
  }
  const j = JSON.parse(res.text) as BolsaPointHistJson;
  const rows = j.listaResult;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Bolsa de Santiago point history empty for ${nemo}`);
  }

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const date = row.DATE;
    const close = row.CLOSE;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Bolsa de Santiago point history (${nemo}): invalid DATE ${JSON.stringify(date)}`);
    }
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) {
      throw new Error(`Bolsa de Santiago point history (${nemo}): invalid CLOSE for ${date}`);
    }
    if (byDate.has(date)) {
      throw new Error(`Bolsa de Santiago point history (${nemo}): duplicate DATE ${date}`);
    }
    byDate.set(date, close);
  }

  const dates = [...byDate.keys()].sort();
  return { dates, closes: dates.map((d) => byDate.get(d)!) };
}
