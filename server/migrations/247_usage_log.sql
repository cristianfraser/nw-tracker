-- Usage and performance log (usageLog.ts): how long each API endpoint takes and which pages are
-- opened, so optimization follows real use rather than one-off profiles. Written once a minute
-- from an in-memory buffer. The hosted demo applies this same file to its own analytics DB
-- (`DEMO_ANALYTICS_DB`, usageDb.ts), hence IF NOT EXISTS.
--
-- usage_endpoint_hourly: one row per UTC hour × method × route pattern × the query parameters
-- that change the work (`params`, canonical `a=1&b=2`, '' when none). Durations in ms; the
-- histogram h00..h14 counts requests per bucket of USAGE_HISTOGRAM_BOUNDS_MS (h14 = above the
-- last bound), from which the report estimates percentiles. bytes_* cover only responses that
-- declared a Content-Length (bytes_samples of them). cache_warm / cache_cold: requests whose
-- aggregation-cache lookups were all hits / included a miss (neither when none were made).
CREATE TABLE IF NOT EXISTS usage_endpoint_hourly (
  hour_start TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  params TEXT NOT NULL,
  count INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  max_ms REAL NOT NULL,
  client_errors INTEGER NOT NULL,
  server_errors INTEGER NOT NULL,
  bytes_total INTEGER NOT NULL,
  bytes_max INTEGER NOT NULL,
  bytes_samples INTEGER NOT NULL,
  cache_warm INTEGER NOT NULL,
  cache_cold INTEGER NOT NULL,
  h00 INTEGER NOT NULL, h01 INTEGER NOT NULL, h02 INTEGER NOT NULL, h03 INTEGER NOT NULL,
  h04 INTEGER NOT NULL, h05 INTEGER NOT NULL, h06 INTEGER NOT NULL, h07 INTEGER NOT NULL,
  h08 INTEGER NOT NULL, h09 INTEGER NOT NULL, h10 INTEGER NOT NULL, h11 INTEGER NOT NULL,
  h12 INTEGER NOT NULL, h13 INTEGER NOT NULL, h14 INTEGER NOT NULL,
  PRIMARY KEY (hour_start, method, route, params)
);

-- usage_page_views: one row per in-app route change the client reported. route = the path with
-- numeric segments as `:id`; settle_ms = from the navigation (page start for the first page) to
-- the moment its queries stopped fetching, null unless outcome = 'settled' ('left' before
-- settling, 'hidden' when the tab went to the background, 'timeout' after 60 s; 'untimed' for
-- the demo's pageviews from before timings existed). visitor: the demo's daily visitor hash
-- (demoAnalytics.ts), null on the personal instance. Kept for good: the history of what is used.
CREATE TABLE IF NOT EXISTS usage_page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  viewed_at TEXT NOT NULL,
  route TEXT NOT NULL,
  path TEXT NOT NULL,
  visitor TEXT,
  initial INTEGER NOT NULL CHECK (initial IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('settled', 'left', 'hidden', 'timeout', 'untimed')),
  settle_ms REAL,
  fetched_queries INTEGER NOT NULL,
  CHECK ((outcome = 'settled') = (settle_ms IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS usage_page_views_viewed_at ON usage_page_views (viewed_at);
