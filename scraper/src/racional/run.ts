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
import { resolveCfraserDir } from "../paths.js";
import type { RunOptions, StepResult } from "../runTypes.js";

/**
 * Last movement the importer recorded (`cfraser/.racional-import-state.json`).
 *
 * A plain file rather than a DB read on purpose: the scraper is deliberately not an npm
 * workspace, so it cannot import the server — the file is the contract between the two.
 */
function readRacionalWatermark(): string | null {
  const file = path.join(resolveCfraserDir(), ".racional-import-state.json");
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { last_movement_id?: string };
    return state.last_movement_id ?? null;
  } catch {
    return null;
  }
}

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
  assertRunAllowed("racional", opts.minIntervalMinutes, opts.force);
  const config = loadBankConfig("racional");
  const password = readKeychainSecret(config.keychain_service, config.loginAccount);
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

    // The importer's watermark: crawl only back to the last movement already in the ledger.
    await step(results, "movements", opts.only, "movements", () =>
      openMovements(page, recorder, readRacionalWatermark()),
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
  const movements = takeScrapedMovements();
  if (movements.length > 0) {
    const movFile = path.join(outDir, `movements-${stamp}.json`);
    fs.writeFileSync(movFile, JSON.stringify(movements, null, 2));
    log(`${movements.length} movement row(s) → ${movFile}`);
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
