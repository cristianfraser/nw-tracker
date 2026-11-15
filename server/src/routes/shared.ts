/**
 * Helpers shared by the domain route modules (split out of the former monolithic
 * index.ts). Route URLs and handler bodies are verbatim from that file.
 */
import express from "express";
import { parseEnvFlag } from "nw-tracker-contracts";
import { isResolvablePortfolioGroupSlug } from "../portfolioGroupTree.js";
import { db } from "../db.js";

export function accountIdFromReq(req: { params: { id?: string } }): number {
  const raw = Number(req.params.id);
  return Number.isFinite(raw) ? raw : NaN;
}

export function isKnownClassTabGroup(group: string): boolean {
  if (isResolvablePortfolioGroupSlug(group)) return true;
  const ag = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(group) as
    | { o: number }
    | undefined;
  return Boolean(ag);
}

/**
 * A query parameter that names one of `values`: absent (or empty) reads as `fallback`. Any other
 * value answers 400 and returns null — the caller returns; a mistyped value is never read as the
 * default.
 */
export function queryChoice<T extends string>(
  req: express.Request,
  res: express.Response,
  name: string,
  values: readonly T[],
  fallback: T
): T | null {
  const raw = req.query[name];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw === "string" && (values as readonly string[]).includes(raw)) return raw as T;
  res.status(400).json({ error: `${name} must be one of ${values.join(", ")}` });
  return null;
}

/**
 * An on/off query parameter by the one flag rule (`parseEnvFlag`: 1/true/yes, 0/false/no): absent
 * (or empty) is off. Any other value answers 400 and returns null — the caller returns.
 */
export function queryFlag(req: express.Request, res: express.Response, name: string): boolean | null {
  const raw = req.query[name];
  if (raw === undefined) return false;
  if (typeof raw === "string") {
    try {
      return parseEnvFlag(name, raw) ?? false;
    } catch {
      // Not a flag value: the 400 below.
    }
  }
  res.status(400).json({ error: `${name} must be 1/true/yes or 0/false/no` });
  return null;
}

/**
 * Express 4 does not forward async-handler rejections to middleware; on Node ≥15 an
 * unhandled rejection kills the process. Every async route must go through this.
 */
export const asyncHandler =
  (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
