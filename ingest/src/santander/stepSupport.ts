import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { log } from "../log.js";

/** Playwright's wording when the page, context or browser process is gone (crash included). */
export const BROWSER_GONE_PATTERN = /Target page, context or browser has been closed|Target crashed|Browser closed|browser has been closed/i;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether an error means the browser itself is gone — the run's relaunch logic must see those. */
export function browserGoneError(page: Page, err: unknown): boolean {
  return page.isClosed() || BROWSER_GONE_PATTERN.test(errorMessage(err));
}

/**
 * What a failed step leaves behind: a screenshot and the page's visible text under
 * `cfraser/scraper-diagnostics/`, as a failed login does. The window is parked off-screen, so the
 * error alone («element is not visible», 2026-10-02 checking movements) says nothing about what
 * the bank showed. Never throws: a diagnostic must not replace the step's own error.
 */
export async function saveStepDiagnostics(page: Page, stepName: string, reason: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), `santander-${stepName}-${stamp}`);
    const pageText = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch((err: unknown) => `(page unreadable: ${errorMessage(err)})`);
    fs.writeFileSync(`${base}.txt`, [`reason: ${reason}`, `url: ${page.url()}`, "", "--- page text ---", pageText, ""].join("\n"));
    await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 10_000 });
    log(`  diagnostics: ${base}.png / .txt`);
  } catch (err) {
    log(`  (step diagnostics failed: ${errorMessage(err)})`);
  }
}
