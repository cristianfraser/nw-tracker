/**
 * Helpers shared by the domain route modules (split out of the former monolithic
 * index.ts). Route URLs and handler bodies are verbatim from that file.
 */
import express from "express";
import { isResolvablePortfolioGroupSlug } from "../portfolioGroupTree.js";
import { parseExtraOffsetsJson } from "../creditCardInstallments.js";
import { equityReturnSnapshot } from "../equityReturns.js";
import { type DashboardAccountStats } from "../brokerageAcciones.js";
import { db } from "../db.js";
import { resolveOperationalAccountId } from "../accountSource.js";
import type { AccountPositionMeta } from "../accountPosition.js";

export function operationalAccountIdFromReq(req: { params: { id?: string } }): number {
  const raw = Number(req.params.id);
  if (!Number.isFinite(raw)) return NaN;
  return resolveOperationalAccountId(raw);
}

/** Parses `req.query.extraOffsets`; on malformed input sends the 400 and returns null. */
export function extraOffsetsFromReq(
  req: express.Request,
  res: express.Response
): Record<string, number> | null {
  try {
    return parseExtraOffsetsJson(req.query.extraOffsets);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid extraOffsets" });
    return null;
  }
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
 * Account detail + dashboard position row.
 * **AFP:** when we have Σ cuotas and a reputable **valor cuota** (`fund_unit_daily`), **valor hoy** is
 * `cuotas × valor_cuota` so the three columns are consistent. If either is missing, falls back to the latest
 * `valuations` row (e.g. Excel month-end) like other accounts.
 */
export function positionSnapshotFromMeta(
  categorySlug: string | null | undefined,
  meta: AccountPositionMeta | null,
  deposits_clp: number,
  latest: { value_clp: number; as_of_date: string } | null | undefined,
  accountId?: number
): DashboardAccountStats["position"] {
  if (meta == null) return null;
  const afp = categorySlug === "afp";
  const crypto = categorySlug === "bitcoin" || categorySlug === "eth";
  const v = latest?.value_clp;
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  const mtmMark =
    (afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0));
  const value_clp = mtmMark ? ovc : v != null && Number.isFinite(v) ? v : null;
  const value_as_of =
    mtmMark
      ? meta.afp_override_value_as_of ?? null
      : latest?.as_of_date ?? null;
  const value_per_unit_clp =
    afp && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
      ? meta.afp_override_valor_cuota_clp
      : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
        ? v / units
        : null;
  const equityReturns =
    accountId != null ? equityReturnSnapshot(accountId, deposits_clp, value_clp) : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    deposited_clp: deposits_clp,
    value_clp,
    value_as_of,
    value_per_unit_clp,
    ...(equityReturns ?? {}),
  };
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
