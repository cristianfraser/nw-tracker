import type { Page } from "playwright-core";
import { APP_BASE, HOME_URL, SELECTOR } from "./routes.js";
import { settle } from "../wait.js";
import { logStep } from "../log.js";

/** Compare RUTs regardless of the field's on-blur formatting ("123456785" ≡ "12.345.678-5"). */
function normalizeRut(value: string): string {
  return value.replace(/[.\-\s]/g, "").toUpperCase();
}

/** Navigate the SPA. Hash-only changes don't reload the document, so the hash is set in-page. */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  if (page.url().startsWith(APP_BASE)) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, route);
  } else {
    await page.goto(`${APP_BASE}#${route}`, { waitUntil: "domcontentloaded" });
  }
  await settle(page);
}

export function isLoggedIn(page: Page): boolean {
  return page.url().includes("#/private/");
}

/**
 * The bank's edge serves a fake "Revisa tu conexión a internet" page to clients it considers bots —
 * headless Chrome is one of them (verified 2026-08-04: headless blocked, headed served the form).
 * Detected explicitly so the run fails with the real reason instead of a selector timeout.
 */
async function assertNotBotBlocked(page: Page): Promise<void> {
  const title = await page.title();
  if (!/internet connection error/i.test(title)) return;
  throw new Error(
    "Santander served its bot-detection page instead of the login form. " +
      "Run with a visible browser (drop --headless) — headless Chrome is blocked at the edge.",
  );
}

/**
 * Log in with RUT + Clave Digital.
 *
 * The persistent profile means a still-valid session skips this entirely. The password comes from
 * the Keychain and is only ever handed to `fill()` — it is never logged, stored, or echoed.
 */
export async function login(page: Page, rut: string, password: string): Promise<void> {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await settle(page);
  await assertNotBotBlocked(page);

  logStep("opening login panel");
  // Dismiss the fraud-warning banner first — it can sit over the header and swallow the click.
  const notice = page.locator(SELECTOR.closeNotice).first();
  if ((await notice.count()) > 0 && (await notice.isVisible())) await notice.click();
  await page.locator(SELECTOR.openLoginPanel).first().click();

  const frame = page.frameLocator(SELECTOR.loginFrame);
  const rutInput = frame.locator(SELECTOR.loginRut);
  const passInput = frame.locator(SELECTOR.loginPass);

  // Either the form renders, or a still-valid session sends us straight into the private app.
  const deadline = Date.now() + 45_000;
  let formReady = false;
  while (Date.now() < deadline) {
    if (isLoggedIn(page)) {
      logStep("session still valid — skipping login");
      return;
    }
    if (await rutInput.isVisible().catch(() => false)) {
      formReady = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!formReady) throw new Error("Login form never appeared after opening the panel.");

  logStep("logging in");

  // Clear before typing: a browser-autofilled value left in place gets merged with the typed one by
  // the field's formatter, producing an invalid RUT and an unexplained login failure.
  await rutInput.click();
  await rutInput.clear();
  await rutInput.fill(rut);
  // The RUT reformats on blur, so verify after it — comparing without separators.
  await rutInput.blur();
  const landed = await rutInput.inputValue();
  if (normalizeRut(landed) !== normalizeRut(rut)) {
    throw new Error(`RUT field holds "${landed}" after typing — expected "${rut}". Clearing did not take.`);
  }

  await passInput.click();
  await passInput.clear();
  await passInput.fill(password);
  // Never compare or log the secret itself; length is enough to catch a merged autofill.
  const passLength = (await passInput.inputValue()).length;
  if (passLength !== password.length) {
    throw new Error(`Password field holds ${passLength} characters, expected ${password.length}.`);
  }
  await passInput.blur();

  await frame.locator(SELECTOR.loginSubmit).click();

  // A successful login redirects the whole window from the public site to the private app.
  await page.waitForURL((url) => url.href.includes("mibanco.santander.cl"), { timeout: 90_000 });
  await settle(page, 20_000);
  if (!isLoggedIn(page)) {
    throw new Error(`Landed on ${page.url()} after submitting — expected a /private/ route.`);
  }
  logStep("logged in");
}
