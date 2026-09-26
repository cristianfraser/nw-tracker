/**
 * Helpers shared by the domain route modules (split out of the former monolithic
 * index.ts). Route URLs and handler bodies are verbatim from that file.
 */
import express from "express";
import { isResolvablePortfolioGroupSlug } from "../portfolioGroupTree.js";
import { db } from "../db.js";

export function accountIdFromReq(req: { params: { id?: string } }): number {
  const raw = Number(req.params.id);
  return Number.isFinite(raw) ? raw : NaN;
}

export function parseProxyTickersParam(raw: unknown): string[] | null {
  if (raw == null || raw === "") return null;
  const str = String(raw).trim();
  if (!str) return null;
  const tickers = str.split(",").map((t) => t.trim()).filter(Boolean);
  return tickers.length > 0 ? tickers : null;
}


export function isKnownClassTabGroup(group: string): boolean {
  if (group === "inversiones") return true;
  if (isResolvablePortfolioGroupSlug(group)) return true;
  const ag = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(group) as
    | { o: number }
    | undefined;
  return Boolean(ag);
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
