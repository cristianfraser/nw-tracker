/**
 * MetLife Hipotecario's «Portal de Clientes» — a supervised capture only, until the reader is
 * built from what it records:
 *
 *   npm run fetch:metlife -- --capture [--code-from-stdin] [--minutes=N] [--force] [--min-interval=N]
 *
 * Signs in with the RUT from `cfraser/metlife-fetch.json`, the clave from Keychain
 * `nw-tracker-metlife` (account = that RUT) and the «Clave Dinámica» MetLife mails (read from the
 * mailbox; `--code-from-stdin` types it instead), then records under `cfraser/metlife-captures/`.
 */
import { runMetlifeCapture } from "./capture.js";
import { DEFAULT_MIN_INTERVAL_MINUTES } from "../runGuard.js";
import { log } from "../log.js";

const FORCED_EXIT_GRACE_MS = 10_000;

// A run killed mid-wait (the mailbox poll, the capture loop) must end: Playwright's own SIGTERM
// handler closes the browser but can leave the process alive.
process.on("SIGTERM", () => process.exit(143));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const min = Number(argv.find((a) => a.startsWith("--min-interval="))?.split("=")[1]);
  const minIntervalMinutes = Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN_INTERVAL_MINUTES;
  const minutesRaw = Number(argv.find((a) => a.startsWith("--minutes="))?.split("=")[1]);
  return runMetlifeCapture(
    {
      capture: argv.includes("--capture"),
      background: argv.includes("--background"),
      movementsOnly: false,
      balancePoll: false,
      minIntervalMinutes,
      force: argv.includes("--force"),
      only: [],
    },
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
