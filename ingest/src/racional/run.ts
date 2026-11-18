import fs from "node:fs";
import path from "node:path";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { launchBrowser, firstPage } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { ensureDir, resolveMovementsDir } from "../paths.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps, shouldRunStep } from "../steps.js";
import { setForceRefetch } from "../documentLedger.js";
import { login } from "./login.js";
import { openHome, openMovements, openPositions, takeScrapedMovements } from "./steps.js";
import { readRacionalCrawlCursor } from "./crawlCursor.js";
import type { RunOptions, StepResult } from "../runTypes.js";

/**
 * One pass over Racional. Steps are independent: a broken positions view keeps the movements.
 *
 * A new session needs a person: since the 2026-11 rebuild Racional follows the password with a
 * passkey («Confirma que eres tú»), so the first run on a machine (or after the session expires)
 * is a supervised `--capture` run that someone confirms at the screen; «Mantener sesión» keeps
 * the session for the scheduled runs after it.
 */
export async function runRacional(opts: RunOptions): Promise<number> {
  assertValidSteps("racional", opts.only);
  setForceRefetch(opts.force);
  // Config and Keychain first: a setup error is not a run and must not start the guard's clock.
  const config = loadBankConfig("racional");
  const password = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed("racional", opts.minIntervalMinutes, opts.force);
  const stamp = runStampNow();
  // No host fragment: the API hosts are unconfirmed, so record every xhr/fetch and let the
  // third-party noise filter drop the telemetry.
  const recorder = new Recorder(opts.capture, stamp, "racional");
  // The sign-in request carries the password, and every run keeps its recorded calls.
  recorder.redactSecrets([password]);

  const context = await launchBrowser({ bank: "racional", headless: false, background: opts.background });
  const results: StepResult[] = [];
  try {
    const page = await firstPage(context);
    recorder.attach(page);
    await login(page, config.loginAccount, password);
    await openHome(page, recorder);

    // The crawl cursor: read only back to the first row of the last read the server applied.
    await step(results, "movements", opts.only, "movements", () =>
      openMovements(page, recorder, readRacionalCrawlCursor()?.last_row_key ?? null),
    );
    await step(results, "positions", opts.only, "positions", () => openPositions(page, recorder));
  } finally {
    await context.close();
  }

  const outDir = ensureDir(recorder.captureDir ?? resolveMovementsDir("racional"));
  const outFile = path.join(outDir, `api-calls-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(recorder.calls, null, 2));
  log(`${recorder.calls.length} API call(s) → ${outFile}`);

  // Movements are read from the app's own answers (`appData.ts`). Staged whenever the movements step succeeded — an empty list on a quiet night too: it is the
  // server's evidence that this crawl read the list, which is what answers the e-mail nudges
  // mailed before it (`broker_read_coverage`). A failed step stages nothing.
  if (results.find((r) => r.name === "movements")?.ok) {
    const movements = takeScrapedMovements();
    const movFile = path.join(outDir, `movements-${stamp}.json`);
    fs.writeFileSync(movFile, JSON.stringify(movements, null, 2));
    log(`${movements.length} movement row(s) → ${movFile}`);
  }

  // No `dividends-<stamp>.json` any more: the rebuilt app has no dividends list call, and each
  // new dividend row carries its own breakdown from its detail answer.

  log("");
  log("Summary:");
  for (const result of results) log(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  fs.writeFileSync(
    path.join(outDir, `run-summary-${stamp}.json`),
    JSON.stringify({ stamp, bank: "racional", capture: opts.capture, results }, null, 2),
  );
  return results.some((r) => !r.ok) ? 1 : 0;
}

async function step(
  results: StepResult[],
  name: string,
  only: string[],
  stepName: string,
  run: () => Promise<string>,
): Promise<void> {
  if (!shouldRunStep(only, stepName)) return;
  try {
    results.push({ name, ok: true, detail: await run() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`✗ ${name}: ${detail}`);
    results.push({ name, ok: false, detail, stack: err instanceof Error ? err.stack : undefined });
  }
}
