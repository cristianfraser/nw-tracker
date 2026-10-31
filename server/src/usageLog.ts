import type { NextFunction, Request, RequestHandler, Response } from "express";
import { requestCacheOutcome, runWithRequestCacheStats, type RequestCacheStats } from "./requestCacheStats.js";
import { usageDb } from "./usageDb.js";
import { USAGE_PAGE_VIEW_PATH } from "./usagePagePath.js";

/**
 * Usage and performance log (migration 247): every `/api` request's duration, status, size and
 * cache outcome, aggregated per UTC hour × method × route pattern × the query parameters that
 * change the work; and every in-app page view the client reports (`POST /api/usage/page-view`)
 * with how long its queries took to settle.
 *
 * Requests only touch an in-memory buffer; {@link flushUsageLog} writes it once a minute in one
 * transaction (a restart loses at most that minute). One log for both deployments, stored where
 * {@link usageDb} says: the personal primary writes its main DB, the hosted demo its persistent
 * analytics file (with the visitor hash on each page view, demoAnalytics.ts). Secondary dev
 * servers stay out: `BACKGROUND_JOBS_ENABLED=0` defaults `USAGE_LOG_ENABLED` to 0, while demo
 * mode defaults it to 1 first (it cannot collide with the primary's DB).
 */

/** Upper bounds (ms) of the histogram buckets; one more bucket counts everything above. */
export const USAGE_HISTOGRAM_BOUNDS_MS = [
  2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
] as const;
export const USAGE_HISTOGRAM_BUCKETS = USAGE_HISTOGRAM_BOUNDS_MS.length + 1;
/** Endpoint aggregates only; page views are kept for good (the history of what is used). */
export const USAGE_ENDPOINT_RETENTION_DAYS = 90;
const FLUSH_INTERVAL_MS = 60_000;

/**
 * The query parameters kept in an endpoint's key: those that change which payload is built.
 * Everything else (ids, free-text filters, pagination) is left out so a route stays one series;
 * `account_id` in particular would split every account page into its own row.
 */
export const USAGE_KEY_QUERY_PARAMS = [
  "unit",
  "days",
  "period",
  "portfolio_group",
  "group",
  "subgroup",
  "include_usd",
  "include_uf",
  "installment_mode",
  "perf_levels",
  "exclude_spending",
  "granularity",
  "benchmark",
  "personal_only",
] as const;

const MAX_PARAM_VALUE = 40;

export function usageLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.USAGE_LOG_ENABLED?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

/** Canonical `a=1&b=2` of the kept parameters (sorted by name; '' when none is present). */
export function usageParamsKey(query: Request["query"]): string {
  const parts: string[] = [];
  for (const name of [...USAGE_KEY_QUERY_PARAMS].sort()) {
    const raw = query[name];
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(",") : String(raw);
    parts.push(`${name}=${value.slice(0, MAX_PARAM_VALUE)}`);
  }
  return parts.join("&");
}

/** The matched route pattern with its router prefix, or null when no route matched (a 404). */
export function usageRoutePattern(req: Request): string | null {
  const path: unknown = req.route?.path;
  if (typeof path !== "string") return null;
  const joined = `${req.baseUrl}${path === "/" && req.baseUrl ? "" : path}`;
  return joined || "/";
}

export function usageHistogramBucket(ms: number): number {
  const i = USAGE_HISTOGRAM_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return i === -1 ? USAGE_HISTOGRAM_BOUNDS_MS.length : i;
}

/** The UTC hour a request finished in, as stored (`YYYY-MM-DDTHH:00:00.000Z`). */
export function usageHourStart(at: Date): string {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

type EndpointAgg = {
  hour_start: string;
  method: string;
  route: string;
  params: string;
  count: number;
  total_ms: number;
  max_ms: number;
  client_errors: number;
  server_errors: number;
  bytes_total: number;
  bytes_max: number;
  bytes_samples: number;
  cache_warm: number;
  cache_cold: number;
  hist: number[];
};

export type UsageRequestSample = {
  at: Date;
  method: string;
  route: string;
  params: string;
  ms: number;
  status: number;
  bytes: number | null;
  cache: "warm" | "cold" | "none";
};

export type UsagePageViewSample = {
  viewed_at: string;
  route: string;
  path: string;
  /** The demo's daily visitor hash; null on the personal instance. */
  visitor: string | null;
  initial: boolean;
  outcome: "settled" | "left" | "hidden" | "timeout" | "untimed";
  settle_ms: number | null;
  fetched_queries: number;
};

const endpointBuffer = new Map<string, EndpointAgg>();
let pageViewBuffer: UsagePageViewSample[] = [];

export function recordUsageRequest(sample: UsageRequestSample): void {
  const hour = usageHourStart(sample.at);
  const key = `${hour}\u0000${sample.method}\u0000${sample.route}\u0000${sample.params}`;
  let agg = endpointBuffer.get(key);
  if (!agg) {
    agg = {
      hour_start: hour,
      method: sample.method,
      route: sample.route,
      params: sample.params,
      count: 0,
      total_ms: 0,
      max_ms: 0,
      client_errors: 0,
      server_errors: 0,
      bytes_total: 0,
      bytes_max: 0,
      bytes_samples: 0,
      cache_warm: 0,
      cache_cold: 0,
      hist: new Array<number>(USAGE_HISTOGRAM_BUCKETS).fill(0),
    };
    endpointBuffer.set(key, agg);
  }
  agg.count += 1;
  agg.total_ms += sample.ms;
  agg.max_ms = Math.max(agg.max_ms, sample.ms);
  if (sample.status >= 500) agg.server_errors += 1;
  else if (sample.status >= 400) agg.client_errors += 1;
  if (sample.bytes != null) {
    agg.bytes_total += sample.bytes;
    agg.bytes_max = Math.max(agg.bytes_max, sample.bytes);
    agg.bytes_samples += 1;
  }
  if (sample.cache === "warm") agg.cache_warm += 1;
  else if (sample.cache === "cold") agg.cache_cold += 1;
  agg.hist[usageHistogramBucket(sample.ms)]! += 1;
}

export function recordUsagePageView(sample: UsagePageViewSample): void {
  pageViewBuffer.push(sample);
}

const HIST_COLUMNS = Array.from({ length: USAGE_HISTOGRAM_BUCKETS }, (_, i) => `h${String(i).padStart(2, "0")}`);
export const USAGE_HISTOGRAM_COLUMNS: readonly string[] = HIST_COLUMNS;

const UPSERT_ENDPOINT_SQL = `
  INSERT INTO usage_endpoint_hourly (
    hour_start, method, route, params, count, total_ms, max_ms, client_errors, server_errors,
    bytes_total, bytes_max, bytes_samples, cache_warm, cache_cold, ${HIST_COLUMNS.join(", ")}
  ) VALUES (
    @hour_start, @method, @route, @params, @count, @total_ms, @max_ms, @client_errors, @server_errors,
    @bytes_total, @bytes_max, @bytes_samples, @cache_warm, @cache_cold, ${HIST_COLUMNS.map((c) => `@${c}`).join(", ")}
  )
  ON CONFLICT (hour_start, method, route, params) DO UPDATE SET
    count = count + excluded.count,
    total_ms = total_ms + excluded.total_ms,
    max_ms = MAX(max_ms, excluded.max_ms),
    client_errors = client_errors + excluded.client_errors,
    server_errors = server_errors + excluded.server_errors,
    bytes_total = bytes_total + excluded.bytes_total,
    bytes_max = MAX(bytes_max, excluded.bytes_max),
    bytes_samples = bytes_samples + excluded.bytes_samples,
    cache_warm = cache_warm + excluded.cache_warm,
    cache_cold = cache_cold + excluded.cache_cold,
    ${HIST_COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(",\n    ")}`;

let lastPrunedDay: string | null = null;

/**
 * Writes the buffered aggregates and page views in one transaction, then (once per UTC day)
 * drops endpoint aggregates older than the retention. The buffer is swapped out before writing, so a
 * request finishing meanwhile lands in the next flush.
 */
export function flushUsageLog(now: Date = new Date()): { endpoints: number; page_views: number } {
  const endpoints = [...endpointBuffer.values()];
  const pageViews = pageViewBuffer;
  endpointBuffer.clear();
  pageViewBuffer = [];
  const db = usageDb();
  const upsert = db.prepare(UPSERT_ENDPOINT_SQL);
  const insertView = db.prepare(
    `INSERT INTO usage_page_views (viewed_at, route, path, visitor, initial, outcome, settle_ms, fetched_queries)
     VALUES (@viewed_at, @route, @path, @visitor, @initial, @outcome, @settle_ms, @fetched_queries)`
  );
  const today = now.toISOString().slice(0, 10);
  db.transaction(() => {
    for (const agg of endpoints) {
      const { hist, ...rest } = agg;
      const histParams = Object.fromEntries(HIST_COLUMNS.map((c, i) => [c, hist[i]!]));
      upsert.run({ ...rest, ...histParams });
    }
    for (const view of pageViews) insertView.run({ ...view, initial: view.initial ? 1 : 0 });
    if (lastPrunedDay !== today) {
      const cutoff = new Date(now.getTime() - USAGE_ENDPOINT_RETENTION_DAYS * 86_400_000).toISOString();
      db.prepare(`DELETE FROM usage_endpoint_hourly WHERE hour_start < ?`).run(cutoff);
    }
  })();
  lastPrunedDay = today;
  return { endpoints: endpoints.length, page_views: pageViews.length };
}

/** Drops what is buffered without writing it (tests). */
export function resetUsageLogBufferForTest(): void {
  endpointBuffer.clear();
  pageViewBuffer = [];
  lastPrunedDay = null;
}

/** The beacon is the client's own record, not a request worth timing. */
const USAGE_SKIPPED_PATHS = new Set([USAGE_PAGE_VIEW_PATH]);

/**
 * Times every `/api` request (except the page-view beacon) from arrival to the last byte sent.
 * A request no route matched is recorded under `(unmatched)` so a stray 404 storm still shows.
 */
export function usageLogMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/") || USAGE_SKIPPED_PATHS.has(req.path)) {
      next();
      return;
    }
    const t0 = performance.now();
    const stats: RequestCacheStats = { hits: 0, misses: 0 };
    res.on("finish", () => {
      // The payload size before compression (`jsonResponse.ts` notes it; any other response is
      // sent uncompressed, so its Content-Length is that size): what the report's «mean size»
      // compares, whatever encoding the client accepted.
      const bodyBytes: unknown = res.locals.usageBodyBytes;
      const lengthHeader = res.getHeader("content-length");
      const bytes =
        typeof bodyBytes === "number" ? bodyBytes : lengthHeader === undefined ? null : Number(lengthHeader);
      recordUsageRequest({
        at: new Date(),
        method: req.method,
        route: usageRoutePattern(req) ?? "(unmatched)",
        params: usageParamsKey(req.query),
        ms: performance.now() - t0,
        status: res.statusCode,
        bytes: bytes != null && Number.isFinite(bytes) ? bytes : null,
        cache: requestCacheOutcome(stats),
      });
    });
    runWithRequestCacheStats(stats, next);
  };
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startUsageLogFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    try {
      flushUsageLog();
    } catch (err) {
      // Telemetry must never take the server down; the next minute retries with new data.
      console.error("[usage-log] flush failed:", err);
    }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}
