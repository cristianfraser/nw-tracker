import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insertAppMessage } from "./appMessages.js";
import { chileCalendarAddDays, chileWallClockAt, dateAtTimeZoneWallClock } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { parseDemoMarketPublishOutcome, type DemoMarketPublishOutcome } from "./demoData/demoMarketArtifact.js";
import { ScheduledJob, type KernelRunResult } from "./schedulerKernel.js";

/**
 * The home server publishes the hosted demo's market data (2026-11-09,
 * docs/demo-market-publish-plan.md). Every night at {@link DEMO_MARKET_PUBLISH_HOUR}:00 Chile —
 * after the evening EOD syncs — it runs `scripts/publish-demo-market.ts --upload` in a child
 * process: the real-market loader against a scratch SQLite file (never this server's DB: the
 * loader writes through the process's one `db`), exported as one artifact and uploaded as the
 * GitHub Release asset the Render build reads. At boot it publishes at once when the last success
 * is older than {@link DEMO_MARKET_PUBLISH_STALE_MS} (a deploy every push must not republish).
 *
 * Enabled on the primary only: `DEMO_MARKET_PUBLISH_ENABLED` (default on; off with
 * `BACKGROUND_JOBS_ENABLED=0`, never on the demo) and a `DEMO_MARKET_PUBLISH_TOKEN` at boot —
 * without the token the job is «not configured» and never arms. A failure is a notification; a
 * success a log row. The last outcome is kept in `server/data/.demo-market-publish-state.json`.
 */

export const DEMO_MARKET_PUBLISH_HOUR = 1;
export const DEMO_MARKET_PUBLISH_STALE_MS = 20 * 60 * 60_000;
/** The loader retries each source for ~10 minutes; a whole run (≈12 sources) stays well inside this. */
const PUBLISH_TIMEOUT_MS = 60 * 60_000;
const RETRY_DELAYS_MS = [15 * 60_000, 45 * 60_000];
const FAILURE_TITLE = "Demo market publish failed";
const SUCCESS_TITLE = "Demo market published";

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(serverDir, "data");
const STATE_FILE = path.join(dataDir, ".demo-market-publish-state.json");
const SCRATCH_DB = path.join(dataDir, "demo-market-publish.db");

export type DemoMarketPublishState = {
  last_success_at: string | null;
  last_complete_through: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
};

export function demoMarketPublishToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DEMO_MARKET_PUBLISH_TOKEN?.trim() || null;
}

export function readDemoMarketPublishState(file: string = STATE_FILE): DemoMarketPublishState {
  if (!fs.existsSync(file)) return { last_success_at: null, last_complete_through: null, last_attempt_at: null, last_error: null };
  return JSON.parse(fs.readFileSync(file, "utf8")) as DemoMarketPublishState;
}

function writeState(s: DemoMarketPublishState): void {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);
}

/** The next {@link DEMO_MARKET_PUBLISH_HOUR}:00 Chile strictly after `nowMs` (at least a minute ahead). */
export function nextNightlyDemoMarketPublishMs(nowMs: number): number {
  const today = chileWallClockAt(new Date(nowMs)).ymd;
  for (const day of [today, chileCalendarAddDays(today, 1), chileCalendarAddDays(today, 2)]) {
    const at = dateAtTimeZoneWallClock(day, DEMO_MARKET_PUBLISH_HOUR, 0, "America/Santiago").getTime();
    if (at >= nowMs + 60_000) return at;
  }
  throw new Error("demo market publish: no nightly slot in the next two days");
}

/** At boot: now when the last success is missing or older than the stale window, else the nightly slot. */
export function firstDemoMarketPublishMs(nowMs: number, lastSuccessAt: string | null): number {
  const last = lastSuccessAt == null ? NaN : Date.parse(lastSuccessAt);
  if (Number.isNaN(last) || nowMs - last >= DEMO_MARKET_PUBLISH_STALE_MS) return nowMs;
  return nextNightlyDemoMarketPublishMs(nowMs);
}

function tsxBinary(): string {
  const candidates = [path.join(serverDir, "..", "node_modules", ".bin", "tsx"), path.join(serverDir, "node_modules", ".bin", "tsx")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`demo market publish: tsx not found (looked in ${candidates.join(", ")})`);
  return found;
}

/** Runs the publish script in a child process bound to a fresh scratch DB; resolves with its whole output. */
function runPublishScript(): Promise<{ code: number | null; output: string }> {
  for (const f of [SCRATCH_DB, `${SCRATCH_DB}-wal`, `${SCRATCH_DB}-shm`]) fs.rmSync(f, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBinary(), [path.join(serverDir, "scripts", "publish-demo-market.ts"), "--upload"], {
      cwd: serverDir,
      env: {
        ...process.env,
        NW_TRACKER_TEST_DB: SCRATCH_DB,
        // The child is a script, not a second server: no schedulers, no demo profile.
        BACKGROUND_JOBS_ENABLED: "0",
        DEMO_MODE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += `\n(killed after ${PUBLISH_TIMEOUT_MS / 60_000} min)\n`;
      child.kill("SIGTERM");
    }, PUBLISH_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function tail(output: string, lines: number): string {
  return output.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

async function publishOnce(): Promise<KernelRunResult> {
  const state = readDemoMarketPublishState();
  const startedAt = new Date().toISOString();
  let outcome: DemoMarketPublishOutcome | null = null;
  let error: string | null = null;
  let output = "";
  try {
    const r = await runPublishScript();
    output = r.output;
    if (r.code !== 0) error = `the publish script exited ${r.code}`;
    else {
      outcome = parseDemoMarketPublishOutcome(r.output);
      if (!outcome.uploaded) error = "the publish script did not upload";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error != null || outcome == null) {
    writeState({ ...state, last_attempt_at: startedAt, last_error: error });
    console.error(`demo-market-publish: failed — ${error}`);
    insertAppMessage(
      "notification",
      FAILURE_TITLE,
      `${error}\nLast published: ${state.last_success_at ?? "never"} (complete through ${state.last_complete_through ?? "—"}). ` +
        `The Render build refuses an asset older than a few days.\n\n${tail(output, 40)}`
    );
    return "failed";
  }
  writeState({ last_success_at: new Date().toISOString(), last_complete_through: outcome.complete_through, last_attempt_at: startedAt, last_error: null });
  const mib = (outcome.bytes / 1024 / 1024).toFixed(2);
  console.log(`demo-market-publish: complete through ${outcome.complete_through}, ${mib} MiB → ${outcome.url}`);
  insertAppMessage("log", SUCCESS_TITLE, `Complete through ${outcome.complete_through}, ${mib} MiB, uploaded to ${outcome.url}.`);
  return "ok";
}

let started = false;
const publishJob = new ScheduledJob({
  name: "demo-market-publish",
  enabled: () => serverConfig().demoMarketPublish && demoMarketPublishToken() != null,
  next: (nowMs) => {
    if (!started) {
      started = true;
      return firstDemoMarketPublishMs(nowMs, readDemoMarketPublishState().last_success_at);
    }
    return nextNightlyDemoMarketPublishMs(nowMs);
  },
  run: publishOnce,
  wake: () => ({ wakeGapMs: 5 * 60_000, networkGraceMs: 10_000 }),
  retry: { delaysMs: RETRY_DELAYS_MS, when: "always", retryThrown: true },
});

export function startDemoMarketPublishJob(): void {
  if (publishJob.isEnabled) return;
  if (!serverConfig().demoMarketPublish) return;
  if (demoMarketPublishToken() == null) {
    console.log("demo-market-publish: not configured (set DEMO_MARKET_PUBLISH_TOKEN to publish the demo's market data)");
    return;
  }
  publishJob.start();
}
