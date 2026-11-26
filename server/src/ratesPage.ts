import { db } from "./db.js";
import { chileWallClockAt } from "./chileDate.js";
import type { FxCoverage } from "./fxCoverage.js";
import { listRatesInstrumentSeries } from "./marketDisplaySeries.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeriesTypes.js";
import type { DisplayUnitCode } from "./rates.js";
import { watchlistStatsForRow, type WatchlistChanges } from "./watchlistStats.js";

/** How many stored entries the rates page lists under each chart. */
export const RATES_RECENT_ENTRIES = 5;

/** One stored entry of a rates series, newest first, with its change against the entry before it. */
export type RatesRecentEntry = {
  date: string;
  value: number;
  /** % against the previous stored entry; null for the series' first entry. */
  change_pct: number | null;
  /** USD/CLP only: Banco Central's observado and the buy / sell rate stored on the same date. */
  observado?: number | null;
  buy?: number | null;
  sell?: number | null;
};

/**
 * The latest entries of a series (rows in ascending date order): the newest `limit`, newest
 * first, each with its change against the stored entry before it.
 */
export function ratesRecentEntries(
  rows: readonly { date: string; value: number }[],
  limit = RATES_RECENT_ENTRIES
): RatesRecentEntry[] {
  const finite = rows.filter((r) => Number.isFinite(r.value));
  const out: RatesRecentEntry[] = [];
  for (let i = finite.length - 1; i >= 0 && out.length < limit; i--) {
    const cur = finite[i]!;
    const prev = i > 0 ? finite[i - 1]! : null;
    out.push({
      date: cur.date,
      value: cur.value,
      change_pct: prev != null && prev.value !== 0 ? ((cur.value - prev.value) / prev.value) * 100 : null,
    });
  }
  return out;
}

/** One problem of the stored rate history, as data: the client words it. */
export type RatesCoverageNotice =
  | {
      kind: "missing_rates";
      base: string;
      quote: string;
      /** The display unit whose conversions lack the rate. */
      unit: string;
      first_missing_date: string;
      missing_count: number;
    }
  | { kind: "sparse_history"; base: string; quote: string; daily_count: number; row_count: number; max_gap_days: number }
  | {
      kind: "rejected_dates";
      base: string;
      quote: string;
      count: number;
      /** The first few rejected observations (the rate received is in `quote` per `base`). */
      dates: { date: string; raw_rate: number }[];
    }
  | {
      kind: "buy_rate_missing" | "sell_rate_missing" | "reference_rate";
      base: string;
      quote: string;
      /** The latest date the conversion fell back on the mid rate. */
      date: string;
    };

const REJECTED_DATES_SHOWN = 5;

/** The coverage problems the rates page lists, one per pair and kind, in the order drawn. */
export function buildRatesCoverageNotices(coverage: FxCoverage): RatesCoverageNotice[] {
  const out: RatesCoverageNotice[] = [];
  for (const p of coverage.pairs) {
    if (!p.complete && p.first_missing_date != null) {
      out.push({
        kind: "missing_rates",
        base: p.base,
        quote: p.quote,
        unit: coverage.unit,
        first_missing_date: p.first_missing_date,
        missing_count: p.missing_count,
      });
    }
    if (p.is_sparse) {
      out.push({
        kind: "sparse_history",
        base: p.base,
        quote: p.quote,
        daily_count: p.daily_count,
        row_count: p.row_count,
        max_gap_days: p.max_gap_days,
      });
    }
  }
  if (coverage.yahoo_rejected.length > 0) {
    out.push({
      kind: "rejected_dates",
      base: "usd",
      quote: "clp",
      count: coverage.yahoo_rejected.length,
      dates: coverage.yahoo_rejected
        .slice(0, REJECTED_DATES_SHOWN)
        .map((r) => ({ date: r.date, raw_rate: r.raw_clp_per_usd })),
    });
  }
  // The conversion warnings are USD/CLP buy / sell fallbacks: one notice per code, at its latest date.
  const latestByCode = new Map<string, string>();
  for (const w of coverage.conversion_warnings ?? []) {
    const seen = latestByCode.get(w.code);
    if (seen == null || w.date > seen) latestByCode.set(w.code, w.date);
  }
  for (const code of ["buy_rate_missing", "sell_rate_missing", "reference_rate"] as const) {
    const date = latestByCode.get(code);
    if (date != null) out.push({ kind: code, base: "usd", quote: "clp", date });
  }
  return out;
}

/** The series ids the rates payloads share: a glance row, its chart and its latest entries. */
export const RATES_SERIES = {
  usdClp: "usd_clp",
  ufClp: "uf_clp",
  eurClp: "eur_clp",
  eurUsd: "eur_usd",
  ipc: "ipc",
} as const;

export function ratesInstrumentSeriesId(kind: "equity" | "fund_unit", seriesKey: string): string {
  return `${kind}:${seriesKey}`;
}

/** One row of the rates page's glance: today's value and its change over the watchlist's windows. */
export type RatesGlanceRow = {
  /** The series id, shared with `recent` of `GET /api/market-series`. */
  id: string;
  /** `index` is the IPC (a monthly level, no currency); the others are the watchlist's kinds. */
  kind: "fx_usd" | "fx_pair" | "uf" | "index" | "equity" | "fund_unit";
  /** A pair's codes (`usd` / `clp`); null for an index and an instrument. */
  base: string | null;
  quote: string | null;
  /** An instrument's chart title; null where the client names the row (a pair by its codes, the IPC). */
  label: string | null;
  /** An instrument's key in the series payload's `equity` / `fund_unit` maps. */
  series_key: string | null;
  value: number | null;
  /** The currency `value` is in: a pair's quote, the display unit for an instrument, `none` for an index. */
  value_currency: string;
  as_of_date: string | null;
  changes: WatchlistChanges | null;
};

function builtinRow(kind: MarketDisplaySeriesRow["kind"], seriesKey: string | null): MarketDisplaySeriesRow {
  return {
    id: 0,
    slug: seriesKey ?? kind,
    label: seriesKey ?? kind,
    label_i18n_key: null,
    sort_order: 0,
    kind,
    series_key: seriesKey,
    show_in_marquee: 0,
    show_in_rates: 1,
    rates_chart_title: null,
    source: "builtin",
  };
}

function firstOfMonthMonthsBefore(ymd: string, months: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * The IPC's glance row: the latest monthly index on or before today and its change against the
 * index of the month one, twelve, 36, 60 and 120 months before. Its year-to-date is the
 * «acumulado del año» of that latest month: against the December before it, so in January, with
 * the latest index still last year's, it reads last year's accumulated inflation. A monthly
 * series has no day, week or month-to-date change.
 */
function ipcGlanceRow(today: string): RatesGlanceRow {
  const rows = db
    .prepare(`SELECT date, ipc_index FROM ipc_daily WHERE date <= ? ORDER BY date ASC`)
    .all(today) as { date: string; ipc_index: number }[];
  const base: RatesGlanceRow = {
    id: RATES_SERIES.ipc,
    kind: "index",
    base: null,
    quote: null,
    label: null,
    series_key: null,
    value: null,
    value_currency: "none",
    as_of_date: null,
    changes: null,
  };
  const latest = rows[rows.length - 1];
  if (latest == null) return base;
  if (!Number.isFinite(latest.ipc_index)) throw new Error(`rates glance: ipc_daily ${latest.date} holds no index`);
  const byMonth = new Map(rows.map((r) => [r.date.slice(0, 7), r.ipc_index]));
  const pctVsMonth = (firstOfMonth: string): number | null => {
    const prior = byMonth.get(firstOfMonth.slice(0, 7));
    return prior != null && Number.isFinite(prior) && prior !== 0 ? ((latest.ipc_index - prior) / prior) * 100 : null;
  };
  const back = (months: number) => pctVsMonth(firstOfMonthMonthsBefore(latest.date, months));
  return {
    ...base,
    value: latest.ipc_index,
    as_of_date: latest.date,
    changes: {
      day_pct: null,
      week_pct: null,
      mtd_pct: null,
      mom_pct: back(1),
      ytd_pct: pctVsMonth(`${Number(latest.date.slice(0, 4)) - 1}-12-01`),
      yoy_pct: back(12),
      y3_pct: back(36),
      y5_pct: back(60),
      y10_pct: back(120),
    },
  };
}

export type RatesGlancePayload = {
  unit: DisplayUnitCode;
  currencies: RatesGlanceRow[];
  instruments: RatesGlanceRow[];
};

/**
 * `GET /api/rates/glance?unit=`: the rates page's two glances, from the watchlist's own row
 * statistics so the two pages agree. The rate rows are facts in their own quote in every unit
 * (the UF in pesos, EUR/USD in dollars); an instrument's value and changes are in `unit`. Reads
 * the live rates, so it refetches on a tick — the stored history of `GET /api/market-series`
 * does not.
 */
export function getRatesGlancePayload(now = new Date(), unit: DisplayUnitCode = "clp"): RatesGlancePayload {
  const today = chileWallClockAt(now).ymd;
  const pairRow = (
    id: string,
    kind: "fx_usd" | "fx_pair" | "uf",
    base: string,
    quote: string
  ): RatesGlanceRow => {
    // The UF row is the UF's peso value whatever the display unit: it is the rate here.
    const stats = watchlistStatsForRow(builtinRow(kind, kind === "fx_pair" ? `${base}_${quote}` : null), now, quote);
    return {
      id,
      kind,
      base,
      quote,
      label: null,
      series_key: null,
      value: stats.value,
      value_currency: quote,
      as_of_date: stats.as_of_date,
      changes: stats.changes,
    };
  };
  const currencies: RatesGlanceRow[] = [
    pairRow(RATES_SERIES.usdClp, "fx_usd", "usd", "clp"),
    pairRow(RATES_SERIES.ufClp, "uf", "uf", "clp"),
    pairRow(RATES_SERIES.eurClp, "fx_pair", "eur", "clp"),
    pairRow(RATES_SERIES.eurUsd, "fx_pair", "eur", "usd"),
    ipcGlanceRow(today),
  ];
  const instruments: RatesGlanceRow[] = [];
  for (const row of listRatesInstrumentSeries()) {
    if (row.kind !== "equity" && row.kind !== "fund_unit") {
      throw new Error(`rates glance: series ${row.slug} of kind ${row.kind} has no chart on the rates page`);
    }
    const seriesKey = row.series_key ?? row.slug;
    const stats = watchlistStatsForRow(row, now, unit);
    instruments.push({
      id: ratesInstrumentSeriesId(row.kind, seriesKey),
      kind: row.kind,
      base: null,
      quote: null,
      label: row.rates_chart_title ?? row.label,
      series_key: seriesKey,
      value: stats.value,
      value_currency: stats.value_currency,
      as_of_date: stats.as_of_date,
      changes: stats.changes,
    });
  }
  return { unit, currencies, instruments };
}
