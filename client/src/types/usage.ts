/** Usage log reports (server: `usageReport.ts`, `GET /api/usage/report`, `/api/usage/endpoint-trend`). */
export type UsageReportWindow = 1 | 7 | 30 | 90;

export type UsagePageRow = {
  route: string;
  views: number;
  settled_views: number;
  unsettled_views: number;
  settle_p50_ms: number | null;
  settle_p95_ms: number | null;
  settle_max_ms: number | null;
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
  total_ms: number;
  client_errors: number;
  server_errors: number;
  cache_warm_share: number | null;
  cache_cold_share: number | null;
  avg_bytes: number | null;
};

export type UsageReport = {
  enabled: boolean;
  window_days: UsageReportWindow;
  windows: UsageReportWindow[];
  from: string;
  to: string;
  totals: { page_views: number; requests: number; request_ms: number };
  pages: UsagePageRow[];
  endpoints: UsageEndpointRow[];
};

export type UsageEndpointTrendPoint = {
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
  points: UsageEndpointTrendPoint[];
};

export type UsageEndpointSeries = { method: string; route: string; params: string };
