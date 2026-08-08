import fs from "node:fs";
import path from "node:path";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { launchBrowser, firstPage } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { ensureDir, resolveInboxDir, resolveMovementsDir } from "../paths.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps, shouldRunStep } from "../steps.js";
import { setForceRefetch } from "../documentLedger.js";
import { login } from "./login.js";
import { captureBothCurrencies, downloadStatement, openMovements } from "./steps.js";
import type { RunOptions, StepResult } from "../runTypes.js";

/** One pass over Lider BCI. Steps are independent: a broken statement page keeps the movements. */
export async function runLider(opts: RunOptions): Promise<number> {
  assertValidSteps("lider", opts.only);
  setForceRefetch(opts.force);
  assertRunAllowed("lider", opts.minIntervalMinutes, opts.force);
  const config = loadBankConfig("lider");
  const password = readKeychainSecret(config.keychain_service, config.rut);
  const stamp = runStampNow();
  // No host fragment: this bank's API hosts are unknown, so record every XHR/fetch.
  const recorder = new Recorder(opts.capture, stamp, "lider");
  const destDir = opts.capture
    ? ensureDir(path.join(recorder.captureDir ?? "", "downloads"))
    : resolveInboxDir();
  log(opts.capture ? `CAPTURE run — nothing goes to the inbox (${recorder.captureDir})` : `downloads → ${destDir}`);

  const context = await launchBrowser({ bank: "lider", headless: false, background: opts.background });
  const results: StepResult[] = [];
  try {
    const page = await firstPage(context);
    recorder.attach(page);
    await login(page, config.rut, password);

    await step(results, "movements", opts.only, "movements", async () => {
      await openMovements(page, recorder);
      const tabs = await captureBothCurrencies(page, recorder);
      const outDir = ensureDir(opts.capture ? (recorder.captureDir ?? destDir) : resolveMovementsDir("lider"));
      const outFile = path.join(outDir, `api-calls-${stamp}.json`);
      fs.writeFileSync(outFile, JSON.stringify(recorder.calls, null, 2));
      return `tabs: ${tabs.join(", ") || "none"} · ${recorder.calls.length} API calls → ${path.basename(outFile)}`;
    });

    if (!opts.movementsOnly) {
      await step(results, "statement", opts.only, "statement", async () =>
        path.basename(await downloadStatement(page, recorder, destDir)),
      );
    }
  } finally {
    await context.close();
  }

  log("");
  log("Summary:");
  for (const result of results) log(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  const summaryDir = recorder.captureDir ?? resolveMovementsDir("lider");
  fs.writeFileSync(
    path.join(ensureDir(summaryDir), `run-summary-${stamp}.json`),
    JSON.stringify({ stamp, bank: "lider", capture: opts.capture, results }, null, 2),
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
