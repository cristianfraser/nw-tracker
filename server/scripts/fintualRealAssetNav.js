/**
 * Fintual valuation: prefer `real_assets` fund cuota × DB cuotas; compare to `GET /api/goals` NAV.
 */
import { chileCalendarAddDays } from "../src/chileDate.js";
import { fintualGoalUnitsFromMovements } from "../src/fintualGoalUnits.js";
import { db } from "../src/db.js";
import { FINTUAL_API_BASE, normalizeFintualCookieInput, loadRootDotenv } from "./fintualApiLib.js";
const RECENT_DAY_ROWS = 14;
const MISMATCH_CLP = 1;
const recentNavCache = new Map();
const lastDayCache = new Map();
function authHeaders(email, token) {
    loadRootDotenv();
    const h = {
        Accept: "application/json",
        "User-Agent": "nw-tracker-fintual-scripts/1.0",
        "X-User-Email": email,
        "X-User-Token": token,
    };
    const cookie = process.env.FINTUAL_COOKIE?.trim();
    if (cookie)
        h.Cookie = normalizeFintualCookieInput(cookie);
    return h;
}
async function fetchRealAssetLastDay(email, token, assetId) {
    if (lastDayCache.has(assetId))
        return lastDayCache.get(assetId) ?? null;
    const res = await fetch(`${FINTUAL_API_BASE}/real_assets/${assetId}`, {
        headers: authHeaders(email, token),
    });
    const text = await res.text();
    if (!res.ok) {
        lastDayCache.set(assetId, null);
        return null;
    }
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        lastDayCache.set(assetId, null);
        return null;
    }
    const attrs = body
        .data?.attributes;
    const ld = attrs?.last_day;
    const date = typeof ld?.date === "string" ? ld.date : "";
    const netAssetValue = typeof ld?.net_asset_value === "number" && Number.isFinite(ld.net_asset_value)
        ? ld.net_asset_value
        : NaN;
    const out = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(netAssetValue)
        ? { date, netAssetValue }
        : null;
    lastDayCache.set(assetId, out);
    return out;
}
async function recentNavByDate(email, token, assetId) {
    const cached = recentNavCache.get(assetId);
    if (cached)
        return cached;
    const res = await fetch(`${FINTUAL_API_BASE}/real_assets/${assetId}/days`, {
        headers: authHeaders(email, token),
    });
    const text = await res.text();
    const map = new Map();
    if (!res.ok) {
        recentNavCache.set(assetId, map);
        return map;
    }
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        recentNavCache.set(assetId, map);
        return map;
    }
    const data = body.data;
    if (!Array.isArray(data)) {
        recentNavCache.set(assetId, map);
        return map;
    }
    for (const item of data.slice(0, RECENT_DAY_ROWS)) {
        if (!item || typeof item !== "object")
            continue;
        const attrs = item.attributes;
        const date = typeof attrs?.date === "string" ? attrs.date : "";
        const nav = typeof attrs?.net_asset_value === "number" && Number.isFinite(attrs.net_asset_value)
            ? attrs.net_asset_value
            : NaN;
        if (date && Number.isFinite(nav))
            map.set(date, nav);
    }
    recentNavCache.set(assetId, map);
    return map;
}
function priorFundNav(map, publishYmd) {
    for (let back = 1; back <= 5; back++) {
        const ymd = chileCalendarAddDays(publishYmd, -back);
        const v = map.get(ymd);
        if (v != null && Number.isFinite(v) && v > 0)
            return v;
    }
    return null;
}
function primaryInvestment(inv) {
    if (!inv?.length)
        return null;
    if (inv.length === 1)
        return inv[0];
    const sorted = [...inv].sort((a, b) => b.weight - a.weight);
    const top = sorted[0];
    if (top.weight >= 0.999)
        return top;
    return null;
}
function accountIdForNotes(notes) {
    const row = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(notes);
    return row?.id ?? null;
}
async function resolveRealAssetsNav(email, token, row, publishYmd) {
    const inv = primaryInvestment(row.investments);
    if (!inv || !row.matchedNotes)
        return { navClp: null, units: null, fundPriceClp: null };
    const lastDay = await fetchRealAssetLastDay(email, token, inv.asset_id);
    if (!lastDay || lastDay.date < publishYmd)
        return { navClp: null, units: null, fundPriceClp: null };
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
export async function resolveFintualGoalNavs(email, token, rows, cl) {
    const publishYmd = cl.ymd;
    const useRealAssets = cl.hour >= 18;
    const out = [];
    for (const row of rows) {
        const goalsApiNavClp = row.navClp;
        let realAssetsNavClp = null;
        let units = null;
        let fundPriceClp = null;
        if (useRealAssets) {
            const ra = await resolveRealAssetsNav(email, token, row, publishYmd);
            realAssetsNavClp = ra.navClp;
            units = ra.units;
            fundPriceClp = ra.fundPriceClp;
        }
        const appliedNavClp = useRealAssets && realAssetsNavClp != null && Number.isFinite(realAssetsNavClp)
            ? realAssetsNavClp
            : goalsApiNavClp;
        const mismatch = useRealAssets &&
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
    return out;
}
export function clearFintualRealAssetNavCaches() {
    recentNavCache.clear();
    lastDayCache.clear();
}
export function formatClp(n) {
    return Math.round(n).toLocaleString("es-CL");
}
