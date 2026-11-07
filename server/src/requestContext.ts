import type { Request } from "express";
import { USAGE_PAGE_VIEW_PATH } from "./usagePagePath.js";

/**
 * What a request is, decided once, and what the middlewares tell each other about it
 * (2026-11-07, docs/untangle-plan.md F14). Until then seven middlewares each classified a request
 * their own way, and two passed facts through untyped `res.locals` keys, which made their order
 * load-bearing.
 *
 * - `health` — `/api/health` (the host and the deploy agent poll it);
 * - `beacon` — the page-view beacon (sent once a page has settled; nobody waits for its answer);
 * - `machine` — the ingest service and the deploy agent (`/api/ingest`, `/api/jobs`: heartbeats
 *   every minute, run reports, claims, document applies). No person waits on it;
 * - `api-read` / `api-write` — everything else under `/api`, by method (GET, HEAD and OPTIONS read);
 * - `other` — not the API (the SPA document, its assets).
 */
export type RequestKind = "health" | "beacon" | "machine" | "api-read" | "api-write" | "other";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

export function requestKind(method: string | undefined, path: string): RequestKind {
  if (!isApiPath(path)) return "other";
  if (path === "/api/health") return "health";
  if (path === USAGE_PAGE_VIEW_PATH) return "beacon";
  if (isUnder(path, "/api/ingest") || isUnder(path, "/api/jobs")) return "machine";
  return method != null && READ_METHODS.has(method) ? "api-read" : "api-write";
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Whether a request's answer drops the API response caches (`index.ts`): a person's write, and a
 * machine request that applies data — an ingest kind or server task, whose writers do not all reach
 * an aggregation funnel yet (utility bills, receipts, declared payments: the cache registry, F2,
 * will make each writer say what it drops). Heartbeats, claims, job completions and run reports
 * write only the queue and the run log: until 2026-11-07 every one of them emptied the response
 * caches and set off a full warm, once a minute while a run lasted (bug 16).
 */
export function requestDropsResponseCaches(method: string | undefined, path: string): boolean {
  const kind = requestKind(method, path);
  if (kind === "api-write") return true;
  if (kind !== "machine" || method !== "POST" || !path.startsWith("/api/ingest/")) return false;
  return !path.startsWith("/api/ingest/runs/");
}

/** True for a method that changes nothing (the demo's read-only guard lets it through). */
export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}

export type RequestContext = {
  readonly kind: RequestKind;
  /** {@link requestDropsResponseCaches}. */
  readonly dropsResponseCaches: boolean;
  /**
   * Headers the JSON serializer adds as the response goes out (`jsonResponse.ts`): the live
   * inputs a GET read (`liveInputsHeader.ts`) are only known once the route has run.
   */
  readonly lateHeaders: (() => [name: string, value: string] | null)[];
  /** The payload size before compression, set by the JSON serializer; read by the usage log. */
  jsonBodyBytes: number | null;
};

const contexts = new WeakMap<Request, RequestContext>();

/** The request's context, created on first use (whichever middleware reads it first). */
export function requestContext(req: Request): RequestContext {
  let ctx = contexts.get(req);
  if (!ctx) {
    ctx = {
      kind: requestKind(req.method, req.path),
      dropsResponseCaches: requestDropsResponseCaches(req.method, req.path),
      lateHeaders: [],
      jsonBodyBytes: null,
    };
    contexts.set(req, ctx);
  }
  return ctx;
}
