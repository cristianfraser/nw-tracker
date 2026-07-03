/**
 * Bolsa de Santiago point history (unofficial site API). Daily EOD closes for `.SN`
 * instruments whose history Yahoo does not carry (e.g. CFIETFIPSA.SN — Yahoo bars
 * only accumulate from 2026-07-02 onward).
 *
 * `GET /api/RV_Instrumentos/getPointHistGAT?nemo=<NEMO>` returns ~14 months of daily
 * OHLC bars (exchange trading days, CLP) — enough for the watchlist YoY/YTD anchors.
 * Works without cookies/auth; requires a normal browser User-Agent.
 */

import { equityQuoteCurrency } from "./equityQuote.js";
import type { EodCloseSeries } from "./equityYahooEod.js";
import { fetchOut } from "./httpOut.js";

const CHART_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type BolsaPointHistRow = {
  DATE?: string;
  CLOSE?: number;
};

type BolsaPointHistJson = {
  listaResult?: BolsaPointHistRow[];
};

/** Bolsa de Santiago nemo for a Yahoo `.SN` symbol (CFIETFIPSA.SN → CFIETFIPSA). */
export function bolsaSantiagoNemoForTicker(ticker: string): string {
  const sym = ticker.trim().toUpperCase();
  if (!sym.endsWith(".SN") || equityQuoteCurrency(sym) !== "clp") {
    throw new Error(`bolsaSantiagoNemoForTicker: ${ticker} is not a Bolsa de Santiago .SN symbol`);
  }
  const nemo = sym.slice(0, -".SN".length);
  if (!/^[A-Z0-9]+$/.test(nemo)) {
    throw new Error(`bolsaSantiagoNemoForTicker: invalid nemo '${nemo}' from ${ticker}`);
  }
  return nemo;
}

/** Daily closes (CLP, ascending trade dates) from Bolsa de Santiago. Throws on invalid payload. */
export async function fetchBolsaSantiagoDailyCloses(ticker: string): Promise<EodCloseSeries> {
  const nemo = bolsaSantiagoNemoForTicker(ticker);
  const url = `https://www.bolsadesantiago.com/api/RV_Instrumentos/getPointHistGAT?nemo=${encodeURIComponent(nemo)}`;
  const res = await fetchOut(`bolsa-santiago:${nemo}`, url, {
    headers: { "User-Agent": CHART_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Bolsa de Santiago point history HTTP ${res.status} for ${nemo}`);
  }
  const j = (await res.json()) as BolsaPointHistJson;
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
