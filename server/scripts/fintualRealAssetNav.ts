/**
 * Fintual valuation: the site's own `/gql/` balance graph gives each goal's dated NAV series
 * (`sharesValuationAmount` per `date`); valor cuota = NAV / DB cuotas. This is the fund publish
 * DATE source and is compared to `GET /api/goals` NAV.
 *
 * History: the fund publish date and cuota used to come from `GET /api/real_assets/:id(/days)`
 * (X-User-Token / cookie auth). As of 2026-09-14 those endpoints answer 401 "Bearer token seems
 * to be missing" (moved behind a Bearer-JWT gateway with no drop-in token), so the silent-null
 * fallback dated every NAV to *yesterday*. The `/gql/` endpoint (same session cookie as goals)
 * is what the web app itself uses and carries the correct date.
 */
import type { ChileWallClock } from "../src/chileDate.js";
import { resolveFintualPublishYmd } from "../src/fintualPublishDate.js";
import { fintualGoalUnitsFromMovements } from "../src/fintualGoalUnits.js";
import { matchFintualCertGoalV2 } from "../src/fintualCertV2.js";
import { db } from "../src/db.js";
import {
  FINTUAL_API_BASE,
  fetchFintualWithBackoff,
  fetchFintualGqlDocument,
  normalizeFintualCookieInput,
  loadRootDotenv,
} from "./fintualApiLib.js";
import type { FintualGoalRow } from "./fintualApiLib.js";

export type FintualGoalRowWithMatch = FintualGoalRow & { matchedNotes: string | null };

const MISMATCH_CLP = 1;
/** How many recent days of the balance graph to fetch (covers publish-date + recent backfill). */
const GRAPH_TIME_INTERVAL_CODE = "last_month";

/** Per-goal cached NAV-by-date maps for one poll (cleared by clearFintualRealAssetNavCaches). */
const graphNavByGoalCache = new Map<string, Map<string, number>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FintualGoalNavResolution = {
  row: FintualGoalRowWithMatch;
  goalsApiNavClp: number;
  realAssetsNavClp: number | null;
  appliedNavClp: number;
  units: number | null;
  fundPriceClp: number | null;
  /** Recent published cuotas by day for this goal's fund (backfills days a poll missed). */
  recentNavByDay: Map<string, number> | null;
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

function accountIdForNotes(notes: string): number | null {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(notes) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Which `/gql/` balance query a goal dispatches to, by `goal_type` + `regime`. */
export type GoalBalanceGraphKind = "apv_a" | "apv_b" | "reserve" | "goal";

export function goalBalanceGraphKind(row: FintualGoalRowWithMatch): GoalBalanceGraphKind {
  const type = (row.goalType ?? "").toLowerCase();
  const regime = (row.regime ?? "").toLowerCase();
  if (type === "apv" && regime === "a") return "apv_a";
  if (type === "apv" && regime === "b") return "apv_b";
  if (type === "inbox") return "reserve"; // Reserva goals
  return "goal";
}

/**
 * The site's per-goal-type balance-graph query. `points[].sharesValuationAmount` is the goal's
 * TOTAL valuation (user + state-owned, = `GET /api/goals` nav) on `points[].date`.
 */
export function goalBalanceGraphQuery(kind: GoalBalanceGraphKind): { operationName: string; query: string } {
  const field = {
    apv_a: { root: "clApvAGoalBalanceGraphDataPoints", idArg: "apvAGoalId" },
    apv_b: { root: "clApvBGoalBalanceGraphDataPoints", idArg: "apvBGoalId" },
    reserve: { root: "clReserveBalanceGraphDataPoints", idArg: "reserveId" },
    goal: { root: "clGoalBalanceGraphDataPoints", idArg: "goalId" },
  }[kind];
  const operationName = "NwTrackerGoalBalancePoints";
  const query =
    `query ${operationName}($id: ID!, $timeIntervalCode: String!) {` +
    ` points: ${field.root}(${field.idArg}: $id, timeIntervalCode: $timeIntervalCode) {` +
    ` date sharesValuationAmount } }`;
  return { operationName, query };
}

/** Goal valuation NAV (CLP) by `date` from the `/gql/` balance graph. Empty map on fetch failure. */
async function fetchGoalNavByDate(row: FintualGoalRowWithMatch): Promise<Map<string, number>> {
  const cached = graphNavByGoalCache.get(row.id);
  if (cached) return cached;
  const map = new Map<string, number>();
  const { operationName, query } = goalBalanceGraphQuery(goalBalanceGraphKind(row));
  let data: Record<string, unknown>;
  try {
    data = await fetchFintualGqlDocument(query, { id: row.id, timeIntervalCode: GRAPH_TIME_INTERVAL_CODE }, operationName);
  } catch (e) {
    console.warn(
      `sync: Fintual — balance graph fetch failed for goal ${row.id} (${row.name}): ${e instanceof Error ? e.message : e}`
    );
    graphNavByGoalCache.set(row.id, map);
    return map;
  }
  const points = data.points;
  if (Array.isArray(points)) {
    for (const p of points) {
      if (!p || typeof p !== "object") continue;
      const o = p as { date?: unknown; sharesValuationAmount?: unknown };
      const date = typeof o.date === "string" ? o.date : "";
      const nav =
        typeof o.sharesValuationAmount === "number"
          ? o.sharesValuationAmount
          : Number(o.sharesValuationAmount);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(nav)) map.set(date, Math.round(nav));
    }
  }
  graphNavByGoalCache.set(row.id, map);
  return map;
}

/**
 * Goal NAV + valor cuota for `publishYmd` from the balance graph.
 * - `navClp` = the graph's dated valuation (= goals API nav on the publish day).
 * - `fundPriceClp` = navClp / DB cuotas (valor cuota), null when the goal holds no cuotas.
 * - `recentNavByDay` = date → valor cuota over the fetched window (heals recently-missed days).
 */
function resolveGoalGraphNav(
  row: FintualGoalRowWithMatch,
  publishYmd: string,
  navByDate: Map<string, number> | undefined
): {
  navClp: number | null;
  units: number | null;
  fundPriceClp: number | null;
  recentNavByDay: Map<string, number> | null;
} {
  const nulls = { navClp: null, units: null, fundPriceClp: null, recentNavByDay: null };
  if (!navByDate || navByDate.size === 0 || !row.matchedNotes) return nulls;

  let lastDate: string | null = null;
  for (const d of navByDate.keys()) if (!lastDate || d > lastDate) lastDate = d;
  if (!lastDate || lastDate < publishYmd) return nulls;

  const publishNav = navByDate.get(publishYmd) ?? navByDate.get(lastDate);
  if (publishNav == null || !Number.isFinite(publishNav)) return nulls;

  // valor cuota = NAV / cuotas. The goals-API `matchedNotes` may point at an empty legacy
  // predecessor account; the cuotas live on the v2 cert account (the same account the fund_unit
  // writer uses), so prefer whichever candidate holds a positive position.
  const v2Notes = matchFintualCertGoalV2(row.id, row.name);
  let units: number | null = null;
  for (const notes of [v2Notes, row.matchedNotes]) {
    if (!notes) continue;
    const accountId = accountIdForNotes(notes);
    if (accountId == null) continue;
    const u = fintualGoalUnitsFromMovements(accountId);
    if (u != null && Number.isFinite(u) && u > 0) {
      units = u;
      break;
    }
  }

  // Empty/zero goal (no cuotas): report the NAV so the publish date is set, but no cuota to write.
  if (units == null || !(units > 0) || !(publishNav > 0)) {
    return { navClp: publishNav, units: units ?? null, fundPriceClp: null, recentNavByDay: null };
  }

  const recentNavByDay = new Map<string, number>();
  for (const [d, nav] of navByDate) if (nav > 0) recentNavByDay.set(d, nav / units);
  return { navClp: publishNav, units, fundPriceClp: publishNav / units, recentNavByDay };
}

/**
 * After 18:00 Chile: apply the `/gql/` balance-graph NAV (dated); flag mismatch vs goals API.
 */
export async function resolveFintualGoalNavs(
  _email: string,
  _token: string,
  rows: FintualGoalRowWithMatch[],
  cl: ChileWallClock
): Promise<ResolveFintualGoalNavsResult> {
  const useGraph = cl.hour >= 18;
  let hasTodayInSeries = false;
  let latestLastDayDate: string | null = null;
  const navByGoal = new Map<string, Map<string, number>>();

  if (useGraph) {
    for (const row of rows) {
      if (!row.matchedNotes) continue;
      const navByDate = await fetchGoalNavByDate(row);
      navByGoal.set(row.id, navByDate);
      for (const d of navByDate.keys()) {
        if (d === cl.ymd) hasTodayInSeries = true;
        if (!latestLastDayDate || d > latestLastDayDate) latestLastDayDate = d;
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
    let recentNavByDay: Map<string, number> | null = null;

    if (useGraph && row.matchedNotes) {
      const g = resolveGoalGraphNav(row, publishYmd, navByGoal.get(row.id));
      realAssetsNavClp = g.navClp;
      units = g.units;
      fundPriceClp = g.fundPriceClp;
      recentNavByDay = g.recentNavByDay;
    }

    const appliedNavClp =
      useGraph && realAssetsNavClp != null && Number.isFinite(realAssetsNavClp)
        ? realAssetsNavClp
        : goalsApiNavClp;

    const mismatch =
      useGraph &&
      realAssetsNavClp != null &&
      Math.abs(realAssetsNavClp - goalsApiNavClp) > MISMATCH_CLP;

    out.push({
      row: { ...row, navClp: appliedNavClp },
      goalsApiNavClp,
      realAssetsNavClp,
      appliedNavClp,
      units,
      fundPriceClp,
      recentNavByDay,
      mismatch,
    });
  }

  return { resolutions: out, publishYmd };
}

export function clearFintualRealAssetNavCaches(): void {
  graphNavByGoalCache.clear();
}

export function formatClp(n: number): string {
  return Math.round(n).toLocaleString("es-CL");
}
