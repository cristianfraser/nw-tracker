/**
 * Orchestrates external syncs with Chile-time rules:
 * - AFP UNO spot: once per Chile calendar day (00:00 rollover).
 * - Fintual goals: from 18:00 America/Santiago; applies when mapped NAV signature changes (poll alone
 *   does not clear stale). Valuations use prior calendar day as `as_of_date` until Fintual publishes.
 * - USD / EUR (SBIF dólar & euro observado): daily incremental fetch on every run.
 * - SPY / VEA / BTC / ETH EOD: Yahoo daily bars after NYSE close (16:05 ET); crypto daily every run.
 * - UF / UTM / IPC (SBIF API): from the 9th of each month through month-end, incremental fetch
 *   ([UF posteriores](https://api.sbif.cl/documentacion/UF.html), same pattern for UTM/IPC).
 *
 * Env: `SBIF_APIKEY`, Fintual vars (see `fintualApiLib.ts`), AFP account `import:excel|key=afp`.
 *
 * Usage (repo root):
 *   npm run sync:all -w nw-tracker-server
 *   npm run sync:all -w nw-tracker-server -- --dry-run
 *   npm run sync:all -w nw-tracker-server -- --force-sbif
 *   npm run sync:all -w nw-tracker-server -- --force
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { db } from "../src/db.js";
import { isEquityEodStale, isSbifMonthlyStale, staleSyncSources } from "../src/globalSyncStale.js";
import { formatSyncClp, formatSyncFxRate, formatSyncUsdClose, insertSyncRunLog, formatSyncUfRate, } from "../src/syncRunLog.js";
import { loadGlobalSyncState, saveGlobalSyncState, } from "../src/globalSyncState.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { fetchUnoClFondoAValorCuota } from "../src/afpUnoWebsiteCuota.js";
import { upsertFundUnitDailyRow, upsertAfpSpotValuationWithExplicitPx, ensureAfpUnoQuetalmiRecentHistory, } from "../src/afpUnoValuation.js";
import { fillFundUnitDailyCalendarGap, latestFundUnitRow } from "../src/fundUnitDaily.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "../src/afpQuetalmiApi.js";
import { fetchFintualGoalsRaw, getValidFintualSession, loadGoalIdOverrides, loadRootDotenv, matchGoalToImportNotes, parseGoalsFromResponse, writeGoalsSnapshot, } from "./fintualApiLib.js";
import { applyFintualGoalsSnapshotToDb, collectFintualGoalValuationChanges, cleanupMistakenPollDayFintualValuations, fintualEveningCatchUpComplete, fintualMappedNavSignature, fintualNavUnchangedSinceLastApply, fintualSnapshotMatchesDb, markFintualEveningSettledWhenCurrent, pickFintualApplySnapshot, syncFintualFundUnitsFromResolutions, } from "./fintualApplyShared.js";
import { clearFintualRealAssetNavCaches, formatClp, resolveFintualGoalNavs, } from "./fintualRealAssetNav.js";
import { fetchDolarAfterDate, fetchEuroAfterDate, fetchIpcAfterMonth, fetchUfAfterDate, fetchUtmAfterMonth, } from "../src/sbifApi.js";
import { maxEurDate, maxFxDate, maxUfDate, safeMaxIpcMonthParts, safeMaxUtmMonthParts, upsertEurRows, upsertFxRows, upsertIpcRows, upsertUfRows, upsertUtmRows, } from "../src/sbifSyncDb.js";
import { EQUITY_DAILY_IMPORT_TICKERS, } from "../src/brokerageEquityMtm.js";
import { equityEodSyncSessionLabel, syncEquityEodFromYahoo } from "../src/equityEodSync.js";
let syncDryRun = process.argv.includes("--dry-run");
const FORCE_SBIF = process.argv.includes("--force-sbif");
const FORCE = process.argv.includes("--force");
const STRICT_FINTUAL = process.argv.includes("--strict-fintual");
function monthBeforeCalendar(y, m) {
    if (m <= 1)
        return { y: y - 1, m: 12 };
    return { y, m: m - 1 };
}
function parseYmdParts(ymd) {
    const [ys, ms] = ymd.split("-");
    return { y: parseInt(ys, 10), m: parseInt(ms, 10) };
}
function latestEquityEodRow(ticker) {
    const row = db
        .prepare(`SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`)
        .get(ticker);
    if (row?.close_usd == null || !Number.isFinite(row.close_usd))
        return null;
    return { trade_date: row.trade_date, close_usd: row.close_usd };
}
function latestEquityCloseUsd(ticker) {
    return latestEquityEodRow(ticker)?.close_usd ?? null;
}
function fxClpPerUsdAt(date) {
    const row = db
        .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`)
        .get(date);
    const v = row?.clp_per_usd;
    return v != null && Number.isFinite(v) ? v : null;
}
function ufClpAt(date) {
    const row = db
        .prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`)
        .get(date);
    const v = row?.clp_per_uf;
    return v != null && Number.isFinite(v) ? v : null;
}
function fxClpPerUsdOnOrBefore(date) {
    const row = db
        .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
        .get(date);
    const v = row?.clp_per_usd;
    return v != null && Number.isFinite(v) ? v : null;
}
async function runUnoSpot(cl, state, changes) {
    if (!FORCE && state.unoLastSpotYmd === cl.ymd) {
        console.log("sync: AFP UNO — skip (already ran today Chile).");
        return;
    }
    const row = db
        .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=afp'`)
        .get();
    if (!row) {
        console.warn("sync: AFP UNO — no account notes=import:excel|key=afp");
        return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 45_000);
    let parsed;
    try {
        parsed = await fetchUnoClFondoAValorCuota({ signal: ac.signal });
    }
    finally {
        clearTimeout(t);
    }
    const asOf = cl.ymd;
    const fundUnitDay = parsed.quote_day_ymd ?? asOf;
    const px = parsed.unit_value_clp;
    const prevVal = db
        .prepare(`SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`)
        .get(row.id, asOf);
    const anchorDay = state.afpLastUnitDay;
    const anchorPx = state.afpLastUnitClp;
    if (anchorDay &&
        anchorPx != null &&
        Number.isFinite(anchorPx) &&
        anchorPx > 0 &&
        anchorDay < fundUnitDay &&
        Math.abs(anchorPx - px) > 0.005) {
        const fromDb = latestFundUnitRow(AFP_UNO_CUOTA_SERIES_KEY);
        const gapFrom = fromDb && fromDb.day < anchorDay ? fromDb.day : anchorDay;
        const filled = fillFundUnitDailyCalendarGap({
            seriesKey: AFP_UNO_CUOTA_SERIES_KEY,
            fromDayExclusive: gapFrom,
            toDayExclusive: fundUnitDay,
            unitValueClp: anchorPx,
            note: "afp:state-carry-forward",
            dryRun: syncDryRun,
        });
        if (filled > 0) {
            console.log(`sync: AFP UNO — filled ${filled} day(s) with prior px=${anchorPx} before ${fundUnitDay}`);
        }
    }
    const { gapDaysFilled } = upsertFundUnitDailyRow({
        day: fundUnitDay,
        unit_value_clp: px,
        note: `uno.cl:homepage|Fondo-A|${parsed.raw_price_fragment}|sync:all`,
        dryRun: syncDryRun,
    });
    const marked = upsertAfpSpotValuationWithExplicitPx({
        accountId: row.id,
        asOfYmd: asOf,
        px,
        dryRun: syncDryRun,
    });
    const prevRounded = prevVal?.value_clp != null && Number.isFinite(prevVal.value_clp)
        ? Math.round(prevVal.value_clp)
        : null;
    const nextRounded = marked?.value_clp != null && Number.isFinite(marked.value_clp)
        ? Math.round(marked.value_clp)
        : null;
    if (nextRounded != null &&
        (prevRounded == null || Math.abs(prevRounded - nextRounded) > 1)) {
        changes.push({
            group: "afp",
            label: "AFP UNO",
            oldValue: prevRounded != null ? formatSyncClp(prevRounded) : "—",
            newValue: formatSyncClp(nextRounded),
            oldDate: asOf,
            newDate: asOf,
        });
    }
    if (!syncDryRun) {
        state.unoLastSpotYmd = cl.ymd;
        state.afpLastUnitDay = fundUnitDay;
        state.afpLastUnitClp = px;
    }
    console.log(`sync: AFP UNO — spot px=${px} fund_unit_day=${fundUnitDay} gap_filled=${gapDaysFilled} (${syncDryRun ? "dry-run" : "ok"})`);
    const qKey = process.env.QUETALMIAFP_APIKEY?.trim() ?? "";
    if (qKey) {
        try {
            await ensureAfpUnoQuetalmiRecentHistory({ apiKey: qKey, dryRun: syncDryRun });
        }
        catch (e) {
            console.warn(`sync: AFP UNO — Quetalmi backfill skipped: ${e instanceof Error ? e.message : e}`);
        }
    }
}
async function runFintual(cl, state, changes) {
    if (cl.hour < 18) {
        console.log(`sync: Fintual — skip (before 18:00 Chile; now ${cl.hour}:${String(cl.minute).padStart(2, "0")}).`);
        return { pending: false };
    }
    let session;
    try {
        session = await getValidFintualSession();
    }
    catch (e) {
        console.warn(`sync: Fintual — auth failed: ${e instanceof Error ? e.message : e}`);
        return { pending: false };
    }
    const raw = await fetchFintualGoalsRaw(session.email, session.token);
    const rows = parseGoalsFromResponse(raw);
    const overrides = loadGoalIdOverrides();
    const rowsWithMatch = rows.map((g) => ({
        ...g,
        matchedNotes: matchGoalToImportNotes(g.id, g.name, overrides),
    }));
    let resolutions;
    try {
        resolutions = await resolveFintualGoalNavs(session.email, session.token, rowsWithMatch, cl);
    }
    finally {
        clearFintualRealAssetNavCaches();
    }
    for (const r of resolutions) {
        if (!r.mismatch || !r.row.matchedNotes || r.realAssetsNavClp == null)
            continue;
        const unitLine = r.units != null ? ` · cuotas ${r.units.toLocaleString("es-CL", { maximumFractionDigits: 4 })}` : "";
        const priceLine = r.fundPriceClp != null ? ` · valor cuota $${formatClp(r.fundPriceClp)}` : "";
        console.log(`sync: Fintual — ${r.row.name}: goals API $${formatClp(r.goalsApiNavClp)} vs real_assets $${formatClp(r.realAssetsNavClp)}${unitLine}${priceLine}`);
    }
    const appliedRows = resolutions.map((r) => r.row);
    const picked = pickFintualApplySnapshot(appliedRows, overrides, cl, state);
    const snap = picked.snap;
    writeGoalsSnapshot(snap);
    const sig = fintualMappedNavSignature(snap);
    state.fintualLastCheckYmd = cl.ymd;
    state.fintualLastCheckSig = sig;
    const anyMapped = snap.goals.some((g) => g.matchedNotes);
    if (fintualNavUnchangedSinceLastApply(sig, state)) {
        if (fintualSnapshotMatchesDb(snap)) {
            const cleaned = cleanupMistakenPollDayFintualValuations(snap, syncDryRun);
            if (cleaned > 0) {
                console.log(`sync: Fintual — removed ${cleaned} mistaken post–as_of valuation row(s).`);
            }
            markFintualEveningSettledWhenCurrent(state, cl, snap, syncDryRun);
        }
        console.log("sync: Fintual — API NAV unchanged since last apply; skip DB write (valuations already current).");
        if (STRICT_FINTUAL) {
            const hasMapped = snap.goals.some((g) => g.matchedNotes);
            if (hasMapped) {
                throw new Error("--strict-fintual: no valuation update applied");
            }
        }
        return {
            pending: true,
            fintualNoChange: anyMapped,
        };
    }
    syncFintualFundUnitsFromResolutions(resolutions, snap.asOfDate, syncDryRun);
    if (fintualSnapshotMatchesDb(snap)) {
        const fintualLogChanges = collectFintualGoalValuationChanges(snap);
        changes.push(...fintualLogChanges);
        const cleaned = cleanupMistakenPollDayFintualValuations(snap, syncDryRun);
        if (cleaned > 0) {
            console.log(`sync: Fintual — removed ${cleaned} mistaken post–as_of valuation row(s).`);
        }
        markFintualEveningSettledWhenCurrent(state, cl, snap, syncDryRun);
        if (!syncDryRun && fintualEveningCatchUpComplete(rows, overrides, cl)) {
            state.fintualEveningSettledYmd = cl.ymd;
        }
        console.log("sync: Fintual — valuations already match API; no DB update needed.");
        if (STRICT_FINTUAL) {
            const hasMapped = snap.goals.some((g) => g.matchedNotes);
            if (hasMapped) {
                throw new Error("--strict-fintual: no valuation update applied");
            }
        }
        return {
            pending: true,
            fintualNoChange: anyMapped && fintualLogChanges.length === 0,
        };
    }
    const { applied, skipped, changes: fintualChanges } = applyFintualGoalsSnapshotToDb(snap, syncDryRun);
    changes.push(...fintualChanges);
    if (!syncDryRun) {
        state.fintualLastAppliedYmd = cl.ymd;
        state.fintualLastAppliedSig = sig;
        markFintualEveningSettledWhenCurrent(state, cl, snap, syncDryRun);
        if (fintualEveningCatchUpComplete(rows, overrides, cl)) {
            state.fintualEveningSettledYmd = cl.ymd;
        }
    }
    console.log(`sync: Fintual — applied ${applied}, skipped ${skipped} for as_of=${snap.asOfDate} (${syncDryRun ? "dry-run" : "ok"})`);
    return {
        pending: false,
        fintualNoChange: anyMapped && fintualChanges.length === 0,
    };
}
function isSbifNoDataError(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes("404") || msg.includes("No hay datos");
}
async function runSbifUsd(apiKey, changes) {
    const anchor = portfolioStartYmd();
    const lastFx = maxFxDate() ?? anchor;
    const prevUsdClp = fxClpPerUsdAt(lastFx) ?? fxClpPerUsdOnOrBefore(lastFx);
    let fxRows = [];
    try {
        fxRows = await fetchDolarAfterDate(lastFx, apiKey);
    }
    catch (e) {
        if (isSbifNoDataError(e)) {
            console.warn(`sync: SBIF USD — no newer series after ${lastFx} (ok if current).`);
        }
        else
            throw e;
    }
    const fxN = upsertFxRows(fxRows.filter((r) => r.date >= anchor), syncDryRun);
    if (fxN > 0) {
        const newest = fxRows[fxRows.length - 1];
        const newUsdClp = newest?.clpPerUsd ?? fxClpPerUsdOnOrBefore(newest?.date ?? lastFx);
        if (newUsdClp != null) {
            changes.push({
                group: "sbif_usd",
                label: "SBIF USD",
                oldValue: prevUsdClp != null ? formatSyncFxRate(prevUsdClp) : "—",
                newValue: formatSyncFxRate(newUsdClp),
                oldDate: lastFx,
                newDate: newest?.date ?? lastFx,
            });
        }
    }
    console.log(`sync: SBIF USD — ${fxN} row(s) after ${lastFx} (${syncDryRun ? "dry-run" : "ok"})`);
}
/** [SBIF euro observado](https://api.sbif.cl/documentacion/Euro.html) — `euro/posteriores/.../dias/...` */
async function runSbifEur(apiKey, changes) {
    const anchor = portfolioStartYmd();
    const lastEur = maxEurDate() ?? anchor;
    const prevEurClp = db
        .prepare(`SELECT clp_per_eur FROM eur_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
        .get(lastEur);
    let eurRows = [];
    try {
        eurRows = await fetchEuroAfterDate(lastEur, apiKey);
    }
    catch (e) {
        if (isSbifNoDataError(e)) {
            console.warn(`sync: SBIF EUR — no newer series after ${lastEur} (ok if current).`);
        }
        else
            throw e;
    }
    const eurN = upsertEurRows(eurRows.filter((r) => r.date >= anchor), syncDryRun);
    if (eurN > 0) {
        const newest = eurRows[eurRows.length - 1];
        const newEurClp = newest?.clpPerEur;
        const prevEur = prevEurClp?.clp_per_eur != null && Number.isFinite(prevEurClp.clp_per_eur)
            ? prevEurClp.clp_per_eur
            : null;
        if (newEurClp != null && Number.isFinite(newEurClp)) {
            changes.push({
                group: "sbif_eur",
                label: "SBIF EUR",
                oldValue: prevEur != null ? formatSyncFxRate(prevEur) : "—",
                newValue: formatSyncFxRate(newEurClp),
                oldDate: lastEur,
                newDate: newest?.date ?? lastEur,
            });
        }
    }
    console.log(`sync: SBIF EUR — ${eurN} row(s) after ${lastEur} (${syncDryRun ? "dry-run" : "ok"})`);
}
function syncErrorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
async function runSyncStep(step, errors, fn) {
    try {
        await fn();
    }
    catch (e) {
        const message = syncErrorMessage(e);
        console.error(`sync: ${step} — error: ${message}`);
        errors.push({ step, message });
    }
}
async function runEquityEod(state, changes) {
    if (!FORCE && !isEquityEodStale(state, { force: false })) {
        console.log("sync: equity EOD — skip (NYSE session + crypto UTC day already synced).");
        return;
    }
    const eodBefore = new Map();
    for (const ticker of EQUITY_DAILY_IMPORT_TICKERS) {
        eodBefore.set(ticker, latestEquityEodRow(ticker));
    }
    const results = await syncEquityEodFromYahoo(undefined, {
        dryRun: syncDryRun,
        force: FORCE,
    });
    for (const r of results) {
        if (r.skipped) {
            console.log(`sync: equity EOD ${r.ticker} — skip (${r.skipped})`);
            continue;
        }
        console.log(`sync: equity EOD ${r.ticker} — ${r.rows} row(s) (${syncDryRun ? "dry-run" : "ok"})`);
        const before = eodBefore.get(r.ticker) ?? null;
        const after = latestEquityEodRow(r.ticker);
        if (after == null)
            continue;
        if (before != null && Math.abs(before.close_usd - after.close_usd) < 1e-8)
            continue;
        changes.push({
            group: "tickers",
            label: r.ticker,
            oldValue: before != null ? formatSyncUsdClose(before.close_usd) : "—",
            newValue: formatSyncUsdClose(after.close_usd),
            oldDate: before?.trade_date ?? null,
            newDate: after.trade_date,
        });
    }
    if (!syncDryRun) {
        const labels = equityEodSyncSessionLabel();
        if (labels.nyseSession)
            state.equityEodLastNySessionYmd = labels.nyseSession;
        state.equityEodLastCryptoUtcYmd = labels.cryptoUtcDay;
    }
}
async function runSbifUf(cl, apiKey, state, changes) {
    if (!isSbifMonthlyStale(cl, state.sbifUfMonth, { forceSbif: FORCE_SBIF })) {
        console.log("sync: SBIF UF — skip (monthly window or already synced this month).");
        return;
    }
    const last = maxUfDate() ?? portfolioStartYmd();
    let rows = [];
    try {
        rows = await fetchUfAfterDate(last, apiKey);
    }
    catch (e) {
        if (isSbifNoDataError(e)) {
            console.warn(`sync: SBIF UF — no newer series after ${last} (ok if already current).`);
        }
        else
            throw e;
    }
    const n = upsertUfRows(rows.map((r) => ({ date: r.date, clpPerUf: r.clpPerUf })), syncDryRun);
    if (n > 0) {
        const newest = rows[rows.length - 1];
        const newDate = newest?.date ?? last;
        const oldUf = ufClpAt(last);
        const newUf = newest ? ufClpAt(newDate) : null;
        if (newUf != null) {
            changes.push({
                group: "sbif_uf",
                label: "SBIF UF",
                oldValue: oldUf != null ? formatSyncUfRate(oldUf) : "—",
                newValue: formatSyncUfRate(newUf),
                oldDate: last,
                newDate,
            });
        }
    }
    if (!syncDryRun)
        state.sbifUfMonth = cl.monthKey;
    console.log(`sync: SBIF UF — ${n} row(s) after ${last} (${syncDryRun ? "dry-run" : "ok"})`);
}
async function runSbifUtm(cl, apiKey, state, changes) {
    if (!isSbifMonthlyStale(cl, state.sbifUtmMonth, { forceSbif: FORCE_SBIF })) {
        console.log("sync: SBIF UTM — skip (monthly window or already synced this month).");
        return;
    }
    const lastParts = safeMaxUtmMonthParts();
    const start = portfolioStartYmd();
    const anchor = lastParts ?? monthBeforeCalendar(parseYmdParts(start).y, parseYmdParts(start).m);
    let rows = [];
    try {
        rows = await fetchUtmAfterMonth(anchor.y, anchor.m, apiKey);
    }
    catch (e) {
        if (isSbifNoDataError(e)) {
            console.warn(`sync: SBIF UTM — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
        }
        else
            throw e;
    }
    const n = upsertUtmRows(rows, syncDryRun);
    if (n > 0) {
        const newest = rows[rows.length - 1];
        const oldLabel = `${anchor.y}-${String(anchor.m).padStart(2, "0")}`;
        changes.push({
            group: "sbif_utm",
            label: "SBIF UTM",
            oldValue: "—",
            newValue: newest ? String(Math.round(newest.utmClp)) : `+${n}`,
            oldDate: null,
            newDate: newest?.date?.slice(0, 10) ?? null,
        });
    }
    if (!syncDryRun)
        state.sbifUtmMonth = cl.monthKey;
    console.log(`sync: SBIF UTM — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}
async function runSbifIpc(cl, apiKey, state, changes) {
    if (!isSbifMonthlyStale(cl, state.sbifIpcMonth, { forceSbif: FORCE_SBIF })) {
        console.log("sync: SBIF IPC — skip (monthly window or already synced this month).");
        return;
    }
    const lastParts = safeMaxIpcMonthParts();
    const start = portfolioStartYmd();
    const sp = parseYmdParts(start);
    const anchor = lastParts ?? monthBeforeCalendar(sp.y, sp.m);
    let rows = [];
    try {
        rows = await fetchIpcAfterMonth(anchor.y, anchor.m, apiKey);
    }
    catch (e) {
        if (isSbifNoDataError(e)) {
            console.warn(`sync: SBIF IPC — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
        }
        else
            throw e;
    }
    const n = upsertIpcRows(rows, syncDryRun);
    if (n > 0) {
        const newest = rows[rows.length - 1];
        changes.push({
            group: "sbif_ipc",
            label: "SBIF IPC",
            oldValue: "—",
            newValue: newest ? String(newest.ipcIndex) : `+${n}`,
            oldDate: null,
            newDate: newest?.date?.slice(0, 10) ?? null,
        });
    }
    if (!syncDryRun)
        state.sbifIpcMonth = cl.monthKey;
    console.log(`sync: SBIF IPC — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}
/** Run all external syncs. Returns exit code 0 on success, 1 if any step failed. */
export async function runGlobalSyncAll(opts) {
    syncDryRun = opts?.dryRun ?? process.argv.includes("--dry-run");
    const syncChanges = [];
    const stepErrors = [];
    const logOpts = {};
    let stale = [];
    let state = null;
    let cl = chileWallClockNow();
    try {
        loadRootDotenv();
        cl = chileWallClockNow();
        state = loadGlobalSyncState();
        stale = staleSyncSources(cl, state, { force: FORCE, forceSbif: FORCE_SBIF });
        console.log(`sync:all — Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")} (${syncDryRun ? "dry-run" : "live"})` +
            (stale.length ? ` stale=[${stale.join(", ")}]` : " nothing stale"));
        await runSyncStep("AFP UNO", stepErrors, async () => {
            await runUnoSpot(cl, state, syncChanges);
        });
        await runSyncStep("Fintual", stepErrors, async () => {
            const fintualResult = await runFintual(cl, state, syncChanges);
            if (fintualResult.fintualNoChange)
                logOpts.fintualNoChange = true;
        });
        const apiKey = process.env.SBIF_APIKEY?.trim() ?? "";
        if (!apiKey) {
            console.warn("sync: SBIF — skip (set SBIF_APIKEY in .env).");
        }
        else {
            await runSyncStep("Equity EOD", stepErrors, async () => {
                await runEquityEod(state, syncChanges);
            });
            await runSyncStep("SBIF USD", stepErrors, async () => {
                await runSbifUsd(apiKey, syncChanges);
            });
            await runSyncStep("SBIF EUR", stepErrors, async () => {
                await runSbifEur(apiKey, syncChanges);
            });
            if (cl.day < 9 && !FORCE_SBIF) {
                console.log("sync: SBIF — skip UF/UTM/IPC (before day 9; CMF UF series often incomplete earlier — use --force-sbif to override).");
            }
            else {
                await runSyncStep("SBIF UF", stepErrors, async () => {
                    await runSbifUf(cl, apiKey, state, syncChanges);
                });
                await runSyncStep("SBIF UTM", stepErrors, async () => {
                    await runSbifUtm(cl, apiKey, state, syncChanges);
                });
                await runSyncStep("SBIF IPC", stepErrors, async () => {
                    await runSbifIpc(cl, apiKey, state, syncChanges);
                });
            }
        }
    }
    catch (e) {
        const message = syncErrorMessage(e);
        console.error(`sync:all — fatal: ${message}`);
        stepErrors.push({ step: "sync:all", message });
    }
    finally {
        if (state) {
            stale = staleSyncSources(cl, state, { force: FORCE, forceSbif: FORCE_SBIF });
        }
        insertSyncRunLog(stale, syncChanges, syncDryRun, { ...logOpts, errors: stepErrors });
        if (!syncDryRun && state)
            saveGlobalSyncState(state);
        if (stepErrors.length > 0) {
            console.log(`sync:all — done with ${stepErrors.length} error(s).`);
            return 1;
        }
        console.log("sync:all — done.");
        return 0;
    }
}
const isCli = typeof process.argv[1] === "string" &&
    (process.argv[1].endsWith("global-sync.ts") || process.argv[1].endsWith("global-sync.js"));
if (isCli) {
    void runGlobalSyncAll().then((code) => process.exit(code));
}
