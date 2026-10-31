import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import {
  USAGE_HISTOGRAM_BOUNDS_MS,
  USAGE_HISTOGRAM_BUCKETS,
  USAGE_HISTOGRAM_COLUMNS,
  usageLogEnabled,
} from "./usageLog.js";

/**
 * Display shapes of the usage log (`/panel/usage`): most visited pages, slowest endpoints and
 * one endpoint's daily trend over a window. All aggregation is here; the page renders rows.
 * Endpoint percentiles are estimated from the stored histogram (linear inside a bucket, capped
 * at the observed max); page-settle percentiles are exact over the stored rows.
 */

export const USAGE_REPORT_WINDOWS = [1, 7, 30, 90] as const;
export type UsageReportWindow = (typeof USAGE_REPORT_WINDOWS)[number];

export function parseUsageReportWindow(raw: unknown): UsageReportWindow {
  const n = Number(raw ?? 7);
  const found = USAGE_REPORT_WINDOWS.find((w) => w === n);
  if (found === undefined) {
    throw new Error(`days must be one of ${USAGE_REPORT_WINDOWS.join(", ")}`);
  }
  return found;
}

/** Percentile from bucket counts: linear within the bucket holding the rank, never above max. */
export function histogramPercentile(hist: readonly number[], q: number, maxMs: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = q * total;
  let cumulative = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i]!;
    if (n === 0) continue;
    if (cumulative + n >= rank) {
      const lower = i === 0 ? 0 : USAGE_HISTOGRAM_BOUNDS_MS[i - 1]!;
      const upper = i < USAGE_HISTOGRAM_BOUNDS_MS.length ? USAGE_HISTOGRAM_BOUNDS_MS[i]! : maxMs;
      const within = (rank - cumulative) / n;
      return Math.min(maxMs, lower + (Math.max(upper, lower) - lower) * within);
    }
    cumulative += n;
  }
  return maxMs;
}

/** Exact percentile (nearest rank) over sorted values. */
function sortedPercentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

export type UsagePageRow = {
  route: string;
  views: number;
  settled_views: number;
  /** Views left, hidden or timed out before their queries settled. */
  unsettled_views: number;
  settle_p50_ms: number | null;
  settle_p95_ms: number | null;
  settle_max_ms: number | null;
  /** Mean number of queries a view fetched (0 = everything came from the client cache). */
  avg_fetched_queries: number;
  last_viewed_at: string;
};

export type UsageEndpointRow = {
  key: string;
  method: string;
  route: string;
  params: string;
  count: number;
  avg_ms: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number;
  /** count × mean: where the server's time actually goes. */
  total_ms: number;
  client_errors: number;
  server_errors: number;
  /** Share of requests whose cache lookups all hit / included a miss (null: made none). */
  cache_warm_share: number | null;
  cache_cold_share: number | null;
  avg_bytes: number | null;
};

export type UsageReport = {
  enabled: boolean;
  window_days: UsageReportWindow;
  windows: readonly UsageReportWindow[];
  from: string;
  to: string;
  totals: { page_views: number; requests: number; request_ms: number };
  pages: UsagePageRow[];
  endpoints: UsageEndpointRow[];
};

type EndpointSumRow = {
  method: string;
  route: string;
  params: string;
  count: number;
  total_ms: number;
  max_ms: number;
  client_errors: number;
  server_errors: number;
  bytes_total: number;
  bytes_samples: number;
  cache_warm: number;
  cache_cold: number;
} & Record<string, number | string>;

const HIST_SUMS_SQL = USAGE_HISTOGRAM_COLUMNS.map((c) => `SUM(${c}) AS ${c}`).join(", ");

function histFromRow(row: Record<string, unknown>): number[] {
  return USAGE_HISTOGRAM_COLUMNS.map((c) => Number(row[c] ?? 0));
}

/** One key per series, as the trend endpoint takes it back. */
export function usageEndpointKey(method: string, route: string, params: string): string {
  return `${method} ${route}${params ? `?${params}` : ""}`;
}

function windowStart(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function buildUsageReport(days: UsageReportWindow, now: Date = new Date()): UsageReport {
  const from = windowStart(now, days);
  const to = now.toISOString();

  const viewRows = db
    .prepare(
      `SELECT route, viewed_at, outcome, settle_ms, fetched_queries
       FROM usage_page_views WHERE viewed_at >= ? ORDER BY viewed_at`
    )
    .all(from) as {
    route: string;
    viewed_at: string;
    outcome: string;
    settle_ms: number | null;
    fetched_queries: number;
  }[];
  const byRoute = new Map<string, typeof viewRows>();
  for (const row of viewRows) {
    const list = byRoute.get(row.route) ?? [];
    list.push(row);
    byRoute.set(row.route, list);
  }
  const pages: UsagePageRow[] = [...byRoute.entries()].map(([route, rows]) => {
    const settled = rows
      .map((r) => r.settle_ms)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    return {
      route,
      views: rows.length,
      settled_views: settled.length,
      unsettled_views: rows.length - settled.length,
      settle_p50_ms: sortedPercentile(settled, 0.5),
      settle_p95_ms: sortedPercentile(settled, 0.95),
      settle_max_ms: settled.length ? settled[settled.length - 1]! : null,
      avg_fetched_queries: rows.reduce((a, r) => a + r.fetched_queries, 0) / rows.length,
      last_viewed_at: rows[rows.length - 1]!.viewed_at,
    };
  });
  pages.sort((a, b) => b.views - a.views || a.route.localeCompare(b.route));

  const sums = db
    .prepare(
      `SELECT method, route, params, SUM(count) AS count, SUM(total_ms) AS total_ms, MAX(max_ms) AS max_ms,
              SUM(client_errors) AS client_errors, SUM(server_errors) AS server_errors,
              SUM(bytes_total) AS bytes_total, SUM(bytes_samples) AS bytes_samples,
              SUM(cache_warm) AS cache_warm, SUM(cache_cold) AS cache_cold, ${HIST_SUMS_SQL}
       FROM usage_endpoint_hourly WHERE hour_start >= ?
       GROUP BY method, route, params`
    )
    .all(usageHourFloor(from)) as EndpointSumRow[];
  const endpoints: UsageEndpointRow[] = sums.map((row) => {
    const hist = histFromRow(row);
    const lookups = row.cache_warm + row.cache_cold;
    return {
      key: usageEndpointKey(row.method, row.route, row.params),
      method: row.method,
      route: row.route,
      params: row.params,
      count: row.count,
      avg_ms: row.total_ms / row.count,
      p50_ms: histogramPercentile(hist, 0.5, row.max_ms),
      p95_ms: histogramPercentile(hist, 0.95, row.max_ms),
      max_ms: row.max_ms,
      total_ms: row.total_ms,
      client_errors: row.client_errors,
      server_errors: row.server_errors,
      cache_warm_share: lookups > 0 ? row.cache_warm / row.count : null,
      cache_cold_share: lookups > 0 ? row.cache_cold / row.count : null,
      avg_bytes: row.bytes_samples > 0 ? row.bytes_total / row.bytes_samples : null,
    };
  });
  endpoints.sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0) || b.count - a.count);

  return {
    enabled: usageLogEnabled(),
    window_days: days,
    windows: USAGE_REPORT_WINDOWS,
    from,
    to,
    totals: {
      page_views: viewRows.length,
      requests: endpoints.reduce((a, e) => a + e.count, 0),
      request_ms: endpoints.reduce((a, e) => a + e.total_ms, 0),
    },
    pages,
    endpoints,
  };
}

/** Hours are stored by their start: a window from 10:40 includes the 10:00 hour. */
function usageHourFloor(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export type UsageEndpointTrendPoint = {
  /** Chile calendar day. */
  day: string;
  count: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
};

export type UsageEndpointTrend = {
  key: string;
  method: string;
  route: string;
  params: string;
  window_days: UsageReportWindow;
  /** Every Chile day of the window, oldest first; a day without requests has count 0. */
  points: UsageEndpointTrendPoint[];
};

export function buildUsageEndpointTrend(
  series: { method: string; route: string; params: string },
  days: UsageReportWindow,
  now: Date = new Date()
): UsageEndpointTrend {
  const rows = db
    .prepare(
      `SELECT hour_start, count, total_ms, max_ms, ${USAGE_HISTOGRAM_COLUMNS.join(", ")}
       FROM usage_endpoint_hourly
       WHERE method = ? AND route = ? AND params = ? AND hour_start >= ?`
    )
    .all(series.method, series.route, series.params, usageHourFloor(windowStart(now, days))) as ({
    hour_start: string;
    count: number;
    total_ms: number;
    max_ms: number;
  } & Record<string, unknown>)[];
  type Day = { count: number; total_ms: number; max_ms: number; hist: number[] };
  const byDay = new Map<string, Day>();
  for (const row of rows) {
    const day = chileWallClockAt(new Date(row.hour_start)).ymd;
    const acc = byDay.get(day) ?? {
      count: 0,
      total_ms: 0,
      max_ms: 0,
      hist: new Array<number>(USAGE_HISTOGRAM_BUCKETS).fill(0),
    };
    acc.count += row.count;
    acc.total_ms += row.total_ms;
    acc.max_ms = Math.max(acc.max_ms, row.max_ms);
    histFromRow(row).forEach((n, i) => (acc.hist[i]! += n));
    byDay.set(day, acc);
  }
  const today = chileWallClockAt(now).ymd;
  const points: UsageEndpointTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = chileCalendarAddDays(today, -i);
    const acc = byDay.get(day);
    points.push(
      acc
        ? {
            day,
            count: acc.count,
            avg_ms: acc.total_ms / acc.count,
            p50_ms: histogramPercentile(acc.hist, 0.5, acc.max_ms),
            p95_ms: histogramPercentile(acc.hist, 0.95, acc.max_ms),
            max_ms: acc.max_ms,
          }
        : { day, count: 0, avg_ms: null, p50_ms: null, p95_ms: null, max_ms: null }
    );
  }
  return {
    key: usageEndpointKey(series.method, series.route, series.params),
    ...series,
    window_days: days,
    points,
  };
}
