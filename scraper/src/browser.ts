import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { ensureDir, resolveBrowserProfileDir } from "./paths.js";
import type { BankName } from "./config.js";
import { log } from "./log.js";

export type LaunchOptions = {
  bank: BankName;
  headless: boolean;
  /** Park the window off-screen: a real (non-headless) Chrome the user never sees. */
  background?: boolean;
  slowMoMs?: number;
};

/**
 * Santander's edge blocks headless Chrome — both the classic mode and `--headless=new`
 * (probed 2026-08-04, all three variants). A normally-rendering window positioned off-screen is
 * served the real site, so that is how an unattended run stays out of the way.
 */
const OFF_SCREEN_ARGS = ["--window-position=-3000,-3000"];

/**
 * After a crash (Chrome 152 crashed three nights running, 2026-08-31 → 09-04) the next launch opens
 * a «Restore pages? Chrome didn't shut down correctly» bubble over the toolbar. It is browser UI,
 * not page content, so it never blocks a click — but it invites a human who finds the window to
 * restore old tabs into a scraper session. A documented switch, not one Chrome flags as unsupported.
 */
const COMMON_ARGS = ["--hide-crash-restore-bubble"];

/**
 * Hide the automation marker without passing a command-line flag.
 *
 * Playwright drives Chrome over CDP, which sets `navigator.webdriver = true`; both banks read it,
 * and it follows the whole browser instance (a hand-opened tab in the same window was refused too).
 * The obvious fix — `--disable-blink-features=AutomationControlled` — backfires: Chrome answers it
 * with a persistent "You are using an unsupported command-line flag" infobar, which is itself an
 * automation tell and shrinks the viewport. Overriding the property in an init script achieves the
 * same thing with no flag and no banner.
 *
 * The rate limit in `runGuard.ts` matters as much as this does: the escalation followed a burst of
 * development runs, not the daily pattern this exists to serve.
 */
const HIDE_WEBDRIVER_INIT_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`;

/**
 * Turn off Chrome's password manager for this profile.
 *
 * Once Chrome has offered to save the bank login, it autofills the form on every later run. The
 * autofilled RUT is already in the field when the script types, and the input's formatter merges the
 * two into an invalid RUT ("1.234.567.851-8"), so the login silently fails. Disabling the credential
 * service removes the cause; `login.ts` still clears and verifies each field as a backstop.
 */
function disablePasswordManager(profileDir: string): void {
  const prefsFile = path.join(profileDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  if (fs.existsSync(prefsFile)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8")) as Record<string, unknown>;
    } catch {
      // A corrupt profile pref file is Chrome's to rebuild — start from an empty object.
      prefs = {};
    }
  }
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  const profile = (prefs.profile ?? {}) as Record<string, unknown>;
  profile.password_manager_enabled = false;
  prefs.profile = profile;
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
}

/**
 * Launch the user's installed Chrome against a dedicated profile directory.
 *
 * A persistent profile (rather than a fresh incognito context per run) is deliberate: it keeps
 * cookies and device trust between nightly runs, which is what stops a bank from treating every
 * run as a brand-new device.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserContext> {
  const profileDir = ensureDir(resolveBrowserProfileDir(opts.bank));
  disablePasswordManager(profileDir);
  log(`Chrome profile: ${profileDir}`);
  if (opts.background) log("background mode — window parked off-screen");
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: opts.headless,
    // No flag Chrome considers "unsupported" — each one raises an infobar that is itself a tell.
    args: [...COMMON_ARGS, ...(opts.background ? OFF_SCREEN_ARGS : [])],
    ignoreDefaultArgs: ["--enable-automation"],
    // Playwright disables Chromium's sandbox by default, which both weakens a browser that signs
    // into a bank and raises "You are using an unsupported command-line flag: --no-sandbox".
    chromiumSandbox: true,
    slowMo: opts.slowMoMs,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    locale: "es-CL",
    timezoneId: "America/Santiago",
  });
  await context.addInitScript(HIDE_WEBDRIVER_INIT_SCRIPT);
  return context;
}

export async function firstPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  const page = existing ?? (await context.newPage());
  page.setDefaultTimeout(45_000);
  return page;
}
