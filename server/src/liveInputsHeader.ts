import type { NextFunction, Request, RequestHandler, Response } from "express";
import { cacheDepNodeLiveInputs, newCacheDepNode, runInCacheDepNode, type CacheDepNode } from "./cacheDependencies.js";

/**
 * Each GET API response names the live inputs it read (2026-11-04): `X-Live-Inputs` is `none`, or
 * the tickers whose live quote it read and `$fx` (the live dollar) / `$dimming` (the dashboard's
 * sync dimming), comma-separated. The client refetches a query on a price change only when one of
 * them moved (`client/src/liveInputs.ts`), instead of refetching every query on every move.
 *
 * The request runs inside its own dependency node (`cacheDependencies.ts`): what it reads live is
 * recorded there, and a cache or live-tier hit links the entry's node, so a response served from
 * cache names the same inputs as the build that made it. A reader that reads a live quote without
 * reporting it would be stale here as it already is in the cache.
 */

/** The response header; the client reads it by this name too. */
export const LIVE_INPUTS_HEADER = "X-Live-Inputs";

const SKIPPED_PATHS = new Set(["/api/live-quotes/stamp"]);

export function liveInputsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || !req.path.startsWith("/api/") || SKIPPED_PATHS.has(req.path)) {
      next();
      return;
    }
    const node = newCacheDepNode();
    res.locals.liveInputsNode = node;
    runInCacheDepNode(node, next);
  };
}

export function formatLiveInputs(inputs: { tickers: Iterable<string>; fx: boolean; syncDimming: boolean }): string {
  const tokens = [...inputs.tickers].sort();
  if (inputs.fx) tokens.unshift("$fx");
  if (inputs.syncDimming) tokens.unshift("$dimming");
  return tokens.length > 0 ? tokens.join(",") : "none";
}

/** Sets the header from the request's node (called as the JSON response goes out). */
export function setLiveInputsHeader(res: Response): void {
  const node = res.locals.liveInputsNode as CacheDepNode | undefined;
  if (!node || res.headersSent) return;
  res.setHeader(LIVE_INPUTS_HEADER, formatLiveInputs(cacheDepNodeLiveInputs(node)));
}
