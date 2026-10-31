import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { db } from "./db.js";
import { demoAnalyticsDb } from "./demoAnalytics.js";
import { demoModeEnabled } from "./demoMode.js";
import { usagePageRoute } from "./usagePagePath.js";

/**
 * Where the usage log lives. The personal instance: the main DB (migration 247). The hosted
 * demo: its persistent analytics file (`DEMO_ANALYTICS_DB`), because the demo's own DB is
 * regenerated on every deploy — the same migration file is applied there at first use (its
 * statements are IF NOT EXISTS), and the pageviews the demo recorded before the usage log
 * existed (`demo_pageviews`, a per-day count) are copied in once as untimed views.
 */

const USAGE_SCHEMA_FILES = ["247_usage_log.sql"] as const;
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let demoReady = false;

export function usageDb(): BetterSqliteDb {
  if (!demoModeEnabled()) return db;
  const analytics = demoAnalyticsDb();
  if (!demoReady) {
    prepareDemoUsageDb(analytics);
    demoReady = true;
  }
  return analytics;
}

/** Applies the usage schema to the demo's analytics file and folds in its legacy pageviews. */
export function prepareDemoUsageDb(analytics: BetterSqliteDb): void {
  analytics.transaction(() => {
    for (const file of USAGE_SCHEMA_FILES) {
      analytics.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    }
    copyLegacyDemoPageviews(analytics);
  })();
}

function copyLegacyDemoPageviews(analytics: BetterSqliteDb): void {
  const legacy = analytics
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_pageviews'`)
    .get();
  if (!legacy) return;
  const rows = analytics
    .prepare(
      `SELECT visitor, path, views, strftime('%Y-%m-%dT%H:%M:%fZ', first_seen_at) AS viewed_at
       FROM demo_pageviews ORDER BY first_seen_at`
    )
    .all() as { visitor: string; path: string; views: number; viewed_at: string }[];
  const insert = analytics.prepare(
    `INSERT INTO usage_page_views (viewed_at, route, path, visitor, initial, outcome, settle_ms, fetched_queries)
     VALUES (?, ?, ?, ?, 0, 'untimed', NULL, 0)`
  );
  // The old table kept a count per (day, visitor, path) and its first time: one view per count.
  for (const row of rows) {
    for (let i = 0; i < row.views; i++) insert.run(row.viewed_at, usagePageRoute(row.path), row.path, row.visitor);
  }
  analytics.exec(`DROP TABLE demo_pageviews`);
}

/** Forget that the demo file was prepared (tests that swap the file). */
export function resetUsageDbForTest(): void {
  demoReady = false;
}
