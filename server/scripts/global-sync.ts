/**
 * Orchestrates external syncs with Chile-time rules:
 * - AFP UNO spot: once per Chile calendar day (00:00 rollover).
 * - Fintual goals: only from 18:00 America/Santiago; applies when NAV differs from DB.
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
import { isSbifMonthlyStale, staleSyncSources } from "../src/globalSyncStale.js";
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
  buildGoalsSnapshot,
  fetchFintualGoalsRaw,
  getValidFintualSession,
  loadGoalIdOverrides,
  loadRootDotenv,
  parseGoalsFromResponse,
  writeGoalsSnapshot,
} from "./fintualApiLib.js";
import {
  applyFintualGoalsSnapshotToDb,
  fintualMappedNavSignature,
  fintualSnapshotMatchesDb,
} from "./fintualApplyShared.js";
import { fetchIpcAfterMonth, fetchUfAfterDate, fetchUtmAfterMonth } from "../src/sbifApi.js";
import {
  maxUfDate,
  safeMaxIpcMonthParts,
  safeMaxUtmMonthParts,
  upsertIpcRows,
  upsertUfRows,
  upsertUtmRows,
} from "../src/sbifSyncDb.js";
const DRY = process.argv.includes("--dry-run");
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

async function runUnoSpot(cl: ReturnType<typeof chileWallClockNow>, state: GlobalSyncStateFile): Promise<void> {
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
      dryRun: DRY,
    });
    if (filled > 0) {
      console.log(`sync: AFP UNO — filled ${filled} day(s) with prior px=${anchorPx} before ${fundUnitDay}`);
    }
  }

  const { gapDaysFilled } = upsertFundUnitDailyRow({
    day: fundUnitDay,
    unit_value_clp: px,
    note: `uno.cl:homepage|Fondo-A|${parsed.raw_price_fragment}|sync:all`,
    dryRun: DRY,
  });
  upsertAfpSpotValuationWithExplicitPx({
    accountId: row.id,
    asOfYmd: asOf,
    px,
    dryRun: DRY,
  });
  if (!DRY) {
    state.unoLastSpotYmd = cl.ymd;
    state.afpLastUnitDay = fundUnitDay;
    state.afpLastUnitClp = px;
  }
  console.log(
    `sync: AFP UNO — spot px=${px} fund_unit_day=${fundUnitDay} gap_filled=${gapDaysFilled} (${DRY ? "dry-run" : "ok"})`
  );

  const qKey = process.env.QUETALMIAFP_APIKEY?.trim() ?? "";
  if (qKey) {
    try {
      await ensureAfpUnoQuetalmiRecentHistory({ apiKey: qKey, dryRun: DRY });
    } catch (e) {
      console.warn(`sync: AFP UNO — Quetalmi backfill skipped: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function runFintual(
  cl: ReturnType<typeof chileWallClockNow>,
  state: GlobalSyncStateFile
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
  const snap = buildGoalsSnapshot(rows, loadGoalIdOverrides());
  writeGoalsSnapshot(snap);

  const sig = fintualMappedNavSignature(snap);
  state.fintualLastCheckYmd = cl.ymd;

  if (fintualSnapshotMatchesDb(snap)) {
    console.log(
      "sync: Fintual — DB already matches API (no NAV change yet today, or already applied); still “pending” until Fintual publishes new totals."
    );
    if (STRICT_FINTUAL) {
      const hasMapped = snap.goals.some((g) => g.matchedNotes);
      if (hasMapped) {
        console.error("sync: Fintual — --strict-fintual: no valuation update applied.");
        if (!DRY) saveGlobalSyncState(state);
        process.exit(2);
      }
    }
    return { pending: true };
  }

  const { applied, skipped } = applyFintualGoalsSnapshotToDb(snap, DRY);
  if (!DRY) {
    state.fintualLastAppliedYmd = cl.ymd;
    state.fintualLastAppliedSig = sig;
  }
  console.log(`sync: Fintual — applied ${applied}, skipped ${skipped} for as_of=${snap.asOfDate} (${DRY ? "dry-run" : "ok"})`);
  return { pending: false };
}

function isSbifNoDataError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("404") || msg.includes("No hay datos");
}

async function runSbifUf(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile
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
    DRY
  );
  if (!DRY) state.sbifUfMonth = cl.monthKey;
  console.log(`sync: SBIF UF — ${n} row(s) after ${last} (${DRY ? "dry-run" : "ok"})`);
}

async function runSbifUtm(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile
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
  const n = upsertUtmRows(rows, DRY);
  if (!DRY) state.sbifUtmMonth = cl.monthKey;
  console.log(`sync: SBIF UTM — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${DRY ? "dry-run" : "ok"})`);
}

async function runSbifIpc(
  cl: ReturnType<typeof chileWallClockNow>,
  apiKey: string,
  state: GlobalSyncStateFile
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
  const n = upsertIpcRows(rows, DRY);
  if (!DRY) state.sbifIpcMonth = cl.monthKey;
  console.log(`sync: SBIF IPC — ${n} row(s) after ${anchor.y}-${String(anchor.m).padStart(2, "0")} (${DRY ? "dry-run" : "ok"})`);
}

async function main(): Promise<void> {
  loadRootDotenv();
  const cl = chileWallClockNow();
  const state = loadGlobalSyncState();
  const stale = staleSyncSources(cl, state, { force: FORCE, forceSbif: FORCE_SBIF });
  console.log(
    `sync:all — Chile ${cl.ymd} ${String(cl.hour).padStart(2, "0")}:${String(cl.minute).padStart(2, "0")} (${DRY ? "dry-run" : "live"})` +
      (stale.length ? ` stale=[${stale.join(", ")}]` : " nothing stale")
  );

  await runUnoSpot(cl, state);

  await runFintual(cl, state);

  const apiKey = process.env.SBIF_APIKEY?.trim() ?? "";
  if (!apiKey) {
    console.warn("sync: SBIF — skip UF/UTM/IPC (set SBIF_APIKEY in .env).");
  } else if (cl.day < 9 && !FORCE_SBIF) {
    console.log("sync: SBIF — skip UF/UTM/IPC (before day 9; CMF UF series often incomplete earlier — use --force-sbif to override).");
  } else {
    await runSbifUf(cl, apiKey, state);
    await runSbifUtm(cl, apiKey, state);
    await runSbifIpc(cl, apiKey, state);
  }

  if (!DRY) saveGlobalSyncState(state);
  console.log("sync:all — done.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
