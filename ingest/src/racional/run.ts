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
import {
  openHome,
  openMovements,
  openPositions,
  rawDividendsResponseFromRecorder,
  takeScrapedMovements,
} from "./steps.js";
import { readRacionalCrawlCursor } from "./crawlCursor.js";
import type { RunOptions, StepResult } from "../runTypes.js";

/**
 * One pass over Racional. Steps are independent: a broken positions view keeps the movements.
 *
 * **The first run must be `--capture` and supervised.** Racional's endpoints and payload shapes
 * are unknown, so this run navigates and records rather than parsing; there is no importer yet
 * and nothing is written to the inbox. Build the adapter from what the capture reveals, exactly
 * as the Santander card feed was built.
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

  if (!opts.capture) {
    log(
      "NOTE: Racional has no parser yet — this run only navigates and records. " +
        "Run with --capture to keep the payloads for building one.",
    );
  }

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

  // Movements are scraped from the DOM (Firestore pushes them, so they never appear as XHR).
  // Staged whenever the movements step succeeded — an empty list on a quiet night too: it is the
  // server's evidence that this crawl read the list, which is what answers the e-mail nudges
  // mailed before it (`broker_read_coverage`). A failed step stages nothing.
  if (results.find((r) => r.name === "movements")?.ok) {
    const movements = takeScrapedMovements();
    const movFile = path.join(outDir, `movements-${stamp}.json`);
    fs.writeFileSync(movFile, JSON.stringify(movements, null, 2));
    log(`${movements.length} movement row(s) → ${movFile}`);
  }

  // The dividends API response, verbatim, on every run that made the call: the importer pairs
  // each record with its ledger row and stores the gross / withholding breakdown, which is
  // also how dividends booked before the breakdown existed get theirs. Small (every dividend
  // the account ever received, a few hundred bytes each) and idempotent on the import side.
  const dividends = rawDividendsResponseFromRecorder(recorder);
  if (dividends != null) {
    const divFile = path.join(outDir, `dividends-${stamp}.json`);
    fs.writeFileSync(divFile, JSON.stringify(dividends, null, 2));
    log(`dividends API response → ${divFile}`);
  }

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
