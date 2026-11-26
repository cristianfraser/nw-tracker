import type { RequestHandler } from "express";
import { hostHeaderHostname, serverConfig, type ServerConfig } from "./config.js";
import { demoWriteAllowedByPolicy } from "./demoWritePolicy.js";
import { isApiPath, isReadMethod, requestContext } from "./requestContext.js";

/**
 * Deployment modes share one binary and differ only by env:
 * - Local personal mode (default): bind 127.0.0.1, dev-origin CORS.
 * - Hosted demo mode (e.g. Render): HOST=0.0.0.0, DEMO_MODE=1 → open to anyone, reads plus a few
 *   edits without free text (demoWritePolicy.ts).
 *
 * Neither mode authenticates. The demo used to sit behind a shared-password login; recruiters
 * bounced off the gate instead of using it, so the demo is public and the guard below is what
 * keeps its shared synthetic DB intact (with the per-visitor quota and the reset, demoWritable.ts).
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
// The hosted demo is public (no login). Its synthetic DB is shared by every visitor, so demo
// mode serves reads plus the allowlisted edits (demoWritePolicy.ts); those are counted against
// a per-visitor allowance and undone by the reset to the generated state (demoWritable.ts).

/**
 * Rejects `/api` mutations with `403 { error: "demo_read_only" }` (the client turns that
 * sentinel into a localized message). Non-`/api` paths, the usage page-view beacon and the
 * allowlisted demo edits pass through.
 * Mounted only when `DEMO_MODE=1`, so local personal mode is unaffected.
 */
export function demoReadOnlyMiddleware(): RequestHandler {
  return (req, res, next) => {
    const kind = requestContext(req).kind;
    if (kind === "other" || kind === "beacon" || isReadMethod(req.method) || demoWriteAllowedByPolicy(req.method, req.path)) {
      next();
      return;
    }
    res.status(403).json({ error: "demo_read_only" });
  };
}

// --- Host allowlist and cross-site write guard ----------------------------------------
//
// The personal API has no login: binding 127.0.0.1 keeps other machines out, but not other
// websites in the browser on this machine. A page whose domain re-resolves to 127.0.0.1 (DNS
// rebinding) is same-origin with the server and could read every endpoint; any page can send a
// body-less or form-encoded POST that `cors()` never stops (CORS only hides the answer). The two
// guards below close both. The demo serves public synthetic data on a platform hostname, so it
// runs neither.

/** Names every personal instance answers to: the deploy agent and the ingest service call 127.0.0.1. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function originHostname(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`CORS_ALLOWED_ORIGINS entry ${JSON.stringify(origin)}: expected an origin such as http://localhost:5173`);
  }
  return url.hostname.toLowerCase();
}

/** Loopback, the CORS origins' hosts and `ALLOWED_HOSTS`. */
export function allowedRequestHosts(config: ServerConfig = serverConfig()): ReadonlySet<string> {
  return new Set([...LOOPBACK_HOSTS, ...config.corsOrigins.map(originHostname), ...config.allowedHosts]);
}

/**
 * Answers `421 { error: "host_not_allowed" }` to a request whose `Host` (port ignored) is not an
 * allowed name ({@link allowedRequestHosts}); the raw header is read, never `X-Forwarded-Host`.
 * Off in the demo. Mounted before every route.
 */
export function hostAllowlistMiddleware(config: ServerConfig = serverConfig()): RequestHandler {
  if (config.profile.demo) return (_req, _res, next) => next();
  const allowed = allowedRequestHosts(config);
  return (req, res, next) => {
    const host = hostHeaderHostname(req.headers.host ?? "");
    if (host != null && allowed.has(host)) {
      next();
      return;
    }
    res.status(421).json({ error: "host_not_allowed" });
  };
}

/**
 * True when a browser page's origin may write: an origin in the CORS allowlist, the request's
 * own `Host` (same host and port), or an origin on one of the explicitly configured
 * `ALLOWED_HOSTS` (the public name, which a proxy may forward under another port).
 */
function trustedWriteOrigin(origin: string, hostHeader: string | undefined, config: ServerConfig): boolean {
  if (config.corsOrigins.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, opaque redirects) and anything unparseable
  }
  if (hostHeader != null && url.host.toLowerCase() === hostHeader.trim().toLowerCase()) return true;
  return config.allowedHosts.includes(url.hostname.toLowerCase());
}

/**
 * Answers `403 { error: "cross_site_write" }` to an `/api` write (any method but GET, HEAD and
 * OPTIONS) sent from another site's page: its `Origin` is not trusted ({@link trustedWriteOrigin}),
 * or the browser marks it `Sec-Fetch-Site: cross-site` with no origin. The browser's own
 * `Sec-Fetch-Site: same-origin` passes (the Vite dev proxy rewrites `Host`, and a rebound name has
 * already been refused by the host allowlist). A request with neither header — curl, the ingest
 * service, the deploy agent — is not a browser page and passes. Off in the demo.
 */
export function crossSiteWriteGuardMiddleware(config: ServerConfig = serverConfig()): RequestHandler {
  if (config.profile.demo) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (!isApiPath(req.path) || isReadMethod(req.method)) {
      next();
      return;
    }
    const fetchSite = headerText(req.headers["sec-fetch-site"]);
    const origin = headerText(req.headers.origin);
    const trusted =
      fetchSite === "same-origin" ||
      (origin == null ? fetchSite !== "cross-site" : trustedWriteOrigin(origin, req.headers.host, config));
    if (trusted) {
      next();
      return;
    }
    res.status(403).json({ error: "cross_site_write" });
  };
}

function headerText(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}
