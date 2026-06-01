import { db } from "./db.js";
import { buildFxCoverage, type FxCoverage } from "./fxCoverage.js";

const MAX_POINTS = 25_000;

const EQUITY_TICKER_ORDER = ["SPY", "VEA", "BTC-USD", "ETH-USD"] as const;

const FUND_SERIES_ORDER = [
  "fintual_cert_reserva2",
  "fintual_cert_risky_norris",
  "fintual_cert_apv_a",
  "fintual_cert_apv_b",
  "fintual_risky_norris",
  "fintual_risky_norris_apv",
  "afp_uno_cuota_a",
] as const;

function sortEquityTickers(tickers: string[]): string[] {
  const uniq = [...new Set(tickers)];
  return uniq.sort((a, b) => {
    const ia = (EQUITY_TICKER_ORDER as readonly string[]).indexOf(a);
    const ib = (EQUITY_TICKER_ORDER as readonly string[]).indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

function sortFundSeriesKeys(keys: string[]): string[] {
  const uniq = [...new Set(keys)];
  return uniq.sort((a, b) => {
    const ia = (FUND_SERIES_ORDER as readonly string[]).indexOf(a);
    const ib = (FUND_SERIES_ORDER as readonly string[]).indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

type Bar = { date: string; v: number };

export function getMarketSeriesPayload(): {
  points: {
    as_of_date: string;
    clp_per_usd: number | null;
    clp_per_uf: number | null;
    clp_per_eur: number | null;
    ipc_index: number | null;
    utm_clp: number | null;
    equity_usd: Record<string, number | null>;
    equity_clp: Record<string, number | null>;
    fund_unit_clp: Record<string, number | null>;
    fund_unit_usd: Record<string, number | null>;
  }[];
  equity_tickers: string[];
  fund_series_keys: string[];
  /** Direct `fx_daily` rows for Rates FX charts (one point per observation). */
  fx_usd_clp: { date: string; value: number }[];
  eur_clp: { date: string; value: number }[];
  fx_coverage: FxCoverage;
} {
  type FxR = { date: string; clp_per_usd: number };
  type UfR = { date: string; clp_per_uf: number };
  type EurR = { date: string; clp_per_eur: number };
  type IpcR = { date: string; ipc_index: number };
  type UtmR = { date: string; utm_clp: number };
  type EqR = { ticker: string; date: string; close_usd: number };
  type FuR = { series_key: string; day: string; unit_value_clp: number };

  const fxRows = db.prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date ASC`).all() as FxR[];
  const ufRows = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date ASC`).all() as UfR[];
  const eurRows = db.prepare(`SELECT date, clp_per_eur FROM eur_daily ORDER BY date ASC`).all() as EurR[];
  const ipcRows = db.prepare(`SELECT date, ipc_index FROM ipc_daily ORDER BY date ASC`).all() as IpcR[];
  let utmRows: UtmR[] = [];
  try {
    utmRows = db.prepare(`SELECT date, utm_clp FROM utm_daily ORDER BY date ASC`).all() as UtmR[];
  } catch {
    utmRows = [];
  }
  const eqRows = db
    .prepare(`SELECT ticker, trade_date AS date, close_usd FROM equity_daily ORDER BY ticker, trade_date ASC`)
    .all() as EqR[];
  const fuRows = db
    .prepare(`SELECT series_key, day, unit_value_clp FROM fund_unit_daily ORDER BY series_key, day ASC`)
    .all() as FuR[];

  const equityTickers = sortEquityTickers(eqRows.map((r) => r.ticker));
  const fundKeys = sortFundSeriesKeys(fuRows.map((r) => r.series_key));

  const eqBars = new Map<string, Bar[]>();
  for (const t of equityTickers) eqBars.set(t, []);
  for (const r of eqRows) {
    const arr = eqBars.get(r.ticker);
    if (arr) arr.push({ date: r.date, v: r.close_usd });
  }

  const fuBars = new Map<string, Bar[]>();
  for (const k of fundKeys) fuBars.set(k, []);
  for (const r of fuRows) {
    const arr = fuBars.get(r.series_key);
    if (arr) arr.push({ date: r.day, v: r.unit_value_clp });
  }

  const dateSet = new Set<string>();
  for (const r of fxRows) dateSet.add(r.date);
  for (const r of ufRows) dateSet.add(r.date);
  for (const r of eurRows) dateSet.add(r.date);
  for (const r of ipcRows) dateSet.add(r.date);
  for (const r of utmRows) dateSet.add(r.date);
  for (const r of eqRows) dateSet.add(r.date);
  for (const r of fuRows) dateSet.add(r.day);

  const sorted = [...dateSet].sort();
  const slice =
    sorted.length > MAX_POINTS ? sorted.slice(sorted.length - MAX_POINTS) : sorted;

  let fxPtr = -1;
  let lastFx: number | null = null;
  let ufPtr = -1;
  let lastUf: number | null = null;
  let eurPtr = -1;
  let lastEur: number | null = null;
  let ipcPtr = -1;
  let lastIpc: number | null = null;
  let utmPtr = -1;
  let lastUtm: number | null = null;

  const eqPtr = new Map<string, number>();
  const lastEqUsd = new Map<string, number | null>();
  for (const t of equityTickers) {
    eqPtr.set(t, -1);
    lastEqUsd.set(t, null);
  }

  const fuPtr = new Map<string, number>();
  const lastFuClp = new Map<string, number | null>();
  for (const k of fundKeys) {
    fuPtr.set(k, -1);
    lastFuClp.set(k, null);
  }

  const points: {
    as_of_date: string;
    clp_per_usd: number | null;
    clp_per_uf: number | null;
    clp_per_eur: number | null;
    ipc_index: number | null;
    utm_clp: number | null;
    equity_usd: Record<string, number | null>;
    equity_clp: Record<string, number | null>;
    fund_unit_clp: Record<string, number | null>;
    fund_unit_usd: Record<string, number | null>;
  }[] = [];

  for (const d of slice) {
    while (fxPtr + 1 < fxRows.length && fxRows[fxPtr + 1]!.date <= d) {
      fxPtr++;
      lastFx = fxRows[fxPtr]!.clp_per_usd;
    }
    while (ufPtr + 1 < ufRows.length && ufRows[ufPtr + 1]!.date <= d) {
      ufPtr++;
      lastUf = ufRows[ufPtr]!.clp_per_uf;
    }
    while (eurPtr + 1 < eurRows.length && eurRows[eurPtr + 1]!.date <= d) {
      eurPtr++;
      lastEur = eurRows[eurPtr]!.clp_per_eur;
    }
    while (ipcPtr + 1 < ipcRows.length && ipcRows[ipcPtr + 1]!.date <= d) {
      ipcPtr++;
      lastIpc = ipcRows[ipcPtr]!.ipc_index;
    }
    while (utmPtr + 1 < utmRows.length && utmRows[utmPtr + 1]!.date <= d) {
      utmPtr++;
      lastUtm = utmRows[utmPtr]!.utm_clp;
    }

    for (const t of equityTickers) {
      const bars = eqBars.get(t);
      if (!bars?.length) {
        lastEqUsd.set(t, null);
        continue;
      }
      let i = eqPtr.get(t) ?? -1;
      while (i + 1 < bars.length && bars[i + 1]!.date <= d) i++;
      eqPtr.set(t, i);
      lastEqUsd.set(t, i >= 0 ? bars[i]!.v : null);
    }

    for (const k of fundKeys) {
      const bars = fuBars.get(k);
      if (!bars?.length) {
        lastFuClp.set(k, null);
        continue;
      }
      let i = fuPtr.get(k) ?? -1;
      while (i + 1 < bars.length && bars[i + 1]!.date <= d) i++;
      fuPtr.set(k, i);
      lastFuClp.set(k, i >= 0 ? bars[i]!.v : null);
    }

    const fxOnD = fxPtr >= 0 && fxRows[fxPtr]!.date === d ? lastFx : null;
    const ufOnD = ufPtr >= 0 && ufRows[ufPtr]!.date === d ? lastUf : null;
    const eurOnD = eurPtr >= 0 && eurRows[eurPtr]!.date === d ? lastEur : null;
    const ipcOnD = ipcPtr >= 0 && ipcRows[ipcPtr]!.date === d ? lastIpc : null;
    const utmOnD = utmPtr >= 0 && utmRows[utmPtr]!.date === d ? lastUtm : null;

    const equity_usd: Record<string, number | null> = {};
    const equity_clp: Record<string, number | null> = {};
    for (const t of equityTickers) {
      const bars = eqBars.get(t);
      const i = eqPtr.get(t) ?? -1;
      const onD = bars != null && i >= 0 && bars[i]!.date === d;
      const u = onD ? (lastEqUsd.get(t) ?? null) : null;
      equity_usd[t] = u;
      equity_clp[t] =
        u != null && lastFx != null && Number.isFinite(u) && Number.isFinite(lastFx) ? u * lastFx : null;
    }

    const fund_unit_clp: Record<string, number | null> = {};
    const fund_unit_usd: Record<string, number | null> = {};
    for (const k of fundKeys) {
      const bars = fuBars.get(k);
      const i = fuPtr.get(k) ?? -1;
      const onD = bars != null && i >= 0 && bars[i]!.date === d;
      const c = onD ? (lastFuClp.get(k) ?? null) : null;
      fund_unit_clp[k] = c;
      fund_unit_usd[k] =
        c != null && lastFx != null && lastFx > 0 && Number.isFinite(c) ? c / lastFx : null;
    }

    const hasEquity = equityTickers.some((t) => equity_usd[t] != null);
    const hasFund = fundKeys.some((k) => fund_unit_clp[k] != null);
    if (fxOnD == null && ufOnD == null && eurOnD == null && ipcOnD == null && utmOnD == null && !hasEquity && !hasFund) {
      continue;
    }

    points.push({
      as_of_date: d,
      clp_per_usd: fxOnD,
      clp_per_uf: ufOnD,
      clp_per_eur: eurOnD,
      ipc_index: ipcOnD,
      utm_clp: utmOnD,
      equity_usd,
      equity_clp,
      fund_unit_clp,
      fund_unit_usd,
    });
  }

  return {
    points,
    equity_tickers: equityTickers,
    fund_series_keys: fundKeys,
    fx_usd_clp: fxRows.map((r) => ({ date: r.date, value: r.clp_per_usd })),
    eur_clp: eurRows.map((r) => ({ date: r.date, value: r.clp_per_eur })),
    fx_coverage: buildFxCoverage(),
  };
}
