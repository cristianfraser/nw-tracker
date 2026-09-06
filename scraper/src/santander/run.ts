import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
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
import { isLoggedIn, login } from "./login.js";
import { fetchCardMovements, fetchCardStatements } from "./cards.js";
import { fetchCheckingMovements } from "./checking.js";
import { keepSessionAlive, type SessionKeepAlive } from "./sessionKeepAlive.js";

/**
 * How many times one run may relaunch Chrome after it dies mid-session.
 *
 * Chrome 152 (installed 2026-08-31) crashed its browser process one to three minutes into the
 * session on three of the first six nights — real SIGSEGV/SIGBUS crash reports, not a site change —
 * and every remaining step then failed with "Target page, context or browser has been closed". A
 * crash is intermittent, so one relaunch recovers most nights; the persistent profile keeps the
 * bank session, so the relaunch usually skips the password login entirely. Kept at one so a
 * deterministic crash cannot turn into a burst of bank logins.
 */
const MAX_BROWSER_RELAUNCHES = 1;

type Session = { context: BrowserContext; page: Page; keepAlive: SessionKeepAlive };

/** Playwright's wording when the page, context or browser process is gone (crash included). */
const BROWSER_GONE_PATTERN = /Target page, context or browser has been closed|Target crashed|Browser closed|browser has been closed/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function browserIsGone(session: Session, err: unknown): boolean {
  return session.page.isClosed() || BROWSER_GONE_PATTERN.test(errorMessage(err));
}

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

  const openSession = async (): Promise<Session> => {
    const context = await launchBrowser({ bank: "santander", headless: false, background: opts.background });
    const page = await firstPage(context);
    recorder.attach(page);
    await login(page, config.rut, password);
    return { context, page, keepAlive: keepSessionAlive(page) };
  };

  const closeSession = async (session: Session): Promise<void> => {
    await session.keepAlive.stop();
    try {
      await session.context.close();
    } catch (err) {
      // A context whose browser already crashed may refuse to close; there is nothing left to free.
      log(`(browser context close: ${errorMessage(err).split("\n")[0]})`);
    }
  };

  let session = await openSession();
  let relaunches = 0;
  let sessionExtensions = 0;
  let sessionDead = false;
  const results: StepResult[] = [];

  /**
   * Run one named step against the live session. When the step fails because the browser is gone,
   * relaunch once and retry the same step; later steps then continue on the new session. A step
   * that fails for any other reason is recorded and the run moves on, as before.
   */
  const step = async (name: string, stepName: string, run: (page: Page) => Promise<string>): Promise<void> => {
    if (!shouldRunStep(opts.only, stepName)) return;
    if (sessionDead) {
      results.push({ name, ok: false, detail: "skipped — the browser died and could not be relaunched" });
      return;
    }
    for (;;) {
      try {
        // The inactivity prompt can still win a race with the keep-alive poll; a logged-out page
        // would otherwise fail every remaining step on selectors that no longer exist.
        if (!session.page.isClosed() && !isLoggedIn(session.page)) {
          log(`session is no longer logged in before "${name}" — logging in again`);
          await login(session.page, config.rut, password);
        }
        const detail = await run(session.page);
        results.push({ name, ok: true, detail });
        return;
      } catch (err) {
        const detail = errorMessage(err);
        log(`✗ ${name}: ${detail}`);
        const stack = err instanceof Error ? err.stack : undefined;
        if (!browserIsGone(session, err) || relaunches >= MAX_BROWSER_RELAUNCHES) {
          results.push({ name, ok: false, detail, stack });
          return;
        }
        relaunches += 1;
        log(`browser died mid-run — relaunching (${relaunches}/${MAX_BROWSER_RELAUNCHES}) and retrying "${name}"`);
        sessionExtensions += session.keepAlive.extensions;
        await closeSession(session);
        try {
          session = await openSession();
        } catch (relaunchErr) {
          sessionDead = true;
          results.push({
            name,
            ok: false,
            detail: `${detail} — relaunch failed: ${errorMessage(relaunchErr)}`,
            stack: relaunchErr instanceof Error ? relaunchErr.stack : stack,
          });
          return;
        }
      }
    }
  };

  try {
    await step("card movements", "card-movements", async (page) => {
      const movements = await fetchCardMovements(page, recorder);
      const outDir = ensureDir(opts.capture ? (recorder.captureDir ?? destDir) : resolveMovementsDir("santander"));
      const outFile = path.join(outDir, `card-movements-${stamp}.json`);
      fs.writeFileSync(outFile, JSON.stringify(movements, null, 2));
      const total = movements.slides.reduce((sum, s) => sum + s.rows.length, 0);
      return `${movements.slides.length} slides, ${total} movements → ${path.basename(outFile)}`;
    });

    await step("checking movements", "checking-movements", async (page) => {
      const file = await fetchCheckingMovements(page, recorder, destDir);
      return path.basename(file);
    });

    if (!opts.movementsOnly) {
      await step("card statements", "card-statements", async (page) => {
        const jsonDir = opts.capture ? (recorder.captureDir ?? destDir) : resolveStatementJsonDir("santander");
        const downloads = await fetchCardStatements(page, recorder, destDir, jsonDir);
        if (downloads.length === 0) return "no statement available";
        return downloads.map((d) => `${d.billingMonth ?? "?"} → ${path.basename(d.file)}`).join(", ");
      });
    }
  } finally {
    sessionExtensions += session.keepAlive.extensions;
    await closeSession(session);
  }

  log("");
  log("Summary:");
  for (const result of results) log(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  if (relaunches > 0) log(`  (browser relaunched ${relaunches}× after a crash)`);
  if (sessionExtensions > 0) log(`  (inactivity prompt answered ${sessionExtensions}×)`);
  const failed = results.filter((r) => !r.ok).length;
  // Persist the summary next to the captures: a step that failed is otherwise only visible in the
  // terminal scrollback, which is exactly what you no longer have when diagnosing a scheduled run.
  const summaryDir = recorder.captureDir ?? resolveMovementsDir("santander");
  fs.writeFileSync(
    path.join(ensureDir(summaryDir), `run-summary-${stamp}.json`),
    JSON.stringify({ stamp, capture: opts.capture, relaunches, session_extensions: sessionExtensions, results }, null, 2),
  );
  if (!opts.capture && failed === 0) {
    log("");
    log("Next: npm run import:cfraser-inbox");
  }
  return failed === 0 ? 0 : 1;
}
