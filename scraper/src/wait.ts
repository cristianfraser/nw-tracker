import path from "node:path";
import type { Page } from "playwright-core";
import type { Recorder } from "./capture.js";
import { ensureDir } from "./paths.js";
import { log } from "./log.js";

/** Let the SPA settle after a route change. A busy network is normal here, so a timeout is not an error. */
export async function settle(page: Page, timeoutMs = 8_000): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    log("(network still busy — continuing)");
  }
}

/** Block until the recorder sees more calls for `endpoint` than `baselineCount`. */
export async function waitForNewApiCalls(
  recorder: Recorder,
  endpoint: string,
  baselineCount: number,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (recorder.callsFor(endpoint).length > baselineCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Run `trigger` and save the resulting download.
 *
 * The bank's own filename is preserved on purpose: `import:cfraser-inbox` identifies documents by
 * it (`80_<seq>_<account>_YYYYMMDD.pdf` = card statement, `1_…_CC.pdf` = cuenta corriente cartola).
 * Renaming here would silently break the downstream organizer.
 */
export async function downloadTo(
  page: Page,
  destDir: string,
  trigger: () => Promise<void>,
  timeoutMs = 90_000,
): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: timeoutMs }), trigger()]);
  const dest = path.join(ensureDir(destDir), download.suggestedFilename());
  await download.saveAs(dest);
  log(`saved ${path.basename(dest)}`);
  return dest;
}
