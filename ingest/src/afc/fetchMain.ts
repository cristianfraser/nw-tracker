/**
 * AFC (Fondo de Cesantía) through ClaveÚnica:
 *
 *   npm run fetch:afc -- [--apply] [--background]                  # the nightly read (fetch.ts)
 *   npm run fetch:afc -- --capture [--code-from-stdin] [--minutes=N] [--force]   # a supervised capture
 */
import { runAfcCapture } from "./capture.js";
import { runAfcFetch } from "./fetch.js";
import { DEFAULT_MIN_INTERVAL_MINUTES } from "../runGuard.js";
import { log } from "../log.js";

const FORCED_EXIT_GRACE_MS = 10_000;

// A run killed mid-wait (the mailbox poll, the capture loop) must end: Playwright's own SIGTERM
// handler closes the browser but left the process alive on 2026-10-17.
process.on("SIGTERM", () => process.exit(143));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const minRaw = argv.find((a) => a.startsWith("--min-interval="))?.split("=")[1];
  const min = Number(minRaw);
  const minIntervalMinutes = Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN_INTERVAL_MINUTES;
  const force = argv.includes("--force");
  const background = argv.includes("--background");
  if (!argv.includes("--capture")) return runAfcFetch({ apply: argv.includes("--apply"), background, force, minIntervalMinutes });
  const minutesRaw = Number(argv.find((a) => a.startsWith("--minutes="))?.split("=")[1]);
  return runAfcCapture(
    { capture: true, background, movementsOnly: false, minIntervalMinutes, force, only: [] },
    { codeFromStdin: argv.includes("--code-from-stdin"), captureMinutes: Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : undefined }
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const timer = setTimeout(() => {
      log(`process still alive ${FORCED_EXIT_GRACE_MS / 1000} s after the run — forcing exit`);
      process.exit(process.exitCode ?? 1);
    }, FORCED_EXIT_GRACE_MS);
    timer.unref();
  });
