import fs from "node:fs";
import type Database from "better-sqlite3";
import type { RequestHandler } from "express";
import { clearAggregationCache } from "./aggregationCache.js";
import { chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { demoVisitorForRequest } from "./demoAnalytics.js";
import { demoMarketAwake } from "./demoMarketActivity.js";
import { demoModeEnabled } from "./demoModeFlag.js";
import { demoWriteAllowedByPolicy } from "./demoWritePolicy.js";

/**
 * The hosted demo is writable in a narrow way (docs/demo-about-plan.md §4, 2026-11-07): every
 * visitor shares one database, a few edits without free text are open (`demoWritePolicy.ts`), each
 * visitor gets {@link DEMO_WRITES_PER_VISITOR_PER_DAY} of them a day, and the database goes back to
 * the generated state — a copy saved right after generation — when the demo goes idle and every
 * night at {@link DEMO_NIGHTLY_RESET_HOUR_CHILE}:00 Chile, whenever something was written since
 * the last reset. Personal instances never load any of this.
 */

export const DEMO_WRITES_PER_VISITOR_PER_DAY = 100;
export const DEMO_NIGHTLY_RESET_HOUR_CHILE = 4;
const RESET_CHECK_INTERVAL_MS = 60_000;

/** The generated state, saved beside the demo DB (the build's `rm -f …demo.db*` removes it too). */
export function demoPristineDbPath(): string {
  const file = (db as unknown as { name: string }).name;
  if (!file || file === ":memory:") throw new Error("the demo pristine copy needs a file-backed database");
  return `${file}.pristine`;
}

/** The handle the reset works on: the app's database; tests pass their own scratch one. */
type SqliteHandle = Pick<Database.Database, "prepare" | "exec" | "pragma" | "transaction">;

/** Save the current database as the generated state (VACUUM INTO, a consistent copy). */
export function saveDemoPristineCopy(
  target: string = demoPristineDbPath(),
  database: SqliteHandle = db as unknown as SqliteHandle
): void {
  fs.rmSync(target, { force: true });
  database.prepare(`VACUUM INTO ?`).run(target);
}

/** Boot: keep the build's copy; make one when there is none (a DB generated at boot, an older build). */
export function ensureDemoPristineCopy(): void {
  const target = demoPristineDbPath();
  if (fs.existsSync(target)) return;
  saveDemoPristineCopy(target);
  console.log(`demo: saved the generated state to ${target}`);
}

// --- Writes and the per-visitor quota ------------------------------------------------------

let writtenSinceReset = false;
const writesByVisitorDay = new Map<string, number>();
let quotaDay: string | null = null;

/** True when a visitor write landed since the last reset (a reset is skipped otherwise). */
export function demoWrittenSinceReset(): boolean {
  return writtenSinceReset;
}

/**
 * Takes one write from the visitor's daily allowance. False once it is used up. The count lives in
 * memory and starts again each Chile day (a restart forgets it, which only ever errs generous).
 */
export function takeDemoWrite(visitor: string, day: string): boolean {
  if (quotaDay !== day) {
    writesByVisitorDay.clear();
    quotaDay = day;
  }
  const used = writesByVisitorDay.get(visitor) ?? 0;
  if (used >= DEMO_WRITES_PER_VISITOR_PER_DAY) return false;
  writesByVisitorDay.set(visitor, used + 1);
  return true;
}

/**
 * Mounted after `demoReadOnlyMiddleware`, which lets only the allowlisted writes through: counts
 * each against the visitor's allowance (429 `demo_write_limit` once spent), refuses a request with
 * no visitor identity (a bot) and marks the database as written.
 */
export function demoWriteQuotaMiddleware(): RequestHandler {
  return (req, res, next) => {
    const isApi = req.path === "/api" || req.path.startsWith("/api/");
    if (!isApi || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (!demoWriteAllowedByPolicy(req.method, req.path)) {
      // Only the beacon and other exempt paths reach here (the read-only guard runs first).
      next();
      return;
    }
    const day = chileCalendarTodayYmd();
    const identity = demoVisitorForRequest(req, day);
    if (!identity) {
      res.status(403).json({ error: "demo_read_only" });
      return;
    }
    if (!takeDemoWrite(identity.visitor, day)) {
      res.status(429).json({ error: "demo_write_limit" });
      return;
    }
    writtenSinceReset = true;
    next();
  };
}

// --- Reset to the generated state ----------------------------------------------------------

/**
 * Restore every table from the pristine copy in one transaction (foreign keys off, as the
 * FK-off migrations run), then drop the mark-input log the restore itself wrote and every cache.
 * Returns false (and does nothing) when nothing was written since the last reset, unless `force`.
 */
export function resetDemoDatabaseToPristine(
  opts: { force?: boolean; pristinePath?: string; database?: SqliteHandle } = {}
): boolean {
  if (!opts.force && !writtenSinceReset) return false;
  const pristine = opts.pristinePath ?? demoPristineDbPath();
  const database = opts.database ?? (db as unknown as SqliteHandle);
  if (!fs.existsSync(pristine)) throw new Error(`demo reset: no pristine copy at ${pristine}`);
  database.prepare(`ATTACH DATABASE ? AS pristine`).run(pristine);
  try {
    database.pragma("foreign_keys = OFF");
    try {
      const tables = (
        database
          .prepare(
            `SELECT name FROM pristine.sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
              ORDER BY name`
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      const mainTables = new Set(
        (
          database
            .prepare(`SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[]
        ).map((r) => r.name)
      );
      const hasSequence =
        (database.prepare(`SELECT COUNT(*) AS c FROM pristine.sqlite_master WHERE name = 'sqlite_sequence'`).get() as {
          c: number;
        }).c > 0;
      database.transaction(() => {
        for (const name of mainTables) {
          if (!tables.includes(name)) throw new Error(`demo reset: table ${name} is not in the pristine copy`);
        }
        for (const name of tables) {
          const q = `"${name.replace(/"/g, '""')}"`;
          database.exec(`DELETE FROM main.${q}`);
          database.exec(`INSERT INTO main.${q} SELECT * FROM pristine.${q}`);
        }
        if (hasSequence) {
          database.exec(`DELETE FROM main.sqlite_sequence`);
          database.exec(`INSERT INTO main.sqlite_sequence SELECT * FROM pristine.sqlite_sequence`);
        }
        // The restore's own inserts went through the mark-input triggers; every cache is dropped
        // below, so the log they wrote describes nothing worth trimming.
        if (mainTables.has("mark_input_changes")) database.exec(`DELETE FROM main.mark_input_changes`);
      })();
    } finally {
      database.pragma("foreign_keys = ON");
    }
  } finally {
    database.prepare(`DETACH DATABASE pristine`).run();
  }
  writtenSinceReset = false;
  clearAggregationCache();
  return true;
}

/** Nightly-reset bookkeeping: the Chile day whose 04:00 reset already ran (or was skipped). */
let nightlyResetDoneFor: string | null = null;

/** Pure decision for one check: reset now? */
export function demoResetDue(input: {
  written: boolean;
  awake: boolean;
  chileYmd: string;
  chileHour: number;
  nightlyDoneFor: string | null;
}): { reset: boolean; nightly: boolean } {
  const nightly = input.chileHour >= DEMO_NIGHTLY_RESET_HOUR_CHILE && input.nightlyDoneFor !== input.chileYmd;
  if (!input.written) return { reset: false, nightly };
  return { reset: nightly || !input.awake, nightly };
}

/** Checks once a minute; idle = the demo-market idle (30 min after the last real request). */
export function startDemoResetScheduler(): void {
  if (!demoModeEnabled()) return;
  // Today's 04:00 counts as done at boot: a fresh deploy is already the generated state.
  nightlyResetDoneFor = chileWallClockAt(new Date()).ymd;
  const tick = () => {
    const clock = chileWallClockAt(new Date());
    const due = demoResetDue({
      written: writtenSinceReset,
      awake: demoMarketAwake(),
      chileYmd: clock.ymd,
      chileHour: clock.hour,
      nightlyDoneFor: nightlyResetDoneFor,
    });
    if (due.nightly) nightlyResetDoneFor = clock.ymd;
    if (!due.reset) return;
    try {
      resetDemoDatabaseToPristine();
      console.log(`demo: database reset to the generated state (${due.nightly ? "nightly" : "idle"})`);
    } catch (e) {
      console.error(`demo: reset failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  setInterval(tick, RESET_CHECK_INTERVAL_MS).unref();
}

/** Tests: forget writes, quota and nightly state. */
export function resetDemoWritableStateForTest(): void {
  writtenSinceReset = false;
  writesByVisitorDay.clear();
  quotaDay = null;
  nightlyResetDoneFor = null;
}

/** Tests: mark the database as written (what an allowed request does). */
export function markDemoWrittenForTest(): void {
  writtenSinceReset = true;
}
