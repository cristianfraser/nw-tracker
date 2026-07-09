import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { demoAuthLogDb } from "./demoAuthLog.js";

/**
 * Deployment modes share one binary and differ only by env:
 * - Local personal mode (default): bind 127.0.0.1, dev-origin CORS, no auth.
 * - Hosted demo mode (e.g. Render): HOST=0.0.0.0, CORS_ALLOWED_ORIGINS set to the
 *   public origin, AUTH_PASSWORD set → every /api request requires the shared password.
 */

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Bind host. Default keeps the unauthenticated local API off the LAN. */
export function resolveBindHost(): string {
  return process.env.HOST?.trim() || "127.0.0.1";
}

/** CORS allowlist from `CORS_ALLOWED_ORIGINS` (comma-separated); Vite dev/preview origins by default. */
export function resolveCorsOrigins(): string[] {
  const fromEnv = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_DEV_ORIGINS;
}

/** Shared demo password (`AUTH_PASSWORD`); null disables auth (local mode). */
export function sharedAuthPasswordFromEnv(): string | null {
  const p = process.env.AUTH_PASSWORD?.trim();
  return p && p.length > 0 ? p : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Format check only — any syntactically plausible email is accepted (the email is an
 * identity label for the login log, not a verified address).
 */
export function isValidDemoAuthEmail(email: string): boolean {
  const t = email.trim();
  return t.length > 0 && t.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

/** One row per (email, Chile day); repeat requests bump `request_count` / `last_seen_at`. */
export function recordDemoAuthLogin(email: string, day = chileCalendarTodayYmd()): void {
  demoAuthLogDb()
    .prepare(
      `INSERT INTO demo_auth_logins (email, day, request_count) VALUES (?, ?, 1)
     ON CONFLICT(email, day) DO UPDATE SET
       request_count = request_count + 1,
       last_seen_at = datetime('now')`
    )
    .run(email.trim().toLowerCase(), day);
}

/**
 * HTTP Basic auth with a shared password: any *valid email* as username + the shared
 * password (recruiter demo model — wildcard identity, one password). Authenticated
 * emails are recorded in `demo_auth_logins`. `/api/health` stays open for the hosting
 * platform's health checks.
 */
export function sharedPasswordAuthMiddleware(password: string): RequestHandler {
  return (req, res, next) => {
    if (req.path === "/api/health") {
      next();
      return;
    }
    const header = req.headers.authorization ?? "";
    const m = /^Basic (.+)$/.exec(header);
    if (m) {
      const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const email = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const candidate = sep >= 0 ? decoded.slice(sep + 1) : "";
      if (!isValidDemoAuthEmail(email)) {
        res.set("WWW-Authenticate", 'Basic realm="nw-tracker"');
        res.status(401).json({ error: "username must be a valid email" });
        return;
      }
      if (constantTimeEquals(candidate, password)) {
        recordDemoAuthLogin(email);
        next();
        return;
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="nw-tracker"');
    res.status(401).json({ error: "authentication required" });
  };
}
