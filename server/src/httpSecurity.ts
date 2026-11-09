import type { RequestHandler } from "express";
import { serverConfig } from "./config.js";
import { isReadMethod, requestContext } from "./requestContext.js";

/**
 * Deployment modes share one binary and differ only by env:
 * - Local personal mode (default): bind 127.0.0.1, dev-origin CORS.
 * - Hosted demo mode (e.g. Render): HOST=0.0.0.0, DEMO_MODE=1 → open to anyone, reads only.
 *
 * Neither mode authenticates: the demo is public (a login gate made visitors bounce) and the
 * read-only guard below is what keeps its shared synthetic DB intact.
 */

/** Bind host (`HOST`, `config.ts`). The default, 127.0.0.1, keeps the unauthenticated local API off the LAN. */
export function resolveBindHost(): string {
  return serverConfig().bindHost;
}

/** CORS allowlist from `CORS_ALLOWED_ORIGINS` (comma-separated); Vite dev/preview origins by default. */
export function resolveCorsOrigins(): string[] {
  return serverConfig().corsOrigins;
}

// --- Demo read-only guard -----------------------------------------------------------
//
// The hosted demo is public (no login). Its synthetic DB is shared by every visitor and
// only regenerates on deploy / cold start, so a single mutating request would corrupt what
// the next visitor sees. Demo mode therefore serves reads only.


/**
 * Rejects `/api` mutations with `403 { error: "demo_read_only" }` (the client turns that
 * sentinel into a localized message). Non-`/api` paths and the usage page-view beacon pass through.
 * Mounted only when `DEMO_MODE=1`, so local personal mode is unaffected.
 */
export function demoReadOnlyMiddleware(): RequestHandler {
  return (req, res, next) => {
    const kind = requestContext(req).kind;
    if (kind === "other" || kind === "beacon" || isReadMethod(req.method)) {
      next();
      return;
    }
    res.status(403).json({ error: "demo_read_only" });
  };
}
