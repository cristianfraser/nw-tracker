import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { demoAuthLogDb } from "./demoAuthLog.js";

/**
 * Deployment modes share one binary and differ only by env:
 * - Local personal mode (default): bind 127.0.0.1, dev-origin CORS, no auth.
 * - Hosted demo mode (e.g. Render): HOST=0.0.0.0, CORS_ALLOWED_ORIGINS set to the
 *   public origin, AUTH_PASSWORD set → every /api request requires a valid session cookie
 *   (issued by the in-app /login page — see routes/auth.ts).
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

/** Constant-time check of a login candidate against the configured shared password. */
export function verifyDemoPassword(candidate: string): boolean {
  const password = sharedAuthPasswordFromEnv();
  if (!password) return false;
  return constantTimeEquals(candidate, password);
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

// --- Stateless signed session (HttpOnly cookie) -------------------------------------
//
// The hosted demo regenerates its synthetic DB on every deploy / cold start, so we avoid a
// server-side session store: the cookie itself is a self-verifying, HMAC-signed token that
// encodes the authenticated email + an issue timestamp. Rotating the password (the default
// signing secret) invalidates every outstanding session, which is acceptable for a demo.

/** Cookie name for the signed demo session token. */
export const SESSION_COOKIE = "nw_session";

/** Max session age before re-login is required (default 7 days). */
function sessionMaxAgeMs(): number {
  const v = Number(process.env.SESSION_MAX_AGE_MS);
  return Number.isFinite(v) && v > 0 ? v : 7 * 24 * 60 * 60 * 1000;
}

/** HMAC signing secret: explicit `SESSION_SECRET`, else derived from `AUTH_PASSWORD`. */
function sessionSecret(): string {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  return `nw-session|${sharedAuthPasswordFromEnv() ?? ""}`;
}

function signSessionPayload(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Issue a signed session token for `email` (base64url(email).issuedAtMs.sig). */
export function issueSessionToken(email: string, issuedAtMs = Date.now()): string {
  const emailPart = Buffer.from(email.trim().toLowerCase(), "utf8").toString("base64url");
  const payload = `${emailPart}.${issuedAtMs}`;
  return `${payload}.${signSessionPayload(payload)}`;
}

/**
 * Verify a session token: constant-time HMAC check + max-age. Returns the authenticated
 * email or null (tampered, wrong secret, malformed, or expired → re-login).
 */
export function verifySessionToken(token: string | undefined | null): { email: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [emailPart, issuedAtRaw, sig] = parts as [string, string, string];
  const payload = `${emailPart}.${issuedAtRaw}`;
  if (!constantTimeEquals(sig, signSessionPayload(payload))) return null;
  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAtMs)) return null;
  if (Date.now() - issuedAtMs > sessionMaxAgeMs()) return null;
  const email = Buffer.from(emailPart, "base64url").toString("utf8");
  if (!isValidDemoAuthEmail(email)) return null;
  return { email };
}

/** Read a single cookie value from the raw `Cookie` header (avoids a cookie-parser dep). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Paths reachable without a session (login flow + health check). */
function isAuthExemptPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/auth/status" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout"
  );
}

/**
 * Shared-password session gate (recruiter demo model — wildcard email identity, one
 * password). Non-`/api` paths pass through so the static SPA shell can load and render the
 * in-app `/login` page; `/api/*` requires a valid `nw_session` cookie (issued by
 * POST /api/auth/login). No `WWW-Authenticate` header, so the browser never shows its
 * native Basic-auth prompt. Authenticated emails are recorded in `demo_auth_logins`.
 */
export function sharedPasswordAuthMiddleware(_password: string): RequestHandler {
  return (req, res, next) => {
    // Only API routes are gated; the SPA shell + /assets load unauthenticated.
    if (req.path !== "/api" && !req.path.startsWith("/api/")) {
      next();
      return;
    }
    if (isAuthExemptPath(req.path)) {
      next();
      return;
    }
    const session = verifySessionToken(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (session) {
      recordDemoAuthLogin(session.email);
      next();
      return;
    }
    res.status(401).json({ error: "authentication required" });
  };
}
