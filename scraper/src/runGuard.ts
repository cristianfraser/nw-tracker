import fs from "node:fs";
import path from "node:path";
import { ensureDir, resolveCfraserDir } from "./paths.js";
import type { BankName } from "./config.js";
import { log } from "./log.js";

/**
 * Minimum gap between runs against the same bank.
 *
 * The intended pattern is one crawl a day — no more traffic than checking the site by hand. What
 * actually drew attention was a burst of development runs in one hour, so the guard exists to make
 * that pattern take deliberate effort rather than happen by reflex.
 */
export const DEFAULT_MIN_INTERVAL_MINUTES = 30;

type RunState = Partial<Record<BankName, string>>;

function stateFile(): string {
  return path.join(ensureDir(resolveCfraserDir()), ".scraper-run-state.json");
}

function readState(): RunState {
  const file = stateFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
  } catch {
    // A corrupt state file must not block a legitimate run; treat it as "no history".
    return {};
  }
}

export function lastRunAt(bank: BankName): Date | null {
  const raw = readState()[bank];
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Throw unless enough time has passed since the last run against this bank.
 *
 * Recorded on attempt rather than on success: a failed run still sent traffic, and repeated retries
 * are exactly what the guard is meant to slow down. `--force` bypasses it and says so in the log.
 */
export function assertRunAllowed(bank: BankName, minIntervalMinutes: number, force: boolean): void {
  const previous = lastRunAt(bank);
  if (previous) {
    const elapsedMinutes = (Date.now() - previous.getTime()) / 60_000;
    if (elapsedMinutes < minIntervalMinutes) {
      const waitMinutes = Math.ceil(minIntervalMinutes - elapsedMinutes);
      if (!force) {
        throw new Error(
          `Last ${bank} run was ${Math.floor(elapsedMinutes)} min ago; minimum gap is ` +
            `${minIntervalMinutes} min. Wait ${waitMinutes} min, pass --force to override, ` +
            `or --min-interval=<minutes> to change the limit.`,
        );
      }
      log(`--force: running ${Math.floor(elapsedMinutes)} min after the previous ${bank} run`);
    }
  }
  recordRun(bank);
}

function recordRun(bank: BankName): void {
  const state = readState();
  state[bank] = new Date().toISOString();
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}
