/**
 * MetLife Hipotecario's «Portal de Clientes»:
 *
 *   npm run fetch:metlife -- --read [--dry-run] [--from-capture=<dir>] [--code-from-stdin] [--force] [--min-interval=N]
 *   npm run fetch:metlife -- --capture [--code-from-stdin] [--minutes=N] [--force] [--min-interval=N]
 *
 * `--read` signs in (RUT from `cfraser/metlife-fetch.json`, clave from Keychain
 * `nw-tracker-metlife`, the mailed «Clave Dinámica»), takes the «Centro de pago» page's own API
 * answers and sends them as a `mortgage.lender_statement` (`./read.ts`); `--from-capture=<dir>`
 * sends a saved directory's answers instead of logging in; `--dry-run` asks the server to roll
 * back what it would write. `--capture` is the supervised capture (`./capture.ts`).
 */
import { runMetlifeCapture } from "./capture.js";
import { runMetlifeRead } from "./read.js";
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
  const read = argv.includes("--read");
  const capture = argv.includes("--capture");
  if (read === capture) throw new Error("fetch:metlife takes exactly one of --read and --capture");
  if (read) {
    const fromCapture = argv.find((a) => a.startsWith("--from-capture="))?.slice("--from-capture=".length) ?? null;
    if (fromCapture === "") throw new Error("--from-capture= needs a directory");
    return runMetlifeRead({
      fromCapture,
      dryRun: argv.includes("--dry-run"),
      force: argv.includes("--force"),
      minIntervalMinutes,
      codeFromStdin: argv.includes("--code-from-stdin"),
      background: argv.includes("--background"),
    });
  }
  const minutesRaw = Number(argv.find((a) => a.startsWith("--minutes="))?.split("=")[1]);
  return runMetlifeCapture(
    {
      capture: true,
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
