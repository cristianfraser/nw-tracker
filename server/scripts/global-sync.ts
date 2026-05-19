/**
 * Orchestrates external syncs with Chile-time rules:
 * - AFP UNO spot: once per Chile calendar day (00:00 rollover).
 * - Fintual goals: from 18:00 America/Santiago; applies when mapped NAV signature changes (poll alone
 *   does not clear stale). Valuations use prior calendar day as `as_of_date` until Fintual publishes.
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
import { insertAppMessage } from "../src/appMessages.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { db } from "../src/db.js";
import { isSbifMonthlyStale, staleSyncSources } from "../src/globalSyncStale.js";
import { insertSyncRunLog, type SyncFieldChange } from "../src/syncRunLog.js";
import {
  loadGlobalSyncState,
  saveGlobalSyncState,
  type GlobalSyncStateFile,
} from "../src/globalSyncState.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { fetchUnoClFondoAValorCuota } from "../src/afpUnoWebsiteCuota.js";
import {
  upsertFundUnitDailyRow,
  upsertAfpSpotValuationWithExplicitPx,
  ensureAfpUnoQuetalmiRecentHistory,
} from "../src/afpUnoValuation.js";
import { fillFundUnitDailyCalendarGap, latestFundUnitRow } from "../src/fundUnitDaily.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "../src/afpQuetalmiApi.js";
import {
  fetchFintualGoalsRaw,
  getValidFintualSession,
  loadGoalIdOverrides,
  loadRootDotenv,
  matchGoalToImportNotes,
  parseGoalsFromResponse,
  writeGoalsSnapshot,
} from "./fintualApiLib.js";
import {
  applyFintualGoalsSnapshotToDb,
  cleanupMistakenPollDayFintualValuations,
  fintualEveningCatchUpComplete,
  fintualMappedNavSignature,
  fintualSnapshotMatchesDb,
  pickFintualApplySnapshot,
} from "./fintualApplyShared.js";
import {
  clearFintualRealAssetNavCaches,
  formatClp,
  resolveFintualGoalNavs,
} from "./fintualRealAssetNav.js";
import { fetchIpcAfterMonth, fetchUfAfterDate, fetchUtmAfterMonth } from "../src/sbifApi.js";
import {
  maxUfDate,
  safeMaxIpcMonthParts,
  safeMaxUtmMonthParts,
  upsertIpcRows,
  upsertUfRows,
  upsertUtmRows,
} from "../src/sbifSyncDb.js";
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

async function runUnoSpot(
  cl: ReturnType<typeof chileWallClockNow>,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
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
  upsertAfpSpotValuationWithExplicitPx({
    accountId: row.id,
    asOfYmd: asOf,
    px,
    dryRun: syncDryRun,
  });
  const impliedVal = Math.round(px * 100) / 100;
  const prevRounded =
    prevVal?.value_clp != null && Number.isFinite(prevVal.value_clp)
      ? Math.round(prevVal.value_clp)
      : null;
  const nextRounded = Math.round(impliedVal);
  if (prevRounded == null || Math.abs(prevRounded - nextRounded) > 1) {
    changes.push({
      label: "AFP UNO value_clp",
      oldValue: prevRounded != null ? String(prevRounded) : "—",
      newValue: String(nextRounded),
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
): Promise<{ pending: boolean }> {
  if (cl.hour < 18) {
    console.log(`sync: Fintual — skip (before 18:00 Chile; now ${cl.hour}:${String(cl.minute).padStart(2, "0")}).`);
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
  try {
    resolutions = await resolveFintualGoalNavs(session.email, session.token, rowsWithMatch, cl);
  } finally {
    clearFintualRealAssetNavCaches();
  }
  for (const r of resolutions) {
    if (!r.mismatch || !r.row.matchedNotes || r.realAssetsNavClp == null) continue;
    const unitLine =
      r.units != null ? `\nCuotas: ${r.units.toLocaleString("es-CL", { maximumFractionDigits: 4 })}` : "";
    const priceLine =
      r.fundPriceClp != null ? `\nValor cuota: $${formatClp(r.fundPriceClp)}` : "";
    insertAppMessage(
      "notification",
      `Fintual: ${r.row.name}`,
      `Cuenta API: $${formatClp(r.goalsApiNavClp)} vs real_assets: $${formatClp(r.realAssetsNavClp)}${unitLine}${priceLine}`,
      syncDryRun
    );
  }
  const appliedRows = resolutions.map((r) => r.row);
  const picked = pickFintualApplySnapshot(appliedRows, overrides, cl, state);
  const snap = picked.snap;
  writeGoalsSnapshot(snap);

  const sig = fintualMappedNavSignature(snap);
  state.fintualLastCheckYmd = cl.ymd;
  state.fintualLastCheckSig = sig;

  if (fintualSnapshotMatchesDb(snap)) {
    const cleaned = cleanupMistakenPollDayFintualValuations(snap, syncDryRun);
    if (cleaned > 0) {
      console.log(`sync: Fintual — removed ${cleaned} mistaken post–as_of valuation row(s).`);
    }
    if (!syncDryRun && fintualEveningCatchUpComplete(rows, overrides, cl)) {
      state.fintualEveningSettledYmd = cl.ymd;
    }
    console.log(
      "sync: Fintual — API NAV unchanged since last apply; still stale until Fintual publishes new totals."
    );
    if (STRICT_FINTUAL) {
      const hasMapped = snap.goals.some((g) => g.matchedNotes);
      if (hasMapped) {
        console.error("sync: Fintual — --strict-fintual: no valuation update applied.");
        if (!syncDryRun) saveGlobalSyncState(state);
        process.exit(2);
      }
    }
    return { pending: true };
  }

  const { applied, skipped, changes: fintualChanges } = applyFintualGoalsSnapshotToDb(snap, syncDryRun);
  changes.push(...fintualChanges);
  if (!syncDryRun) {
    state.fintualLastAppliedYmd = cl.ymd;
    state.fintualLastAppliedSig = sig;
    if (fintualEveningCatchUpComplete(rows, overrides, cl)) {
      state.fintualEveningSettledYmd = cl.ymd;
    }
  }
  console.log(`sync: Fintual — applied ${applied}, skipped ${skipped} for as_of=${snap.asOfDate} (${syncDryRun ? "dry-run" : "ok"})`);
  return { pending: false };
}

function isSbifNoDataError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("404") || msg.includes("No hay datos");
}

async function runSbifUf(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifUfMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: SBIF UF — skip (monthly window or already synced this month).");
    return;
  }
  const last = maxUfDate() ?? portfolioStartYmd();
  let rows: { date: string; clpPerUf: number }[] = [];
  try {
    rows = await fetchUfAfterDate(last, apiKey);
  } catch (e) {
    if (isSbifNoDataError(e)) {
      console.warn(`sync: SBIF UF — no newer series after ${last} (ok if already current).`);
    } else throw e;
  }
  const n = upsertUfRows(
    rows.map((r) => ({ date: r.date, clpPerUf: r.clpPerUf })),
    syncDryRun
  );
  if (n > 0) {
    changes.push({
      label: "SBIF UF rows",
      oldValue: last,
      newValue: `+${n} (latest ${rows[rows.length - 1]?.date ?? last})`,
    });
  }
  if (!syncDryRun) state.sbifUfMonth = cl.monthKey;
  console.log(`sync: SBIF UF — ${n} row(s) after ${last} (${syncDryRun ? "dry-run" : "ok"})`);
}

async function runSbifUtm(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifUtmMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: SBIF UTM — skip (monthly window or already synced this month).");
    return;
  }
  const lastParts = safeMaxUtmMonthParts();
  const start = portfolioStartYmd();
  const anchor = lastParts ?? monthBeforeCalendar(parseYmdParts(start).y, parseYmdParts(start).m);
  let rows: { date: string; utmClp: number }[] = [];
  try {
    rows = await fetchUtmAfterMonth(anchor.y, anchor.m, apiKey);
  } catch (e) {
    if (isSbifNoDataError(e)) {
      console.warn(`sync: SBIF UTM — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
    } else throw e;
  }
  const n = upsertUtmRows(rows, syncDryRun);
  if (n > 0) {
    const anchorLabel = `${anchor.y}-${String(anchor.m).padStart(2, "0")}`;
    changes.push({
      label: "SBIF UTM rows",
      oldValue: anchorLabel,
      newValue: `+${n}`,
    });
  }
  if (!syncDryRun) state.sbifUtmMonth = cl.monthKey;
  console.log(`sync: SBIF UTM — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}

async function runSbifIpc(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile,
  changes: SyncFieldChange[]
): Promise<void> {
  if (!isSbifMonthlyStale(cl, state.sbifIpcMonth, { forceSbif: FORCE_SBIF })) {
    console.log("sync: SBIF IPC — skip (monthly window or already synced this month).");
    return;
  }
  const lastParts = safeMaxIpcMonthParts();
  const start = portfolioStartYmd();
  const sp = parseYmdParts(start);
  const anchor = lastParts ?? monthBeforeCalendar(sp.y, sp.m);
  let rows: { date: string; ipcIndex: number }[] = [];
  try {
    rows = await fetchIpcAfterMonth(anchor.y, anchor.m, apiKey);
  } catch (e) {
    if (isSbifNoDataError(e)) {
      console.warn(`sync: SBIF IPC — no rows after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (ok if current).`);
    } else throw e;
  }
  const n = upsertIpcRows(rows, syncDryRun);
  if (n > 0) {
    const anchorLabel = `${anchor.y}-${String(anchor.m).padStart(2, "0")}`;
    changes.push({
      label: "SBIF IPC rows",
      oldValue: anchorLabel,
      newValue: `+${n}`,
    });
  }
  if (!syncDryRun) state.sbifIpcMonth = cl.monthKey;
  console.log(`sync: SBIF IPC — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${syncDryRun ? "dry-run" : "ok"})`);
}

/** Run all external syncs. Returns exit code 0 on success. */
export async function runGlobalSyncAll(opts?: { dryRun?: boolean }): Promise<number> {
  syncDryRun = opts?.dryRun ?? process.argv.includes("--dry-run");
  try {
    loadRootDotenv();
    const cl = chileWallClockNow();
    const state = loadGlobalSyncState();
    const stale = staleSyncSources(cl, state, { force: FORCE, forceSbif: FORCE_SBIF });
    const syncChanges: SyncFieldChange[] = [];
    console.log(
      `sync:all — Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")} (${syncDryRun ? "dry-run" : "live"})` +
        (stale.length ? ` stale=[${stale.join(", ")}]` : " nothing stale")
    );

    await runUnoSpot(cl, state, syncChanges);
    await runFintual(cl, state, syncChanges);

    const apiKey = process.env.SBIF_APIKEY?.trim() ?? "";
    if (!apiKey) {
      console.warn("sync: SBIF — skip UF/UTM/IPC (set SBIF_APIKEY in .env).");
    } else if (cl.day < 9 && !FORCE_SBIF) {
      console.log(
        "sync: SBIF — skip UF/UTM/IPC (before day 9; CMF UF series often incomplete earlier — use --force-sbif to override)."
      );
    } else {
      await runSbifUf(cl, apiKey, state, syncChanges);
      await runSbifUtm(cl, apiKey, state, syncChanges);
      await runSbifIpc(cl, apiKey, state, syncChanges);
    }

    insertSyncRunLog(stale, syncChanges, syncDryRun);

    if (!syncDryRun) saveGlobalSyncState(state);
    console.log("sync:all — done.");
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

const isCli =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("global-sync.ts") || process.argv[1].endsWith("global-sync.js"));

if (isCli) {
  void runGlobalSyncAll().then((code) => process.exit(code));
}
