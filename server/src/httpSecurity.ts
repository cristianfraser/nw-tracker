import type { RequestHandler } from "express";

/**
 * Deployment modes share one binary and differ only by env:
 * - Local personal mode (default): bind 127.0.0.1, dev-origin CORS.
 * - Hosted demo mode (e.g. Render): HOST=0.0.0.0, DEMO_MODE=1 → open to anyone, reads only.
 *
 * Neither mode authenticates. The demo used to sit behind a shared-password login; recruiters
 * bounced off the gate instead of using it, so the demo is public and the read-only guard
 * below is what keeps its shared synthetic DB intact.
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

// --- Demo read-only guard -----------------------------------------------------------
//
// The hosted demo is public (no login). Its synthetic DB is shared by every visitor and
// only regenerates on deploy / cold start, so a single mutating request would corrupt what
// the next visitor sees. Demo mode therefore serves reads only.

/** Analytics beacon path — a POST, but the one mutation the demo accepts (see demoAnalytics.ts). */
export const DEMO_PAGEVIEW_PATH = "/api/demo/pageview";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects `/api` mutations with `403 { error: "demo_read_only" }` (the client turns that
 * sentinel into a localized message). Non-`/api` paths and the analytics beacon pass through.
 * Mounted only when `DEMO_MODE=1`, so local personal mode is unaffected.
 */
export function demoReadOnlyMiddleware(): RequestHandler {
  return (req, res, next) => {
    const isApi = req.path === "/api" || req.path.startsWith("/api/");
    if (!isApi || READ_ONLY_METHODS.has(req.method) || req.path === DEMO_PAGEVIEW_PATH) {
      next();
      return;
    }
    res.status(403).json({ error: "demo_read_only" });
  };
}
