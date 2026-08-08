import fs from "node:fs";
import path from "node:path";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { launchBrowser, firstPage } from "../browser.js";
import { API_HOST_FRAGMENT, Recorder, runStampNow } from "../capture.js";
import { ensureDir, resolveInboxDir, resolveMovementsDir, resolveStatementJsonDir } from "../paths.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { setForceRefetch } from "../documentLedger.js";
import { assertValidSteps, shouldRunStep } from "../steps.js";
import type { RunOptions, StepResult } from "../runTypes.js";
import { login } from "./login.js";
import { fetchCardMovements, fetchCardStatements } from "./cards.js";
import { fetchCheckingMovements } from "./checking.js";


/**
 * One nightly pass over Santander.
 *
 * Steps are independent: a statement page that changed shape must not cost us the day's movements,
 * so each step reports its own outcome and the run exits non-zero if any of them failed.
 */
export async function runSantander(opts: RunOptions): Promise<number> {
  assertValidSteps("santander", opts.only);
  setForceRefetch(opts.force);
  assertRunAllowed("santander", opts.minIntervalMinutes, opts.force);
  const config = loadBankConfig("santander");
  const password = readKeychainSecret(config.keychain_service, config.rut);
  const stamp = runStampNow();
  const recorder = new Recorder(opts.capture, stamp, "santander", API_HOST_FRAGMENT);
  const destDir = opts.capture ? ensureDir(path.join(recorder.captureDir ?? "", "downloads")) : resolveInboxDir();
  log(opts.capture ? `CAPTURE run — nothing goes to the inbox (${recorder.captureDir})` : `downloads → ${destDir}`);

  const context = await launchBrowser({ bank: "santander", headless: false, background: opts.background });
  const results: StepResult[] = [];
  try {
    const page = await firstPage(context);
    recorder.attach(page);
    await login(page, config.rut, password);

    await step(results, "card movements", opts.only, "card-movements", async () => {
      const movements = await fetchCardMovements(page, recorder);
      const outDir = ensureDir(opts.capture ? (recorder.captureDir ?? destDir) : resolveMovementsDir("santander"));
      const outFile = path.join(outDir, `card-movements-${stamp}.json`);
      fs.writeFileSync(outFile, JSON.stringify(movements, null, 2));
      const total = movements.slides.reduce((sum, s) => sum + s.rows.length, 0);
      return `${movements.slides.length} slides, ${total} movements → ${path.basename(outFile)}`;
    });

    await step(results, "checking movements", opts.only, "checking-movements", async () => {
      const file = await fetchCheckingMovements(page, recorder, destDir);
      return path.basename(file);
    });

    if (!opts.movementsOnly) {
      await step(results, "card statements", opts.only, "card-statements", async () => {
        const jsonDir = opts.capture ? (recorder.captureDir ?? destDir) : resolveStatementJsonDir("santander");
        const downloads = await fetchCardStatements(page, recorder, destDir, jsonDir);
        if (downloads.length === 0) return "no statement available";
        return downloads.map((d) => `${d.billingMonth ?? "?"} → ${path.basename(d.file)}`).join(", ");
      });
    }
  } finally {
    await context.close();
  }

  log("");
  log("Summary:");
  for (const result of results) log(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  // Persist the summary next to the captures: a step that failed is otherwise only visible in the
  // terminal scrollback, which is exactly what you no longer have when diagnosing a scheduled run.
  const summaryDir = recorder.captureDir ?? resolveMovementsDir("santander");
  fs.writeFileSync(
    path.join(ensureDir(summaryDir), `run-summary-${stamp}.json`),
    JSON.stringify({ stamp, capture: opts.capture, results }, null, 2),
  );
  if (!opts.capture && failed === 0) {
    log("");
    log("Next: npm run import:cfraser-inbox");
  }
  return failed === 0 ? 0 : 1;
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
    const detail = await run();
    results.push({ name, ok: true, detail });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`✗ ${name}: ${detail}`);
    results.push({ name, ok: false, detail, stack: err instanceof Error ? err.stack : undefined });
  }
}
