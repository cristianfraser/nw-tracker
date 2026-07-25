import Database from "better-sqlite3";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, RequestHandler } from "express";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { DEMO_PAGEVIEW_PATH } from "./httpSecurity.js";

/**
 * Anonymous analytics for the open (login-free) hosted demo.
 *
 * The old model asked recruiters for an email behind a shared-password gate; they bounced
 * off the gate instead of using it. What is actually worth knowing is whether people arrive,
 * where from, and whether they explore — so this records visits and in-app pageviews with no
 * login, no cookie, and no stored IP:
 *
 * - A visitor id is `hmac(daily key, ip|user-agent)`. The daily key is itself derived from a
 *   long-lived salt plus the calendar day, so ids cannot be correlated across days and the
 *   raw IP is never written anywhere.
 * - Referrers are truncated to their origin — a recruiter's inbox/ATS URL never lands in the DB.
 * - Obvious bots (including Render's own health checks) are skipped so counts mean people.
 *
 * Storage is a dedicated SQLite file (`DEMO_ANALYTICS_DB`), because the demo's synthetic DB is
 * regenerated on every deploy / cold start; on Render that path is on the persistent disk.
 */

/** Column widths — analytics strings are bounded so a hostile header can't bloat the table. */
const MAX_PATH = 120;
const MAX_SRC = 40;
const MAX_UA = 300;
const MAX_REFERRER = 200;

const BOT_UA = /bot|crawler|spider|slurp|monitor|preview|curl|wget|headless|render|uptime|probe/i;

let handle: BetterSqliteDb | null = null;

/** Default location for local rehearsals; Render points `DEMO_ANALYTICS_DB` at its disk. */
function defaultAnalyticsDbPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../data/demo-analytics.db");
}

export function demoAnalyticsDb(): BetterSqliteDb {
  if (handle) return handle;
  const path = process.env.DEMO_ANALYTICS_DB?.trim() || defaultAnalyticsDbPath();
  const opened = new Database(path);
  opened.pragma("journal_mode = WAL");
  opened.exec(
    `CREATE TABLE IF NOT EXISTS demo_visits (
       day TEXT NOT NULL,
       visitor TEXT NOT NULL,
       src TEXT,
       referrer TEXT,
       country TEXT,
       user_agent TEXT,
       first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       request_count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (day, visitor)
     );
     CREATE TABLE IF NOT EXISTS demo_pageviews (
       day TEXT NOT NULL,
       visitor TEXT NOT NULL,
       path TEXT NOT NULL,
       views INTEGER NOT NULL DEFAULT 0,
       first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (day, visitor, path)
     );
     CREATE TABLE IF NOT EXISTS demo_analytics_meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );`
  );
  handle = opened;
  return opened;
}

/**
 * Long-lived salt: `DEMO_ANALYTICS_SALT` when set (Render generates it), else one random
 * value persisted in the analytics DB so ids stay stable across restarts of a local rehearsal.
 */
function visitorSalt(): string {
  const fromEnv = process.env.DEMO_ANALYTICS_SALT?.trim();
  if (fromEnv) return fromEnv;
  const db = demoAnalyticsDb();
  const row = db.prepare(`SELECT value FROM demo_analytics_meta WHERE key = 'visitor_salt'`).get() as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const generated = randomBytes(32).toString("hex");
  db.prepare(`INSERT INTO demo_analytics_meta (key, value) VALUES ('visitor_salt', ?)`).run(
    generated
  );
  return generated;
}

/**
 * Opaque per-day visitor id. Mixing the day into the key (not just the message) means an id
 * from yesterday cannot be recomputed for the same person today — the log stays a daily
 * unique-visitor count, never a cross-day trail.
 */
export function visitorKey(ip: string, userAgent: string, day: string): string {
  const dailyKey = createHmac("sha256", visitorSalt()).update(day).digest();
  return createHmac("sha256", dailyKey).update(`${ip}|${userAgent}`).digest("hex").slice(0, 16);
}

/** True for crawlers, uptime pings and Render's health check — they aren't visitors. */
export function isBotUserAgent(userAgent: string): boolean {
  return userAgent.trim() === "" || BOT_UA.test(userAgent);
}

/** Keep the origin only: where they came from is the signal, the full URL is their business. */
export function referrerOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin.slice(0, MAX_REFERRER);
  } catch {
    return null;
  }
}

function clamp(value: string | undefined, max: number): string | null {
  const t = value?.trim();
  return t ? t.slice(0, max) : null;
}

/** Campaign tag from `?src=` (we publish ?src=linkedin / cv / homepage links). */
export function srcTagFromQuery(query: unknown): string | null {
  if (typeof query !== "object" || query === null) return null;
  const raw = (query as Record<string, unknown>).src;
  return typeof raw === "string" ? clamp(raw.replace(/[^\w.-]/g, ""), MAX_SRC) : null;
}

export type VisitInput = {
  visitor: string;
  day: string;
  src: string | null;
  referrer: string | null;
  country: string | null;
  userAgent: string | null;
};

/** One row per (day, visitor); repeat requests bump `request_count` / `last_seen_at`.
 * `src` and `referrer` keep their first non-null value — the arrival is what they describe. */
export function recordDemoVisit(input: VisitInput): void {
  demoAnalyticsDb()
    .prepare(
      `INSERT INTO demo_visits (day, visitor, src, referrer, country, user_agent, request_count)
       VALUES (@day, @visitor, @src, @referrer, @country, @userAgent, 1)
       ON CONFLICT(day, visitor) DO UPDATE SET
         request_count = request_count + 1,
         last_seen_at = datetime('now'),
         src = COALESCE(demo_visits.src, excluded.src),
         referrer = COALESCE(demo_visits.referrer, excluded.referrer),
         country = COALESCE(demo_visits.country, excluded.country)`
    )
    .run(input);
}

/** One row per (day, visitor, in-app route); repeat views bump `views`. */
export function recordDemoPageview(day: string, visitor: string, path: string): void {
  demoAnalyticsDb()
    .prepare(
      `INSERT INTO demo_pageviews (day, visitor, path, views) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, visitor, path) DO UPDATE SET
         views = views + 1,
         last_seen_at = datetime('now')`
    )
    .run(day, visitor, path);
}

/**
 * Normalize a beacon path to an app route: leading slash, no query/hash, bounded length.
 * Returns null for anything that isn't a plausible route (the beacon is unauthenticated).
 */
export function normalizeBeaconPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const withoutQuery = raw.split(/[?#]/)[0]?.trim() ?? "";
  if (!withoutQuery.startsWith("/") || withoutQuery.startsWith("//")) return null;
  if (withoutQuery.length > MAX_PATH) return null;
  return withoutQuery;
}

/** Visitor identity for a request, or null when it shouldn't be counted (bot / no UA). */
function visitorForRequest(req: Request, day: string): { visitor: string; userAgent: string } | null {
  const userAgent = req.headers["user-agent"] ?? "";
  if (isBotUserAgent(userAgent)) return null;
  return { visitor: visitorKey(req.ip ?? "", userAgent, day), userAgent };
}

function countryHeader(req: Request): string | null {
  const raw = req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"];
  return typeof raw === "string" ? clamp(raw, 8) : null;
}

/** Requests worth counting: API reads and the SPA document itself (never assets/health). */
function isCountableRequest(req: Request): boolean {
  if (req.method !== "GET") return false;
  if (req.path === "/api/health") return false;
  if (req.path.startsWith("/assets/")) return false;
  if (req.path.startsWith("/api/")) return true;
  return (req.headers.accept ?? "").includes("text/html");
}

/**
 * Records one visit row per visitor per day. Mounted only in demo mode. Analytics are an
 * optional side channel: a failure here is logged once per process and never breaks a request.
 */
export function demoVisitLogMiddleware(): RequestHandler {
  let warned = false;
  return (req, _res, next) => {
    if (!isCountableRequest(req)) {
      next();
      return;
    }
    try {
      const day = chileCalendarTodayYmd();
      const identity = visitorForRequest(req, day);
      if (identity) {
        recordDemoVisit({
          day,
          visitor: identity.visitor,
          src: srcTagFromQuery(req.query),
          referrer: referrerOrigin(req.headers.referer),
          country: countryHeader(req),
          userAgent: clamp(identity.userAgent, MAX_UA),
        });
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error("[demo-analytics] visit logging disabled after error:", err);
      }
    }
    next();
  };
}

/**
 * `POST /api/demo/pageview` — the SPA reports its route changes here (the server only sees
 * the initial document request, so without this every visit looks like one page). Registered
 * in demo mode only, and exempt from the read-only guard; always answers 204 so the client
 * beacon has nothing to handle.
 */
export function registerDemoAnalyticsRoutes(app: import("express").Express): void {
  app.post(DEMO_PAGEVIEW_PATH, (req, res) => {
    try {
      const path = normalizeBeaconPath(req.body?.path);
      const day = chileCalendarTodayYmd();
      const identity = visitorForRequest(req, day);
      if (path && identity) {
        recordDemoPageview(day, identity.visitor, path);
        const src = typeof req.body?.src === "string" ? clamp(req.body.src.replace(/[^\w.-]/g, ""), MAX_SRC) : null;
        if (src) {
          demoAnalyticsDb()
            .prepare(
              `UPDATE demo_visits SET src = COALESCE(src, ?) WHERE day = ? AND visitor = ?`
            )
            .run(src, day, identity.visitor);
        }
      }
    } catch (err) {
      console.error("[demo-analytics] pageview beacon error:", err);
    }
    res.status(204).end();
  });
}
