import Database from "better-sqlite3";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, RequestHandler } from "express";
import { chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Anonymous visitor analytics for the open (login-free) hosted demo. Page views and endpoint
 * timings are the usage log's (usageLog.ts), shared with the personal instance; this module adds
 * what only the public demo needs — who arrives and from where — and owns the analytics file
 * both are stored in on the demo (usageDb.ts).
 *
 * The old model asked recruiters for an email behind a shared-password gate; they bounced
 * off the gate instead of using it. What is actually worth knowing is whether people arrive,
 * where from, and whether they explore — so this records visits and in-app pageviews with no
 * login, no cookie, and no stored IP (the visitor hash below also tags each usage page view):
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
     CREATE TABLE IF NOT EXISTS demo_analytics_meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );`
  );
  // The owner's own visits (2026-10-31): kept, flagged, reported apart (see ownerCookie below).
  const columns = opened.prepare(`PRAGMA table_info(demo_visits)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "owner")) {
    opened.exec(
      `ALTER TABLE demo_visits ADD COLUMN owner INTEGER NOT NULL DEFAULT 0 CHECK (owner IN (0, 1))`
    );
  }
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
  /** The request carried the owner cookie: the demo's author, counted apart. */
  owner: boolean;
};

/** One row per (day, visitor); repeat requests bump `request_count` / `last_seen_at`.
 * `src` and `referrer` keep their first non-null value — the arrival is what they describe.
 * `owner` sticks once any request of the visit carried the owner cookie. */
export function recordDemoVisit(input: VisitInput): void {
  demoAnalyticsDb()
    .prepare(
      `INSERT INTO demo_visits (day, visitor, src, referrer, country, user_agent, request_count, owner)
       VALUES (@day, @visitor, @src, @referrer, @country, @userAgent, 1, @owner)
       ON CONFLICT(day, visitor) DO UPDATE SET
         request_count = request_count + 1,
         last_seen_at = datetime('now'),
         src = COALESCE(demo_visits.src, excluded.src),
         referrer = COALESCE(demo_visits.referrer, excluded.referrer),
         country = COALESCE(demo_visits.country, excluded.country),
         owner = MAX(demo_visits.owner, excluded.owner)`
    )
    .run({ ...input, owner: input.owner ? 1 : 0 });
}

/**
 * The visitor's own address. Render serves the demo through Cloudflare, whose edge forwards
 * each request from a different address, so `req.ip` (one trusted proxy hop) changed request by
 * request and one person showed up as a dozen visitors a minute (export of 2026-10-31). Cloudflare
 * states the client in `CF-Connecting-IP`; `req.ip` stays the fallback off Cloudflare.
 */
export function clientAddress(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  return (typeof cf === "string" && cf.trim()) || req.ip || "";
}

/** Visitor identity for a request, or null when it shouldn't be counted (bot / no UA). */
export function demoVisitorForRequest(req: Request, day: string): { visitor: string; userAgent: string } | null {
  const userAgent = req.headers["user-agent"] ?? "";
  if (isBotUserAgent(userAgent)) return null;
  return { visitor: visitorKey(clientAddress(req), userAgent, day), userAgent };
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

// --- The owner's own browsers ------------------------------------------------------------
//
// The author browses the demo too, and can't be told apart by address (none is stored, and a
// home IP changes). Opening the demo once with `?owner=<DEMO_OWNER_CODE>` sets a long-lived
// cookie in that browser; every later request carrying it marks the visit `owner`, which the
// report (`npm run demo:visits`) shows apart. It is per browser (once in each browser and
// device, again after clearing cookies). Without DEMO_OWNER_CODE the feature is off. Anyone
// who learned the code would only hide their own visits, so it is not a secret that matters.

export const OWNER_COOKIE = "nw_demo_owner";
const OWNER_COOKIE_MAX_AGE_S = 5 * 365 * 24 * 3600;

function ownerCode(): string | null {
  return process.env.DEMO_OWNER_CODE?.trim() || null;
}

/** One cookie's value from the Cookie header (no cookie-parser dependency for one cookie). */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** The request is the owner's: it carries the cookie with the current code, or the code itself. */
export function isOwnerRequest(req: Request): boolean {
  const code = ownerCode();
  if (!code) return false;
  return cookieValue(req.headers.cookie, OWNER_COOKIE) === code || req.query.owner === code;
}

/**
 * `?owner=<code>` on any request sets the owner cookie (HttpOnly, 5 years). A wrong code does
 * nothing. Mounted in demo mode only, before the visit log.
 */
export function demoOwnerCookieMiddleware(): RequestHandler {
  return (req, res, next) => {
    const code = ownerCode();
    if (code && req.query.owner === code) {
      const secure = req.secure ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `${OWNER_COOKIE}=${encodeURIComponent(code)}; Max-Age=${OWNER_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`
      );
    }
    next();
  };
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
      const identity = demoVisitorForRequest(req, day);
      if (identity) {
        recordDemoVisit({
          day,
          visitor: identity.visitor,
          src: srcTagFromQuery(req.query),
          referrer: referrerOrigin(req.headers.referer),
          country: countryHeader(req),
          userAgent: clamp(identity.userAgent, MAX_UA),
          owner: isOwnerRequest(req),
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

/** A src tag the client kept from the landing URL; the visit keeps its first one. */
export function noteDemoVisitSrc(day: string, visitor: string, rawSrc: unknown): void {
  const src = typeof rawSrc === "string" ? clamp(rawSrc.replace(/[^\w.-]/g, ""), MAX_SRC) : null;
  if (!src) return;
  demoAnalyticsDb()
    .prepare(`UPDATE demo_visits SET src = COALESCE(src, ?) WHERE day = ? AND visitor = ?`)
    .run(src, day, visitor);
}
