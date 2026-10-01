import { runSantander } from "./santander/run.js";
import { runRacional } from "./racional/run.js";
import { runAfpUnoCapture } from "./afpUno/capture.js";
import type { BankName } from "./config.js";
import type { RunOptions } from "./runTypes.js";
import fs from "node:fs";
import { DEFAULT_MIN_INTERVAL_MINUTES } from "./runGuard.js";
import { log } from "./log.js";

/**
 * How long the process may linger after the run is over before it is exited by force.
 *
 * Playwright keeps the event loop alive for as long as a browser is connected, so a context that
 * escaped its close — a login that threw before the session's try/finally (2026-09-11) — turns a
 * reported failure into a process that never exits. In the unattended pipeline that is worse than any
 * failure: `daily-run.sh` waits on the step forever and the hourly poll skips itself behind it. A
 * clean run exits on its own the moment the loop is empty (the timer is unref'd); only a leak reaches
 * the forced exit, and it is logged so the leak stays visible.
 */
const FORCED_EXIT_GRACE_MS = 10_000;

const USAGE = `Usage: npm run fetch -- <santander|racional|afp-uno> [options]

Options:
  --capture          Save every API request/response + screenshots; keep downloads out of the inbox.
                     Use this for the first (supervised) run of a bank.
  --background       Park the Chrome window off-screen — the run is invisible but not headless.
                     Use this for scheduled runs; true headless is blocked by Santander.
  --movements-only   Skip statement and cartola downloads.
  --only=a,b         Run only these steps, so a re-test costs no extra requests.
                     santander: card-movements, checking-movements, card-statements, cartola
                     racional:  movements, positions
                     afp-uno:   capture (supervised: --capture, no --background);
                                the nightly read is npm run fetch:afp-uno
  --min-interval=N   Minimum minutes since the last run of this bank (default 30).
  --force            Run despite the interval, and re-fetch documents already recorded.
`;

const RUNNERS: Record<BankName, (opts: RunOptions) => Promise<number>> = {
  santander: runSantander,
  racional: runRacional,
  "afp-uno": runAfpUnoCapture,
};

/** Read `--flag=a,b` into a trimmed list; empty when the flag is absent. */
function listFlag(argv: string[], name: string): string[] {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? "";
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Read `--flag=value`, returning `fallback` when absent or not a number. */
function numericFlag(argv: string[], name: string, fallback: number): number {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const bank = (argv.find((a) => !a.startsWith("-")) ?? "") as BankName;
  const runner = RUNNERS[bank];
  if (!runner) {
    throw new Error(`Unknown bank "${bank}". Expected one of: ${Object.keys(RUNNERS).join(", ")}.`);
  }

  process.exitCode = await runner({
    capture: argv.includes("--capture"),
    background: argv.includes("--background"),
    movementsOnly: argv.includes("--movements-only"),
    minIntervalMinutes: numericFlag(argv, "min-interval", DEFAULT_MIN_INTERVAL_MINUTES),
    force: argv.includes("--force"),
    only: listFlag(argv, "only"),
  });
}

main()
  .catch((err: unknown) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const timer = setTimeout(() => {
      const code = process.exitCode ?? 0;
      // Written synchronously: process.exit() does not wait for a pending stderr write to a pipe.
      fs.writeSync(process.stderr.fd, `run is over but something kept the process alive — exiting with code ${code}\n`);
      process.exit(code);
    }, FORCED_EXIT_GRACE_MS);
    timer.unref();
  });
