import fs from "node:fs";
import path from "node:path";
import {
  LIDER_MIN_GAP_AFTER_ATTEMPT_MINUTES,
  LIDER_TURNSTILE_LATCH_HOURS,
  type LiderFetchOutcome,
  type LiderLatch,
  type LiderState,
} from "nw-tracker-contracts";
import { ensureDir, resolveCfraserDir, writeFileAtomic } from "../paths.js";
import { ingest, type StepRunner } from "./steps.js";

/**
 * Lider BCI's card site in the runs: the fetch (`fetch:lider-bci`, which stages the open-cycle
 * listing), the import (`import:lider-movements`, sent as `card.unbilled_movements`) and the
 * facts the server decides the next hourly read from (`LiderState`).
 *
 * The fetcher writes its own latches: `.lider-login-rejected.json` (the clave was refused; the
 * bank blocks it after three failures, so it stands until the clave is replaced — only the
 * fetcher clears it) and `.lider-turnstile-failed.json` (Cloudflare's check did not pass; the
 * fetcher refuses for 20 h unless `--retry-turnstile` or `--force`). A latch file older than the last successful fetch
 * no longer stands. The runner keeps when it last tried and last succeeded in
 * `.lider-runner-state.json`.
 */

/** `fetch:lider-bci`'s exit status when Cloudflare's Turnstile did not pass. */
export const LIDER_TURNSTILE_EXIT_CODE = 3;

const LOGIN_REJECTED_FILE = ".lider-login-rejected.json";
const TURNSTILE_FILE = ".lider-turnstile-failed.json";
const RUNNER_STATE_FILE = ".lider-runner-state.json";

type RunnerState = { last_attempt_at: string | null; last_success_at: string | null };

function runnerStateFile(cfraserDir: string): string {
  return path.join(cfraserDir, RUNNER_STATE_FILE);
}

function readRunnerState(cfraserDir: string): RunnerState {
  const file = runnerStateFile(cfraserDir);
  if (!fs.existsSync(file)) return { last_attempt_at: null, last_success_at: null };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RunnerState>;
  return { last_attempt_at: parsed.last_attempt_at ?? null, last_success_at: parsed.last_success_at ?? null };
}

function latchWrittenAt(cfraserDir: string, name: string): Date | null {
  const file = path.join(cfraserDir, name);
  return fs.existsSync(file) ? fs.statSync(file).mtime : null;
}

/** The Lider facts the run report carries. */
export function readLiderState(now: Date = new Date(), cfraserDir: string = resolveCfraserDir()): LiderState {
  const state = readRunnerState(cfraserDir);
  const lastSuccess = state.last_success_at ? Date.parse(state.last_success_at) : null;
  const stands = (at: Date | null) => at != null && (lastSuccess == null || at.getTime() > lastSuccess);
  const rejected = latchWrittenAt(cfraserDir, LOGIN_REJECTED_FILE);
  const turnstile = latchWrittenAt(cfraserDir, TURNSTILE_FILE);
  let latched: LiderLatch | null = null;
  if (stands(rejected)) latched = "login_rejected";
  else if (stands(turnstile) && now.getTime() - turnstile!.getTime() < LIDER_TURNSTILE_LATCH_HOURS * 3_600_000) latched = "turnstile";
  return { ...state, latched };
}

/** Record a fetch the runner made (a vetoed one is no attempt). */
export function recordLiderFetch(
  outcome: LiderFetchOutcome | null,
  at: Date = new Date(),
  cfraserDir: string = resolveCfraserDir()
): void {
  if (outcome == null || outcome.outcome === "vetoed") return;
  const state = readRunnerState(cfraserDir);
  state.last_attempt_at = at.toISOString();
  if (outcome.outcome === "ok") state.last_success_at = at.toISOString();
  writeFileAtomic(runnerStateFile(ensureDir(cfraserDir)), JSON.stringify(state, null, 2));
}

/** Why a requested hourly read must not run now, or null. */
export function liderVeto(state: LiderState, now: Date = new Date()): string | null {
  if (state.latched === "login_rejected") return "login latched off after the clave was rejected";
  if (state.latched === "turnstile") return `Turnstile failed less than ${LIDER_TURNSTILE_LATCH_HOURS} h ago`;
  if (state.last_attempt_at) {
    const minutes = (now.getTime() - Date.parse(state.last_attempt_at)) / 60_000;
    if (minutes < LIDER_MIN_GAP_AFTER_ATTEMPT_MINUTES) {
      return `last attempt ${Math.floor(minutes)} min ago — waiting ${LIDER_MIN_GAP_AFTER_ATTEMPT_MINUTES} min`;
    }
  }
  return null;
}

/**
 * Fetch Lider BCI's listing and import what is staged. The nightly passes `--retry-turnstile`, which retries
 * past the Turnstile latch once a day (never past a rejected clave: the fetcher refuses that one
 * whatever the flag). The import runs even when the fetch failed: it sends whatever an earlier
 * fetch left staged. Returns the fetch's outcome and the rows the import wrote.
 */
export async function runLiderFetchAndImport(
  x: StepRunner,
  mode: LiderFetchOutcome["mode"],
  opts: { dryRun: boolean }
): Promise<{ outcome: LiderFetchOutcome | null; inserted: number }> {
  if (opts.dryRun) {
    x.note("=== (dry run) skipping fetch:lider-bci");
    await x.step("Lider BCI movements (dry run)", ingest("import:lider-movements", "--dry-run"));
    return { outcome: null, inserted: 0 };
  }
  const fetched =
    mode === "nightly"
      ? await x.step("fetch Lider BCI", ingest("fetch:lider-bci", "--retry-turnstile"))
      : await x.step("fetch Lider BCI (hourly)", ingest("fetch:lider-bci"));
  const outcome: LiderFetchOutcome = fetched.ok
    ? { mode, outcome: "ok", note: null }
    : fetched.code === LIDER_TURNSTILE_EXIT_CODE
      ? { mode, outcome: "turnstile", note: "Cloudflare Turnstile did not pass" }
      : { mode, outcome: "failed", note: `exit ${fetched.code}` };
  const imported = await x.step(mode === "nightly" ? "Lider BCI movements" : "Lider BCI movements (hourly)", ingest("import:lider-movements"));
  return { outcome, inserted: imported.result.inserted ?? 0 };
}
