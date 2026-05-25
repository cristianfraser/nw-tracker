/**
 * Orchestrates external syncs with Chile-time rules:
 * - AFP UNO spot: once per Chile business day (skipped on weekends / `CHILE_CLOSED_YMD` holidays).
 * - Fintual goals: from 18:00 America/Santiago on business days only; `as_of` is the fund publish date
 *   (may be the prior day after a holiday cuota or before today's cuota is on `/days`).
 * - USD / EUR (Banco Central BDE): stale from 18:00 Chile until today's observado is in DB (prior session on holidays).
 * - SPY / VEA / BTC / ETH EOD: Yahoo daily bars after NYSE close (16:05 ET); crypto daily every run.
 * - UF / UTM / IPC (BDE GetSeries): from the 9th of each month when stale.
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD`, Fintual vars (see `fintualApiLib.ts`), AFP account.
 *
 * Usage (repo root):
 *   npm run sync:all -w nw-tracker-server
 *   npm run sync:all -w nw-tracker-server -- --dry-run
 *   npm run sync:all -w nw-tracker-server -- --force-sbif
 *   npm run sync:all -w nw-tracker-server -- --force
 */
import "./db.js";
import { chileWallClockNow, type ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import {
  clearUserForcedStale,
  isEquityEodStale,
  isSbifMonthlyStale,
  shouldRunSyncSource,
  staleSyncSources,
  type GlobalSyncSource,
} from "./globalSyncStale.js";
import { isChileBusinessDay } from "./marketHolidays.js";
import { isFintualFundPublishDay } from "./fintualPublishDate.js";
import {
  formatSyncClp,
  formatSyncFxRate,
  formatSyncUsdClose,
  insertSyncRunLog,
  formatSyncUfRate,
  type SyncFieldChange,
  type SyncRunLogOptions,
  type SyncStepError,
  type SyncStepNote,
} from "./syncRunLog.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "./globalSyncState.js";
import { portfolioStartYmd } from "./portfolioStart.js";
import { fetchUnoClFondoAValorCuota } from "./afpUnoWebsiteCuota.js";
import {
  upsertFundUnitDailyRow,
  upsertAfpSpotValuationWithExplicitPx,
  ensureAfpUnoQuetalmiRecentHistory,
} from "./afpUnoValuation.js";
import { fillFundUnitDailyCalendarGap, latestFundUnitRow } from "./fundUnitDaily.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  fetchFintualGoalsRaw,
  getValidFintualSession,
  loadGoalIdOverrides,
  loadRootDotenv,
  matchGoalToImportNotes,
  parseGoalsFromResponse,
  writeGoalsSnapshot,
} from "../scripts/fintualApiLib.js";
import {
  applyFintualGoalsSnapshotToDb,
  collectFintualGoalValuationChanges,
  cleanupMistakenPollDayFintualValuations,
  fintualEveningCatchUpComplete,
  fintualMappedNavSignature,
  fintualNavUnchangedSinceLastApply,
  fintualSnapshotMatchesDb,
  markFintualEveningSettledWhenCurrent,
  pickFintualApplySnapshot,
  syncFintualFundUnitsFromResolutions,
} from "../scripts/fintualApplyShared.js";
import {
  clearFintualRealAssetNavCaches,
  formatClp,
  resolveFintualGoalNavs,
} from "../scripts/fintualRealAssetNav.js";
import {
  fetchDolarAfterDate,
  fetchEuroAfterDate,
  fetchIpcAfterMonth,
  fetchUfAfterDate,
  fetchUtmAfterMonth,
  isBcentralNoDataError,
  loadBcentralCredentials,
  type BcentralCredentials,
} from "./bcentralApi.js";
import { isSbifApiInBackoff, sbifApiBackoffRemainingMs } from "./sbifApiGate.js";
import {
  maxEurDateOnOrBefore,
  maxFxDateOnOrBefore,
  maxUfDate,
  safeMaxIpcMonthParts,
  safeMaxUtmMonthParts,
  upsertEurRows,
  upsertFxRows,
  upsertIpcRows,
  upsertUfRows,
  upsertUtmRows,
} from "./sbifSyncDb.js";
import { EQUITY_DAILY_IMPORT_TICKERS } from "./brokerageEquityMtm.js";
import { equityEodSyncSessionLabel, syncEquityEodFromYahoo } from "./equityEodSync.js";
let syncDryRun = process.argv.includes("--dry-run");
const FORCE_SBIF = process.argv.includes("--force-sbif");
const FORCE = process.argv.includes("--force");
const STRICT_FINTUAL = process.argv.includes("--strict-fintual");

function monthBeforeCalendar(y: number, m: number): { y: number; m: number } {
  if (m <= 1) return { y: y - 1, m: 12 };
  return { y, m: m - 1 };
}

function parseYmdParts(ymd: string): { y: number; m: number } {
  const [ys, ms] = ymd.split("-");
  return { y: parseInt(ys!, 10), m: parseInt(ms!, 10) };
}

function latestEquityEodRow(
  ticker: string
): { trade_date: string; close_usd: number } | null {
  const row = db
    .prepare(
      `SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? ORDER BY trade_date DESC LIMIT 1`
    )
    .get(ticker) as { trade_date: string; close_usd: number } | undefined;
  if (row?.close_usd == null || !Number.isFinite(row.close_usd)) return null;
  return { trade_date: row.trade_date, close_usd: row.close_usd };
}

function latestEquityCloseUsd(ticker: string): number | null {
  return latestEquityEodRow(ticker)?.close_usd ?? null;
}

function fxClpPerUsdAt(date: string): number | null {
  const row = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`)
    .get(date) as { clp_per_usd: number } | undefined;
  const v = row?.clp_per_usd;
  return v != null && Number.isFinite(v) ? v : null;
}

function ufClpAt(date: string): number | null {
  const row = db
    .prepare(`SELECT clp_per_uf FROM uf_daily WHERE date = ?`)
    .get(date) as { clp_per_uf: number } | undefined;
  const v = row?.clp_per_uf;
  return v != null && Number.isFinite(v) ? v : null;
}

function fxClpPerUsdOnOrBefore(date: string): number | null {
  const row = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(date) as { clp_per_usd: number } | undefined;
  const v = row?.clp_per_usd;
  return v != null && Number.isFinite(v) ? v : null;
}

function eurClpPerEurAt(date: string): number | null {
  const row = db
    .prepare(`SELECT clp_per_eur FROM eur_daily WHERE date = ?`)
    .get(date) as { clp_per_eur: number } | undefined;
  const v = row?.clp_per_eur;
  return v != null && Number.isFinite(v) ? v : null;
}

function eurClpPerEurOnOrBefore(date: string): number | null {
  const row = db
    .prepare(`SELECT clp_per_eur FROM eur_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(date) as { clp_per_eur: number } | undefined;
  const v = row?.clp_per_eur;
  return v != null && Number.isFinite(v) ? v : null;
}

function maxFxDateAfterUpsert(cl: ChileWallClock): string | null {
  return maxFxDateOnOrBefore(cl.ymd);
}

function maxEurDateAfterUpsert(cl: ChileWallClock): string | null {
  return maxEurDateOnOrBefore(cl.ymd);
}

async function runUnoSpot(
  cl: ReturnType<typeof chileWallClockNow>,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!FORCE && !isChileBusinessDay(cl.ymd)) {
    console.log(`sync: AFP UNO — skip (Chile non-business day ${cl.ymd}).`);
    return;
  }
  if (!FORCE && state.unoLastSpotYmd === cl.ymd) {
    console.log("sync: AFP UNO — skip (already ran today Chile).");
    return;
  }
  const row = db
    .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=afp'`)
    .get() as { id: number } | undefined;
  if (!row) {
    console.warn("sync: AFP UNO — no account notes=import:excel|key=afp");
    return;
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  let parsed;
  try {
    parsed = await fetchUnoClFondoAValorCuota({ signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
  const asOf = cl.ymd;
  const fundUnitDay = parsed.quote_day_ymd ?? asOf;
  const px = parsed.unit_value_clp;

  const prevVal = db
    .prepare(`SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`)
    .get(row.id, asOf) as { value_clp: number } | undefined;

  const anchorDay = state.afpLastUnitDay;
  const anchorPx = state.afpLastUnitClp;
  if (
    anchorDay &&
    anchorPx != null &&
    Number.isFinite(anchorPx) &&
    anchorPx > 0 &&
    anchorDay < fundUnitDay &&
    Math.abs(anchorPx - px) > 0.005
  ) {
    const fromDb = latestFundUnitRow(AFP_UNO_CUOTA_SERIES_KEY);
    const gapFrom =
      fromDb && fromDb.day < anchorDay ? fromDb.day : anchorDay;
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
  const prevRounded =
    prevVal?.value_clp != null && Number.isFinite(prevVal.value_clp)
      ? Math.round(prevVal.value_clp)
      : null;
  const nextRounded =
    marked?.value_clp != null && Number.isFinite(marked.value_clp)
      ? Math.round(marked.value_clp)
      : null;
  if (
    nextRounded != null &&
    (prevRounded == null || Math.abs(prevRounded - nextRounded) > 1)
  ) {
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
  console.log(
    `sync: AFP UNO — spot px=${px} fund_unit_day=${fundUnitDay} gap_filled=${gapDaysFilled} (${syncDryRun ? "dry-run" : "ok"})`
  );

  const qKey = process.env.QUETALMIAFP_APIKEY?.trim() ?? "";
  if (qKey) {
    try {
      await ensureAfpUnoQuetalmiRecentHistory({ apiKey: qKey, dryRun: syncDryRun });
    } catch (e) {
      console.warn(`sync: AFP UNO — Quetalmi backfill skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function runFintual(
  cl: ReturnType<typeof chileWallClockNow>,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<{ pending: boolean; fintualNoChange?: boolean }> {
  if (cl.hour < 18) {
    console.log(`sync: Fintual — skip (before 18:00 Chile; now ${cl.hour}:${String(cl.minute).padStart(2, "0")}).`);
    return { pending: false };
  }
  if (!FORCE && !isChileBusinessDay(cl.ymd) && !isFintualFundPublishDay(cl.ymd)) {
    console.log(`sync: Fintual — skip (Chile non-business day ${cl.ymd}).`);
    return { pending: false };
  }

  let session;
  try {
    session = await getValidFintualSession();
  } catch (e) {
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
  let publishYmd = cl.ymd;
  try {
    const resolved = await resolveFintualGoalNavs(session.email, session.token, rowsWithMatch, cl);
    resolutions = resolved.resolutions;
    publishYmd = resolved.publishYmd;
  } finally {
    clearFintualRealAssetNavCaches();
  }
  for (const r of resolutions) {
    if (!r.mismatch || !r.row.matchedNotes || r.realAssetsNavClp == null) continue;
    const unitLine =
      r.units != null ? ` · cuotas ${r.units.toLocaleString("es-CL", { maximumFractionDigits: 4 })}` : "";
    const priceLine =
      r.fundPriceClp != null ? ` · valor cuota $${formatClp(r.fundPriceClp)}` : "";
    console.log(
      `sync: Fintual — ${r.row.name}: goals API $${formatClp(r.goalsApiNavClp)} vs real_assets $${formatClp(r.realAssetsNavClp)}${unitLine}${priceLine}`
    );
  }
  const appliedRows = resolutions.map((r) => r.row);
  const picked = pickFintualApplySnapshot(appliedRows, overrides, cl, state, publishYmd);
  const snap = picked.snap;
  writeGoalsSnapshot(snap);

  const sig = fintualMappedNavSignature(snap);
  state.fintualLastCheckYmd = cl.ymd;
  state.fintualLastPublishYmd = publishYmd;
  state.fintualLastCheckSig = sig;

  if (
    state.fintualLastAppliedPublishYmd != null &&
    publishYmd !== state.fintualLastAppliedPublishYmd &&
    state.fintualEveningSettledYmd === cl.ymd
  ) {
    delete state.fintualEveningSettledYmd;
  }

  const anyMapped = snap.goals.some((g) => g.matchedNotes);

  if (fintualNavUnchangedSinceLastApply(sig, state, publishYmd)) {
    if (fintualSnapshotMatchesDb(snap)) {
      const cleaned = cleanupMistakenPollDayFintualValuations(snap, syncDryRun);
      if (cleaned > 0) {
        console.log(`sync: Fintual — removed ${cleaned} mistaken post–as_of valuation row(s).`);
      }
      markFintualEveningSettledWhenCurrent(state, cl, snap, syncDryRun);
    }
    console.log(
      "sync: Fintual — API NAV unchanged since last apply; skip DB write (valuations already current)."
    );
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
    if (!syncDryRun && fintualEveningCatchUpComplete(rows, overrides, cl, publishYmd)) {
      state.fintualEveningSettledYmd = cl.ymd;
    }
    console.log(
      `sync: Fintual — valuations already match API for publish ${publishYmd}; no DB update needed.`
    );
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
    state.fintualLastAppliedPublishYmd = publishYmd;
    state.fintualLastAppliedSig = sig;
    markFintualEveningSettledWhenCurrent(state, cl, snap, syncDryRun);
    if (fintualEveningCatchUpComplete(rows, overrides, cl, publishYmd)) {
      state.fintualEveningSettledYmd = cl.ymd;
    }
  }
  const pollNote = publishYmd !== cl.ymd ? ` (poll ${cl.ymd})` : "";
  console.log(
    `sync: Fintual — applied ${applied}, skipped ${skipped} for as_of=${snap.asOfDate}${pollNote} (${syncDryRun ? "dry-run" : "ok"})`
  );
  return {
    pending: false,
    fintualNoChange: anyMapped && fintualChanges.length === 0,
  };
}


function markSbifObservedFxSuccess(state: GlobalSyncStateFile, kind: "usd" | "eur"): void {
  if (kind === "usd") delete state.sbifUsdLastErrorAt;
  else delete state.sbifEurLastErrorAt;
}

function markSbifObservedFxError(state: GlobalSyncStateFile, kind: "usd" | "eur"): void {
  const at = new Date().toISOString();
  if (kind === "usd") state.sbifUsdLastErrorAt = at;
  else state.sbifEurLastErrorAt = at;
}

/** After a failed/blocked SBIF call, later steps are not attempted — record that in the sync log. */
function skipSbifStepForBackoff(
  step: string,
  kind: "usd" | "eur",
  state: GlobalSyncStateFile,
  notes: SyncStepNote[]
): boolean {
  if (!isSbifApiInBackoff()) return false;
  const sec = Math.ceil(sbifApiBackoffRemainingMs() / 1000);
  const message = `skipped (API backoff, ${sec}s remaining — prior BCentral request failed or was rate-limited)`;
  console.warn(`sync: ${step} — ${message}`);
  notes.push({ step, message });
  if (!syncDryRun) markSbifObservedFxError(state, kind);
  return true;
}

function pushBcentralFxStepNote(
  notes: SyncStepNote[],
  step: string,
  lastAnchorYmd: string,
  rowsFetched: number,
  rowsUpserted: number,
  cl: ChileWallClock,
  maxDateFn: (cl: ChileWallClock) => string | null
): void {
  const latest = maxDateFn(cl);
  if (rowsUpserted > 0) {
    notes.push({
      step,
      message: `ok — ${rowsUpserted} row(s) upserted (${rowsFetched} from API after ${lastAnchorYmd}); latest in DB on or before today: ${latest ?? "—"}`,
    });
    return;
  }
  if (rowsFetched > 0) {
    notes.push({
      step,
      message: `ok — ${rowsFetched} observation(s) from API but none new in DB (already had through ${lastAnchorYmd}); latest: ${latest ?? "—"}`,
    });
    return;
  }
  notes.push({
    step,
    message: `ok — no new observations after ${lastAnchorYmd} (BCentral has not published later dates yet); latest in DB: ${latest ?? "—"}`,
  });
}

async function runSbifUsd(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  creds: BcentralCredentials,
  changes: SyncFieldChange[],
  errors: SyncStepError[],
  notes: SyncStepNote[]
): Promise<void> {
  if (skipSbifStepForBackoff("BCentral USD", "usd", state, notes)) return;
  const anchor = portfolioStartYmd();
  const lastFx = maxFxDateOnOrBefore(cl.ymd) ?? anchor;
  const prevUsdClp = fxClpPerUsdAt(lastFx) ?? fxClpPerUsdOnOrBefore(lastFx);

  let fxRows: { date: string; clpPerUsd: number }[] = [];
  try {
    fxRows = await fetchDolarAfterDate(lastFx, creds, cl.ymd);
    markSbifObservedFxSuccess(state, "usd");
  } catch (e) {
    if (isBcentralNoDataError(e)) {
      console.warn(`sync: BCentral USD — no newer series after ${lastFx} (ok if current).`);
      markSbifObservedFxSuccess(state, "usd");
    } else {
      if (!syncDryRun) markSbifObservedFxError(state, "usd");
      throw e;
    }
  }
  const fxN = upsertFxRows(
    fxRows.filter((r) => r.date >= anchor && r.date <= cl.ymd),
    syncDryRun
  );
  if (fxN > 0) {
    const newest = fxRows[fxRows.length - 1];
    const newUsdClp = newest?.clpPerUsd ?? fxClpPerUsdOnOrBefore(newest?.date ?? lastFx);
    if (newUsdClp != null) {
      changes.push({
        group: "sbif_usd",
        label: "BCentral USD",
        oldValue: prevUsdClp != null ? formatSyncFxRate(prevUsdClp) : "—",
        newValue: formatSyncFxRate(newUsdClp),
        oldDate: lastFx,
        newDate: newest?.date ?? lastFx,
      });
    }
  }
  pushBcentralFxStepNote(notes, "BCentral USD", lastFx, fxRows.length, fxN, cl, maxFxDateAfterUpsert);
  console.log(`sync: BCentral USD — ${fxN} row(s) after ${lastFx} (${syncDryRun ? "dry-run" : "ok"})`);
}

/** [SBIF euro observado](https://api.sbif.cl/documentacion/Euro.html) — `euro/posteriores/.../dias/...` */
async function runSbifEur(
  cl: ChileWallClock,
  state: GlobalSyncStateFile,
  creds: BcentralCredentials,
  changes: SyncFieldChange[],
  errors: SyncStepError[],
  notes: SyncStepNote[]
): Promise<void> {
  if (skipSbifStepForBackoff("BCentral EUR", "eur", state, notes)) return;
  const anchor = portfolioStartYmd();
  const lastEur = maxEurDateOnOrBefore(cl.ymd) ?? anchor;
  const prevEur = eurClpPerEurAt(lastEur) ?? eurClpPerEurOnOrBefore(lastEur);

  let eurRows: { date: string; clpPerEur: number }[] = [];
  try {
    eurRows = await fetchEuroAfterDate(lastEur, creds, cl.ymd);
    markSbifObservedFxSuccess(state, "eur");
  } catch (e) {
    if (isBcentralNoDataError(e)) {
      console.warn(`sync: BCentral EUR — no newer series after ${lastEur} (ok if current).`);
      markSbifObservedFxSuccess(state, "eur");
    } else {
      if (!syncDryRun) markSbifObservedFxError(state, "eur");
      throw e;
    }
  }
  const eurN = upsertEurRows(
    eurRows.filter((r) => r.date >= anchor && r.date <= cl.ymd),
    syncDryRun
  );
  if (eurN > 0) {
    const newest = eurRows[eurRows.length - 1];
    const newEurClp = newest?.clpPerEur;
    if (newEurClp != null && Number.isFinite(newEurClp)) {
      changes.push({
        group: "sbif_eur",
        label: "BCentral EUR",
        oldValue: prevEur != null ? formatSyncFxRate(prevEur) : "—",
        newValue: formatSyncFxRate(newEurClp),
        oldDate: lastEur,
        newDate: newest?.date ?? lastEur,
      });
    }
  }
  pushBcentralFxStepNote(notes, "BCentral EUR", lastEur, eurRows.length, eurN, cl, maxEurDateAfterUpsert);
  console.log(`sync: BCentral EUR — ${eurN} row(s) after ${lastEur} (${syncDryRun ? "dry-run" : "ok"})`);
}

function syncErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function runSyncStep(
  step: string,
  errors: SyncStepError[],
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const message = syncErrorMessage(e);
    console.error(`sync: ${step} — error: ${message}`);
    errors.push({ step, message });
  }
}

async function runSyncStepIfStale(
  source: GlobalSyncSource,
  stale: readonly GlobalSyncSource[],
  step: string,
  errors: SyncStepError[],
  state: GlobalSyncStateFile,
  fn: () => Promise<void>
): Promise<void> {
  if (!shouldRunSyncSource(source, stale)) {
    console.log(`sync: ${step} — skip (not stale).`);
    return;
  }
  const errorsBefore = errors.length;
  await runSyncStep(step, errors, fn);
  if (errors.length === errorsBefore) clearUserForcedStale(state, source);
}

async function runEquityEod(state: GlobalSyncStateFile, changes: SyncFieldChange[]): Promise<void> {
  if (!FORCE && !isEquityEodStale(state, { force: false })) {
    console.log("sync: equity EOD — skip (NYSE session + crypto UTC day already synced).");
    return;
  }
  const eodBefore = new Map<string, { trade_date: string; close_usd: number } | null>();
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
    if (after == null) continue;
    if (before != null && Math.abs(before.close_usd - after.close_usd) < 1e-8) continue;
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
    if (labels.nyseSession) state.equityEodLastNySessionYmd = labels.nyseSession;
    state.equityEodLastCryptoUtcYmd = labels.cryptoUtcDay;
  }
}

async function runSbifUf(
  cl: ReturnType<typeof chileWallClockNow>,
  creds: BcentralCredentials,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifUfMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: BCentral UF — skip (monthly window or already synced this month).");
    return;
  }
  const last = maxUfDate() ?? portfolioStartYmd();
  let rows: { date: string; clpPerUf: number }[] = [];
  try {
    rows = await fetchUfAfterDate(last, creds, cl.ymd);
  } catch (e) {
    if (isBcentralNoDataError(e)) {
      console.warn(`sync: BCentral UF — no newer series after ${last} (ok if already current).`);
    } else throw e;
  }
  const n = upsertUfRows(
    rows.map((r) => ({ date: r.date, clpPerUf: r.clpPerUf })),
    syncDryRun
  );
  if (n > 0) {
    const newest = rows[rows.length - 1];
    const newDate = newest?.date ?? last;
    const oldUf = ufClpAt(last);
    const newUf = newest ? ufClpAt(newDate) : null;
    if (newUf != null) {
      changes.push({
        group: "sbif_uf",
        label: "BCentral UF",
        oldValue: oldUf != null ? formatSyncUfRate(oldUf) : "—",
        newValue: formatSyncUfRate(newUf),
        oldDate: last,
        newDate,
      });
    }
  }
  if (!syncDryRun) state.sbifUfMonth = cl.monthKey;
  console.log(`sync: BCentral UF — ${n} row(s) after ${last} (${syncDryRun ? "dry-run" : "ok"})`);
}

async function runSbifUtm(
  cl: ReturnType<typeof chileWallClockNow>,
  creds: BcentralCredentials,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifUtmMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: BCentral UTM — skip (monthly window or already synced this month).");
    return;
  }
  const lastParts = safeMaxUtmMonthParts();
  const start = portfolioStartYmd();
  const anchor = lastParts ?? monthBeforeCalendar(parseYmdParts(start).y, parseYmdParts(start).m);
  let rows: { date: string; utmClp: number }[] = [];
  try {
    rows = await fetchUtmAfterMonth(anchor.y, anchor.m, creds, cl.ymd);
  } catch (e) {
    if (isBcentralNoDataError(e)) {
      console.warn(`sync: BCentral UTM — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
    } else throw e;
  }
  const n = upsertUtmRows(rows, syncDryRun);
  if (n > 0) {
    const newest = rows[rows.length - 1];
    const oldLabel = `${anchor.y}-${String(anchor.m).padStart(2, "0")}`;
    changes.push({
      group: "sbif_utm",
      label: "BCentral UTM",
      oldValue: "—",
      newValue: newest ? String(Math.round(newest.utmClp)) : `+${n}`,
      oldDate: null,
      newDate: newest?.date?.slice(0, 10) ?? null,
    });
  }
  if (!syncDryRun) state.sbifUtmMonth = cl.monthKey;
  console.log(`sync: BCentral UTM — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}

async function runSbifIpc(
  cl: ReturnType<typeof chileWallClockNow>,
  creds: BcentralCredentials,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifIpcMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: BCentral IPC — skip (monthly window or already synced this month).");
    return;
  }
  const lastParts = safeMaxIpcMonthParts();
  const start = portfolioStartYmd();
  const sp = parseYmdParts(start);
  const anchor = lastParts ?? monthBeforeCalendar(sp.y, sp.m);
  let rows: { date: string; ipcIndex: number }[] = [];
  try {
    rows = await fetchIpcAfterMonth(anchor.y, anchor.m, creds, cl.ymd);
  } catch (e) {
    if (isBcentralNoDataError(e)) {
      console.warn(`sync: BCentral IPC — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
    } else throw e;
  }
  const n = upsertIpcRows(rows, syncDryRun);
  if (n > 0) {
    const newest = rows[rows.length - 1];
    changes.push({
      group: "sbif_ipc",
      label: "BCentral IPC",
      oldValue: "—",
      newValue: newest ? String(newest.ipcIndex) : `+${n}`,
      oldDate: null,
      newDate: newest?.date?.slice(0, 10) ?? null,
    });
  }
  if (!syncDryRun) state.sbifIpcMonth = cl.monthKey;
  console.log(`sync: BCentral IPC — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}

/** Run all external syncs. Returns exit code 0 on success, 1 if any step failed. */
export async function runGlobalSyncAll(opts?: { dryRun?: boolean }): Promise<number> {
  syncDryRun = opts?.dryRun ?? process.argv.includes("--dry-run");
  const syncChanges: SyncFieldChange[] = [];
  const stepErrors: SyncStepError[] = [];
  const stepNotes: SyncStepNote[] = [];
  const logOpts: SyncRunLogOptions = {};
  let stale: GlobalSyncSource[] = [];
  /** Sources stale when the run started (log must not re-check after updates). */
  let staleAtStart: GlobalSyncSource[] = [];
  let state: GlobalSyncStateFile | null = null;
  let cl = chileWallClockNow();

  try {
    loadRootDotenv();
    cl = chileWallClockNow();
    state = loadGlobalSyncState();
    stale = staleSyncSources(cl, state, { force: FORCE, forceSbif: FORCE_SBIF });
    staleAtStart = [...stale];
    console.log(
      `sync:all — Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")} (${syncDryRun ? "dry-run" : "live"})` +
        (stale.length ? ` stale=[${stale.join(", ")}]` : " nothing stale")
    );

    await runSyncStepIfStale("afp_uno", stale, "AFP UNO", stepErrors, state!, async () => {
      await runUnoSpot(cl, state!, syncChanges);
    });

    await runSyncStepIfStale("fintual", stale, "Fintual", stepErrors, state!, async () => {
      const fintualResult = await runFintual(cl, state!, syncChanges);
      if (fintualResult.fintualNoChange) logOpts.fintualNoChange = true;
    });

    const bcentral = loadBcentralCredentials();
    if (!bcentral) {
      console.warn("sync: BCentral — skip (set BCENTRAL_EMAIL and BCENTRAL_PASSWORD in .env).");
    } else {
      await runSyncStepIfStale("equity_eod", stale, "Equity EOD", stepErrors, state!, async () => {
        await runEquityEod(state!, syncChanges);
      });
      await runSyncStepIfStale("sbif_usd", stale, "BCentral USD", stepErrors, state!, async () => {
        await runSbifUsd(cl, state!, bcentral, syncChanges, stepErrors, stepNotes);
      });
      await runSyncStepIfStale("sbif_eur", stale, "BCentral EUR", stepErrors, state!, async () => {
        await runSbifEur(cl, state!, bcentral, syncChanges, stepErrors, stepNotes);
      });
      if (cl.day < 9 && !FORCE_SBIF) {
        console.log(
          "sync: BCentral — skip UF/UTM/IPC (before day 9; series often incomplete earlier — use --force-sbif to override)."
        );
      } else {
        await runSyncStepIfStale("sbif_uf", stale, "BCentral UF", stepErrors, state!, async () => {
          await runSbifUf(cl, bcentral, state!, syncChanges);
        });
        await runSyncStepIfStale("sbif_utm", stale, "BCentral UTM", stepErrors, state!, async () => {
          await runSbifUtm(cl, bcentral, state!, syncChanges);
        });
        await runSyncStepIfStale("sbif_ipc", stale, "BCentral IPC", stepErrors, state!, async () => {
          await runSbifIpc(cl, bcentral, state!, syncChanges);
        });
      }
    }
  } catch (e) {
    const message = syncErrorMessage(e);
    console.error(`sync:all — fatal: ${message}`);
    stepErrors.push({ step: "sync:all", message });
  } finally {
    insertSyncRunLog(staleAtStart, syncChanges, syncDryRun, {
      ...logOpts,
      notes: stepNotes,
      errors: stepErrors,
    });
    if (!syncDryRun && state) saveGlobalSyncState(state);
    if (stepErrors.length > 0) {
      console.log(`sync:all — done with ${stepErrors.length} error(s).`);
      return 1;
    }
    console.log("sync:all — done.");
    return 0;
  }
}

