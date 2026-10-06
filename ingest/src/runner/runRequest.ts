import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IngestRunCompletion, IngestRunRequest, SantanderState } from "nw-tracker-contracts";
import { resolveCfraserDir, resolveRepoRoot } from "../paths.js";
import { lastRunAt } from "../runGuard.js";
import {
  lastCatchUpAt,
  lastPaydayAttemptYmd,
  lastSuccessfulSantanderFetchAt,
  recordCatchUpAttempt,
  recordPaydayAttempt,
} from "../santander/catchUp.js";
import { runHourly } from "./hourly.js";
import { runNightly } from "./nightly.js";
import { logStamp, processStepRunner, type StepRunner } from "./steps.js";

/**
 * One run the server asked for, end to end: the log file, the runner, the facts the report
 * carries. Replaces spawning `daily-run.sh` / `email-run.sh`, which stay only as the timed
 * LaunchAgents' fallback (`ingest/switch-schedule.sh to-launchd`).
 */

/** The bank was tried this recently: a fetch now would hit the scraper's own 30-minute guard. */
export const SANTANDER_MIN_GAP_MINUTES = 35;

const LOG_BY_KIND = { nightly: "daily-run.log", hourly: "email-run.log" } as const;
/** The hourly log rotates at 5 MB (24 runs a day), one generation kept — as email-run.sh did. */
const HOURLY_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function loginLatchFile(): string {
  return path.join(resolveCfraserDir(), ".santander-login-rejected.json");
}

/** The bank facts the server decides the next catch-up / payday fetch from. */
export function readSantanderState(): SantanderState {
  return {
    last_attempt_at: lastRunAt("santander")?.toISOString() ?? null,
    last_success_at: lastSuccessfulSantanderFetchAt()?.toISOString() ?? null,
    login_latched: fs.existsSync(loginLatchFile()),
    last_catch_up_attempt_at: lastCatchUpAt()?.toISOString() ?? null,
    last_payday_attempt_ymd: lastPaydayAttemptYmd(),
  };
}

/** Why a requested bank fetch must not run now, or null. */
export function santanderVeto(state: SantanderState, now: Date = new Date()): string | null {
  if (state.login_latched) return "login latched off after a credentials rejection";
  if (state.last_attempt_at) {
    const minutes = (now.getTime() - Date.parse(state.last_attempt_at)) / 60_000;
    if (minutes < SANTANDER_MIN_GAP_MINUTES) {
      return `last attempt ${Math.floor(minutes)} min ago — waiting ${SANTANDER_MIN_GAP_MINUTES} min`;
    }
  }
  return null;
}

function racionalNeeded(): boolean {
  const decision = path.join(resolveCfraserDir(), ".broker-email-decision.json");
  return fs.existsSync(decision) && fs.readFileSync(decision, "utf8").includes('"racional"');
}

function groceryInboxCount(): number {
  const dir = path.join(resolveCfraserDir(), "grocery-receipts", "inbox");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith(".")).length;
}

function openRunLog(kind: IngestRunRequest["kind"]): number {
  const file = path.join(resolveCfraserDir(), LOG_BY_KIND[kind]);
  if (kind === "hourly" && fs.existsSync(file) && fs.statSync(file).size > HOURLY_LOG_ROTATE_BYTES) {
    fs.renameSync(file, `${file}.1`);
  }
  return fs.openSync(file, "a");
}

function notifyNightlyFailure(failed: number): void {
  // A desktop alert, as daily-run.sh raised; harmless where osascript is missing.
  spawnSync("osascript", [
    "-e",
    `display notification "${failed} step(s) failed — see the app or cfraser/daily-run.log" with title "nw-tracker daily run failed"`,
  ]);
}

export async function runRequestedRun(
  request: IngestRunRequest,
  deps: { makeRunner?: (logFd: number) => StepRunner } = {}
): Promise<IngestRunCompletion> {
  const dryRun = envFlag("INGEST_RUN_DRY");
  const logFd = openRunLog(request.kind);
  const x = deps.makeRunner?.(logFd) ?? processStepRunner({ cwd: resolveRepoRoot(), logFd });
  const startedAt = new Date().toISOString();
  try {
    x.note(`${request.kind} run ${request.run_id} starting (${request.reason}; dry-run=${dryRun ? 1 : 0})`);
    const shared = { dryRun, fintualApply: envFlag("NW_TRACKER_FINTUAL_APPLY"), racionalApply: envFlag("NW_TRACKER_RACIONAL_APPLY") };
    const result =
      request.kind === "nightly"
        ? {
            ...(await runNightly(x, {
              ...shared,
              statementJsonApply: envFlag("NW_TRACKER_STATEMENT_JSON_APPLY"),
              fullReimport: envFlag("NW_TRACKER_FULL_REIMPORT"),
              racionalNeeded,
              afpUnoFetch: request.afp_uno_fetch,
              afpUnoApply: envFlag("NW_TRACKER_AFP_UNO_APPLY"),
              payslips: request.payslips,
            })),
            activity: false,
          }
        : await runHourly(x, {
            ...shared,
            santanderFetch: request.santander_fetch,
            santanderVeto: () => santanderVeto(readSantanderState()),
            // The shell fallback's markers too, so a switch back to launchd sees this attempt.
            onSantanderAttempt: (mode) => (mode === "catch-up" ? recordCatchUpAttempt() : recordPaydayAttempt()),
            groceryInboxCount,
          });
    const failed = x.steps.filter((s) => !s.ok).length;
    x.note(`${request.kind} run ${request.run_id} finished with ${failed} failed step(s)`);
    if (request.kind === "nightly" && failed > 0 && !dryRun) notifyNightlyFailure(failed);
    return {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: failed,
      steps: x.steps,
      dry_run: dryRun,
      activity: result.activity,
      santander: result.santander,
      santander_state: readSantanderState(),
    };
  } catch (err) {
    fs.writeSync(logFd, `${logStamp()} *** run crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: 70,
      steps: [...x.steps, { label: "runner crashed", ok: false, seconds: 0 }],
      dry_run: dryRun,
      activity: false,
      santander: null,
      santander_state: readSantanderState(),
    };
  } finally {
    fs.closeSync(logFd);
  }
}
