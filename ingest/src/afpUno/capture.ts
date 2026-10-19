import type { BrowserContext } from "playwright-core";
import { tryLogin } from "./login.js";
import { firstPage, launchBrowser } from "../browser.js";
import { Recorder, runStampNow } from "../capture.js";
import { SupervisedCaptureSession } from "../captureSession.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { assertRunAllowed } from "../runGuard.js";
import { assertValidSteps } from "../steps.js";
import type { RunOptions } from "../runTypes.js";

/**
 * AFP UNO's private site — first, SUPERVISED capture run. Nothing about the site is known yet
 * (login page, the «últimos movimientos» table, how the two certificates are generated), so this
 * run reads nothing and parses nothing: it signs in when it can find the form, then records while
 * the user clicks through by hand —
 *
 *   - every XHR/fetch call (the Recorder; the clave is redacted from anything written),
 *   - a screenshot plus the page's text and every table's cells whenever a page loads or its text
 *     changes (an SPA renders the table without a navigation),
 *   - every file the site hands over: a real download, a file the page builds itself (data:/blob:
 *     anchors, kept by browser.ts's init script), or a PDF opened in a tab.
 *
 * Everything lands in `cfraser/afp-uno-captures/<stamp>/`. The run ends when the user closes the
 * window, or after `CAPTURE_MINUTES`. The nightly fetch is built from what it shows.
 *
 * The login form is filled from `cfraser/afp-uno-fetch.json` (the RUT) and the Keychain item
 * `nw-tracker-afp-uno` (the clave). A captcha is never worked around: if the site shows one, or the
 * form is not found, the user signs in by hand in the open window.
 */

const BANK = "afp-uno" as const;
const START_URL = "https://www.uno.cl/";
const CAPTURE_MINUTES = 25;
/** How often the open pages are checked for new text (an SPA re-render) and new page-built files. */
const POLL_MS = 3_000;

export async function runAfpUnoCapture(opts: RunOptions): Promise<number> {
  assertValidSteps(BANK, opts.only);
  if (!opts.capture) {
    throw new Error("AFP UNO has no fetcher yet — run the supervised capture: npm run fetch -- afp-uno --capture");
  }
  if (opts.background) throw new Error("the AFP UNO capture is supervised — run it without --background");
  // Config and Keychain first: a setup error is not a run and must not start the guard's clock.
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const stamp = runStampNow();
  const recorder = new Recorder(true, stamp, BANK);
  recorder.redactSecrets([clave]);
  const dir = recorder.captureDir!;
  const session = new SupervisedCaptureSession(dir, recorder, [clave]);

  const context: BrowserContext = await launchBrowser({ bank: BANK, headless: false });
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  try {
    for (const p of context.pages()) session.watch(p);
    context.on("page", (p) => session.watch(p));
    const page = await firstPage(context);
    session.watch(page);
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    const filled = await tryLogin(page, config.rut, clave).catch((err: unknown) => {
      log(`sign-in form not filled (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
      return false;
    });
    log("");
    log(filled ? "Signed in automatically (check the window)." : "Could not find the sign-in form — sign in by hand in the open window.");
    log("Now, by hand, in this window:");
    log("  1. the home page with «últimos movimientos» (let it load fully)");
    log("  2. certificado «mis cotizaciones» → generate and download it");
    log("  3. certificado «movimientos» (todos los movimientos, valor en cuotas) → generate and download it");
    log(`Close the window when done (or the run ends itself after ${CAPTURE_MINUTES} min).`);
    log("");

    const deadline = Date.now() + CAPTURE_MINUTES * 60_000;
    // On macOS Chrome outlives its last window, so a closed window ends the run too.
    while (!closed && context.pages().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      for (const p of context.pages()) {
        await session.snapshot(p, "poll");
        await session.drainInlineDownloads(p);
      }
    }
  } finally {
    if (!closed) await context.close().catch(() => undefined);
  }

  recorder.writeArtifact("run-summary.json", {
    stamp,
    bank: BANK,
    api_calls: recorder.calls.map((c) => ({ endpoint: c.endpoint, url: c.url, status: c.status })),
  });
  log(`capture → ${dir}`);
  return 0;
}
