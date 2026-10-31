import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Prints the hosted demo's anonymous visit analytics and its usage log (page views with load
 * times, slowest endpoints) — admin tooling, meant for the Render shell (`npm run demo:visits`
 * from the repo root). The demo refuses `/api/usage/report` (it is public), so this is where its
 * usage is read. Read-only: never creates or migrates anything, and does not boot the app (no
 * db.ts import). A file the merged server has not opened yet still has the old
 * `demo_pageviews` counts instead of `usage_page_views`; both are read.
 *
 * Reads `DEMO_ANALYTICS_DB` (the persistent-disk SQLite file on the hosted demo, see
 * server/src/demoAnalytics.ts); unset → the local rehearsal file under server/data/.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DEMO_ANALYTICS_DB?.trim() || resolve(here, "../data/demo-analytics.db");

if (!existsSync(dbPath)) {
  console.error(`No analytics database at ${dbPath} — no visits have been recorded yet.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
  );
}

if (!tableExists("demo_visits")) {
  console.error(`${dbPath} has no demo_visits table — no visits have been recorded yet.`);
  process.exit(1);
}

console.log(`demo analytics — ${dbPath}\n`);

console.log("Visitors per day");
console.table(
  db
    .prepare(
      `SELECT day, COUNT(*) AS visitors, SUM(request_count) AS requests
       FROM demo_visits GROUP BY day ORDER BY day DESC LIMIT 60`
    )
    .all()
);

console.log("\nArrivals by src tag");
console.table(
  db
    .prepare(
      `SELECT COALESCE(src, '(none)') AS src, COUNT(*) AS visits
       FROM demo_visits GROUP BY 1 ORDER BY visits DESC`
    )
    .all()
);

console.log("\nArrivals by referrer origin");
console.table(
  db
    .prepare(
      `SELECT COALESCE(referrer, '(direct)') AS referrer, COUNT(*) AS visits
       FROM demo_visits GROUP BY 1 ORDER BY visits DESC LIMIT 20`
    )
    .all()
);

if (tableExists("usage_page_views")) {
  console.log("\nMost-visited pages (load = until the page's queries settled; untimed = from before timings)");
  console.table(
    db
      .prepare(
        `SELECT route, COUNT(*) AS views,
                COUNT(DISTINCT substr(viewed_at, 1, 10) || visitor) AS visitors,
                SUM(outcome = 'settled') AS timed,
                CAST(ROUND(AVG(settle_ms)) AS INTEGER) AS avg_load_ms,
                CAST(ROUND(MAX(settle_ms)) AS INTEGER) AS max_load_ms
         FROM usage_page_views GROUP BY route ORDER BY views DESC LIMIT 25`
      )
      .all()
  );

  console.log("\nDepth: pages seen per visitor");
  console.table(
    db
      .prepare(
        `SELECT pages, COUNT(*) AS visitors FROM (
           SELECT substr(viewed_at, 1, 10) AS day, visitor, COUNT(DISTINCT path) AS pages
           FROM usage_page_views WHERE visitor IS NOT NULL GROUP BY day, visitor
         ) GROUP BY pages ORDER BY pages`
      )
      .all()
  );
} else if (tableExists("demo_pageviews")) {
  console.log("\nMost-visited pages (legacy counts)");
  console.table(
    db
      .prepare(
        `SELECT path, SUM(views) AS views, COUNT(DISTINCT day || visitor) AS visitors
         FROM demo_pageviews GROUP BY path ORDER BY views DESC LIMIT 25`
      )
      .all()
  );
}

if (tableExists("usage_endpoint_hourly")) {
  console.log("\nSlowest endpoints, last 30 days (by mean)");
  console.table(
    db
      .prepare(
        `SELECT method || ' ' || route || CASE WHEN params = '' THEN '' ELSE '?' || params END AS endpoint,
                SUM(count) AS requests,
                CAST(ROUND(SUM(total_ms) / SUM(count)) AS INTEGER) AS avg_ms,
                CAST(ROUND(MAX(max_ms)) AS INTEGER) AS max_ms,
                SUM(server_errors) AS errors_5xx
         FROM usage_endpoint_hourly
         WHERE hour_start >= strftime('%Y-%m-%dT%H:00:00.000Z', 'now', '-30 days')
         GROUP BY method, route, params ORDER BY avg_ms DESC LIMIT 25`
      )
      .all()
  );
}

console.log("\nRecent visits");
console.table(
  db
    .prepare(
      `SELECT day, visitor, src, referrer, country, request_count, first_seen_at, last_seen_at
       FROM demo_visits ORDER BY day DESC, last_seen_at DESC LIMIT 40`
    )
    .all()
);
