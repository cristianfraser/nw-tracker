/**
 * Fintual valuation: prefer `real_assets` fund cuota × DB cuotas; compare to `GET /api/goals` NAV.
 */
import { chileCalendarAddDays, type ChileWallClock } from "../src/chileDate.js";
import { resolveFintualPublishYmd } from "../src/fintualPublishDate.js";
import { fintualGoalUnitsFromMovements } from "../src/fintualGoalUnits.js";
import { db } from "../src/db.js";
import {
  FINTUAL_API_BASE,
  fetchFintualWithBackoff,
  normalizeFintualCookieInput,
  loadRootDotenv,
} from "./fintualApiLib.js";
import type { FintualGoalRow } from "./fintualApiLib.js";

export type FintualGoalRowWithMatch = FintualGoalRow & { matchedNotes: string | null };

const RECENT_DAY_ROWS = 14;
const MISMATCH_CLP = 1;

type GoalInvestment = { weight: number; asset_id: number };

type RealAssetLastDay = { date: string; netAssetValue: number };

const recentNavCache = new Map<number, Map<string, number>>();
const lastDayCache = new Map<number, RealAssetLastDay | null>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FintualGoalNavResolution = {
  row: FintualGoalRowWithMatch;
  goalsApiNavClp: number;
  realAssetsNavClp: number | null;
  appliedNavClp: number;
  units: number | null;
  fundPriceClp: number | null;
  mismatch: boolean;
};

export type ResolveFintualGoalNavsResult = {
  resolutions: FintualGoalNavResolution[];
  /** Fund cuota publish date used for NAV and valuations (may be before poll calendar day). */
  publishYmd: string;
};

function authHeaders(email: string, token: string): Record<string, string> {
  loadRootDotenv();
  const h: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "nw-tracker-fintual-scripts/1.0",
    "X-User-Email": email,
    "X-User-Token": token,
  };
  const cookie = process.env.FINTUAL_COOKIE?.trim();
  if (cookie) h.Cookie = normalizeFintualCookieInput(cookie);
  return h;
}

async function fetchRealAssetLastDay(
  email: string,
  token: string,
  assetId: number
): Promise<RealAssetLastDay | null> {
  if (lastDayCache.has(assetId)) return lastDayCache.get(assetId) ?? null;
  const res = await fetchFintualWithBackoff(
    `${FINTUAL_API_BASE}/real_assets/${assetId}`,
    {
      headers: authHeaders(email, token),
    },
    `GET /real_assets/${assetId}`
  );
  const text = await res.text();
  if (!res.ok) {
    lastDayCache.set(assetId, null);
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    lastDayCache.set(assetId, null);
    return null;
  }
  const attrs = (body as { data?: { attributes?: { last_day?: { date?: string; net_asset_value?: number } } } })
    .data?.attributes;
  const ld = attrs?.last_day;
  const date = typeof ld?.date === "string" ? ld.date : "";
  const netAssetValue =
    typeof ld?.net_asset_value === "number" && Number.isFinite(ld.net_asset_value)
      ? ld.net_asset_value
      : NaN;
  const out =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(netAssetValue)
      ? { date, netAssetValue }
      : null;
  lastDayCache.set(assetId, out);
  return out;
}

/** Full `GET /real_assets/:id/days` history (paginated) for backfill scripts. */
export async function fetchRealAssetNavHistoryByDate(
  email: string,
  token: string,
  assetId: number,
  opts?: { pageDelayMs?: number; onRequestLog?: (msg: string) => void }
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const delayMs = Math.max(0, Math.round(opts?.pageDelayMs ?? 0));
  let page = 1;
  for (;;) {
    opts?.onRequestLog?.(`Fintual API -> GET /real_assets/${assetId}/days?page=${page}`);
    const res = await fetchFintualWithBackoff(
      `${FINTUAL_API_BASE}/real_assets/${assetId}/days?page=${page}`,
      {
        headers: authHeaders(email, token),
      },
      `GET /real_assets/${assetId}/days?page=${page}`
    );
    const text = await res.text();
    opts?.onRequestLog?.(
      `Fintual API <- GET /real_assets/${assetId}/days?page=${page} status=${res.status}`
    );
    if (!res.ok) break;
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      break;
    }
    const data = (body as { data?: unknown[] }).data;
    if (!Array.isArray(data) || data.length === 0) break;
    const sizeBefore = map.size;
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const attrs = (item as { attributes?: { date?: string; net_asset_value?: number } }).attributes;
      const date = typeof attrs?.date === "string" ? attrs.date : "";
      const nav =
        typeof attrs?.net_asset_value === "number" && Number.isFinite(attrs.net_asset_value)
          ? attrs.net_asset_value
          : NaN;
      if (date && Number.isFinite(nav) && nav > 0) map.set(date, nav);
    }
    opts?.onRequestLog?.(
      `Fintual API page parsed asset=${assetId} page=${page} rows=${data.length} accumulated_days=${map.size}`
    );
    if (map.size === sizeBefore) {
      opts?.onRequestLog?.(
        `Fintual API page added no new days; stop paging (asset=${assetId}, page=${page})`
      );
      break;
    }
    page += 1;
    if (data.length < 30) break;
    if (page > 500) break;
    if (delayMs > 0) {
      opts?.onRequestLog?.(`Fintual API sleep ${delayMs}ms before next page (asset=${assetId})`);
      await sleep(delayMs);
    }
  }
  return map;
}

async function recentNavByDate(
  email: string,
  token: string,
  assetId: number
): Promise<Map<string, number>> {
  const cached = recentNavCache.get(assetId);
  if (cached) return cached;

  const res = await fetchFintualWithBackoff(
    `${FINTUAL_API_BASE}/real_assets/${assetId}/days`,
    {
      headers: authHeaders(email, token),
    },
    `GET /real_assets/${assetId}/days`
  );
  const text = await res.text();
  const map = new Map<string, number>();
  if (!res.ok) {
    recentNavCache.set(assetId, map);
    return map;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    recentNavCache.set(assetId, map);
    return map;
  }
  const data = (body as { data?: unknown[] }).data;
  if (!Array.isArray(data)) {
    recentNavCache.set(assetId, map);
    return map;
  }
  for (const item of data.slice(0, RECENT_DAY_ROWS)) {
    if (!item || typeof item !== "object") continue;
    const attrs = (item as { attributes?: { date?: string; net_asset_value?: number } }).attributes;
    const date = typeof attrs?.date === "string" ? attrs.date : "";
    const nav =
      typeof attrs?.net_asset_value === "number" && Number.isFinite(attrs.net_asset_value)
        ? attrs.net_asset_value
        : NaN;
    if (date && Number.isFinite(nav)) map.set(date, nav);
  }
  recentNavCache.set(assetId, map);
  return map;
}

function priorFundNav(map: Map<string, number>, publishYmd: string): number | null {
  for (let back = 1; back <= 5; back++) {
    const ymd = chileCalendarAddDays(publishYmd, -back);
    const v = map.get(ymd);
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function primaryInvestment(inv: GoalInvestment[] | undefined): GoalInvestment | null {
  if (!inv?.length) return null;
  if (inv.length === 1) return inv[0]!;
  const sorted = [...inv].sort((a, b) => b.weight - a.weight);
  const top = sorted[0]!;
  if (top.weight >= 0.999) return top;
  return null;
}

function accountIdForNotes(notes: string): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as { id: number } | undefined;
  return row?.id ?? null;
}

async function resolveRealAssetsNav(
  email: string,
  token: string,
  row: FintualGoalRowWithMatch,
  publishYmd: string
): Promise<{ navClp: number | null; units: number | null; fundPriceClp: number | null }> {
  const inv = primaryInvestment(row.investments);
  if (!inv || !row.matchedNotes) return { navClp: null, units: null, fundPriceClp: null };

  const lastDay = await fetchRealAssetLastDay(email, token, inv.asset_id);
  if (!lastDay || lastDay.date < publishYmd) return { navClp: null, units: null, fundPriceClp: null };

  const recentNav = await recentNavByDate(email, token, inv.asset_id);
  const publishPrice = recentNav.get(publishYmd) ?? lastDay.netAssetValue;
  if (!Number.isFinite(publishPrice) || publishPrice <= 0) {
    return { navClp: null, units: null, fundPriceClp: null };
  }

  const accountId = accountIdForNotes(row.matchedNotes);
  const units = accountId != null ? fintualGoalUnitsFromMovements(accountId) : null;

  if (units != null && units > 0) {
    return {
      navClp: Math.round(units * publishPrice * 100) / 100,
      units,
      fundPriceClp: publishPrice,
    };
  }

  const priorPrice = priorFundNav(recentNav, publishYmd);
  if (priorPrice == null || priorPrice <= 0) {
    return { navClp: null, units: null, fundPriceClp: publishPrice };
  }
  const impliedUnits = row.navClp / priorPrice;
  if (!Number.isFinite(impliedUnits) || impliedUnits <= 0) {
    return { navClp: null, units: null, fundPriceClp: publishPrice };
  }
  return {
    navClp: Math.round(impliedUnits * publishPrice * 100) / 100,
    units: Math.round(impliedUnits * 1e4) / 1e4,
    fundPriceClp: publishPrice,
  };
}

/**
 * After 18:00 Chile: apply `real_assets` NAV when available; flag mismatch vs goals API.
 */
export async function resolveFintualGoalNavs(
  email: string,
  token: string,
  rows: FintualGoalRowWithMatch[],
  cl: ChileWallClock
): Promise<ResolveFintualGoalNavsResult> {
  const useRealAssets = cl.hour >= 18;
  let hasTodayInSeries = false;
  let latestLastDayDate: string | null = null;

  if (useRealAssets) {
    for (const row of rows) {
      if (!row.matchedNotes) continue;
      const inv = primaryInvestment(row.investments);
      if (!inv) continue;
      const lastDay = await fetchRealAssetLastDay(email, token, inv.asset_id);
      const recentNav = await recentNavByDate(email, token, inv.asset_id);
      if (recentNav.has(cl.ymd)) hasTodayInSeries = true;
      if (lastDay?.date) {
        if (!latestLastDayDate || lastDay.date > latestLastDayDate) {
          latestLastDayDate = lastDay.date;
        }
      }
    }
  }

  const publishYmd = resolveFintualPublishYmd(cl, {
    hasTodayInSeries,
    lastDayDate: latestLastDayDate,
  });

  const out: FintualGoalNavResolution[] = [];

  for (const row of rows) {
    const goalsApiNavClp = row.navClp;
    let realAssetsNavClp: number | null = null;
    let units: number | null = null;
    let fundPriceClp: number | null = null;

    if (useRealAssets) {
      const ra = await resolveRealAssetsNav(email, token, row, publishYmd);
      realAssetsNavClp = ra.navClp;
      units = ra.units;
      fundPriceClp = ra.fundPriceClp;
    }

    const appliedNavClp =
      useRealAssets && realAssetsNavClp != null && Number.isFinite(realAssetsNavClp)
        ? realAssetsNavClp
        : goalsApiNavClp;

    const mismatch =
      useRealAssets &&
      realAssetsNavClp != null &&
      Math.abs(realAssetsNavClp - goalsApiNavClp) > MISMATCH_CLP;

    out.push({
      row: { ...row, navClp: appliedNavClp },
      goalsApiNavClp,
      realAssetsNavClp,
      appliedNavClp,
      units,
      fundPriceClp,
      mismatch,
    });
  }

  return { resolutions: out, publishYmd };
}

export function clearFintualRealAssetNavCaches(): void {
  recentNavCache.clear();
  lastDayCache.clear();
}

export function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}
