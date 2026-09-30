import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Page } from "playwright-core";
import { APP_BASE, HOME_URL, SELECTOR, TEXT } from "./routes.js";
import { settle } from "../wait.js";
import { log, logStep } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { clearLoginLatch, recordCredentialsRejected } from "./loginLatch.js";

/** How long the first click on the login button may wait before overlays are swept again. */
const OPEN_PANEL_FIRST_TRY_MS = 10_000;
/** How long the login form has to render once the panel is open; restarts after a retried card. */
const LOGIN_FORM_TIMEOUT_MS = 45_000;
/** Pause between polls for the form, the private-app redirect and the connection-error card. */
const LOGIN_FORM_POLL_MS = 500;
/** How long the connection-error card has to leave the page after «Volver a intentar» is clicked. */
const CONNECTION_RETRY_SETTLE_MS = 10_000;
/** Upper bound on overlay sweeps — a dialog that re-opens itself must not loop the run. */
const MAX_OVERLAY_DISMISSALS = 3;
/** How long the private app has to take over the window after the login form is submitted. */
const LOGIN_REDIRECT_TIMEOUT_MS = 90_000;
/** Pause between polls of the URL and of the rejection toast while that redirect is pending. */
const LOGIN_REDIRECT_POLL_MS = 500;
/** How much of the login frame's text the failure message quotes; the full text goes to the file. */
const LOGIN_FAILURE_EXCERPT_CHARS = 240;

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

/**
 * Close whatever sits over the homepage header before the login button is clicked: the fraud-warning
 * banner and any marketing modal (see `SELECTOR.closeModal`). Each dismissal is logged, so a run
 * that met a new overlay says so instead of just being slower.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const notice = page.locator(SELECTOR.closeNotice).first();
  if ((await notice.count()) > 0 && (await notice.isVisible())) {
    await notice.click();
    log("dismissed the fraud-warning banner");
  }
  for (let i = 0; i < MAX_OVERLAY_DISMISSALS; i++) {
    const close = page.locator(SELECTOR.closeModal).first();
    if ((await close.count()) === 0 || !(await close.isVisible())) return;
    const title = (await close.locator("xpath=ancestor::*[@role='dialog'][1]").innerText().catch(() => ""))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^cerrar/i.test(line))[0];
    await close.click();
    log(`dismissed a modal dialog${title ? ` («${title}»)` : ""}`);
    await page.waitForTimeout(300);
  }
}

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

function redirectedToPrivateApp(page: Page): boolean {
  return page.url().includes("mibanco.santander.cl");
}

/** The rejection toast's text when one is showing, else null. Looked for in the frame, then the page. */
async function loginRejectionText(page: Page, frame: FrameLocator): Promise<string | null> {
  for (const scope of [frame, page]) {
    const toast = scope.getByText(TEXT.loginRejected).first();
    // The frame is torn down when the redirect lands mid-poll; a locator error then means "no toast".
    const text = await toast
      .isVisible()
      .then((visible) => (visible ? toast.innerText({ timeout: 2_000 }) : null))
      .catch(() => null);
    if (text) return text.replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * The connection-error card's heading when the login panel is showing one, else null. The card
 * replaces the iframe in the top-level page, so it is looked for there only.
 */
async function loginPanelConnectionErrorText(page: Page): Promise<string | null> {
  const card = page.getByText(TEXT.loginPanelConnectionError).first();
  const text = await card
    .isVisible()
    .then((visible) => (visible ? card.innerText({ timeout: 2_000 }) : null))
    .catch(() => null);
  return text ? text.replace(/\s+/g, " ").trim() : null;
}

/**
 * What a failed login leaves behind: a screenshot and the login frame's visible text, under
 * `cfraser/scraper-diagnostics/`. The nightly run is unattended and the window is parked off-screen,
 * so without this a failure is only ever «no redirect after 90s» — which is what 2026-09-12 and
 * 09-13 read, two nights in a row, with the toast check silent and nothing to say what the bank had
 * actually shown. Input values are not part of `innerText`, so the clave never reaches the file.
 */
async function saveLoginDiagnostics(
  page: Page,
  frame: FrameLocator,
  reason: string,
): Promise<{ base: string; frameText: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), `santander-login-${stamp}`);
  const frameText = await frame
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch((err: unknown) => `(login frame unreadable: ${firstLine(err)})`);
  const title = await page.title().catch(() => "");
  // The rejection toast renders in the top-level page beside the iframe, so the page text is what
  // carries it — the frame alone read «RUT Clave Ingresar» on 2026-09-14 while the toast sat next to it.
  const pageText = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch((err: unknown) => `(page unreadable: ${firstLine(err)})`);
  fs.writeFileSync(
    `${base}.txt`,
    [
      `reason: ${reason}`,
      `url: ${page.url()}`,
      `title: ${title}`,
      "",
      "--- login frame text ---",
      frameText,
      "",
      "--- page text ---",
      pageText,
      "",
    ].join("\n"),
  );
  await page.screenshot({ path: `${base}.png` }).catch((err: unknown) => {
    log(`(login screenshot failed: ${firstLine(err)})`);
  });
  return { base, frameText };
}

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > LOGIN_FAILURE_EXCERPT_CHARS ? `${collapsed.slice(0, LOGIN_FAILURE_EXCERPT_CHARS)}…` : collapsed;
}

/**
 * A successful login redirects the whole window from the public site to the private app. When the
 * bank rejects the login it shows a toast over the form instead (`TEXT.loginRejected`) and the window
 * stays put — which used to surface only as a 90-second navigation timeout with no hint of the cause.
 * The toast is checked while the redirect is pending, so a rejection fails within one poll and the
 * log carries the bank's own words; anything else ends in the timeout, and both outcomes leave the
 * frame's text and a screenshot behind (`saveLoginDiagnostics`) so the log says what was on screen.
 */
async function waitForLoginRedirect(page: Page, frame: FrameLocator): Promise<void> {
  const deadline = Date.now() + LOGIN_REDIRECT_TIMEOUT_MS;
  while (!redirectedToPrivateApp(page)) {
    const rejection = await loginRejectionText(page, frame);
    if (rejection) {
      const { base } = await saveLoginDiagnostics(page, frame, `rejected: ${rejection}`);
      if (TEXT.loginCredentialsRejected.test(rejection)) recordCredentialsRejected(rejection);
      throw new Error(`The bank rejected the login: «${rejection}» — evidence in ${base}.{png,txt}`);
    }
    if (Date.now() >= deadline) {
      const { base, frameText } = await saveLoginDiagnostics(page, frame, "no redirect after the login form was submitted");
      throw new Error(
        `No redirect to the private app ${LOGIN_REDIRECT_TIMEOUT_MS / 1000}s after submitting the login form ` +
          `(still on ${page.url()}). The login frame shows: «${excerpt(frameText)}» — evidence in ${base}.{png,txt}`,
      );
    }
    await page.waitForTimeout(LOGIN_REDIRECT_POLL_MS);
  }
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
  await dismissOverlays(page);
  const openPanel = page.locator(SELECTOR.openLoginPanel).first();
  try {
    await openPanel.click({ timeout: OPEN_PANEL_FIRST_TRY_MS });
  } catch (err) {
    // A modal that rendered after the first sweep intercepts the click for the whole timeout, so
    // sweep again and retry once before giving up with the real selector error.
    log(`login button click blocked (${firstLine(err)}) — dismissing overlays and retrying`);
    await dismissOverlays(page);
    await openPanel.click();
  }

  const frame = page.frameLocator(SELECTOR.loginFrame);
  const rutInput = frame.locator(SELECTOR.loginRut);
  const passInput = frame.locator(SELECTOR.loginPass);

  // Either the form renders, or a still-valid session sends us straight into the private app. The
  // panel can also render the bank's connection-error card in place of the iframe (2026-09-25, when
  // the frame's document failed to load right after a wake from hibernation): its «Volver a
  // intentar» is clicked once and the wait starts over. A card that comes back after that fails the
  // login with the bank's own words instead of running out the clock as «form never appeared».
  let deadline = Date.now() + LOGIN_FORM_TIMEOUT_MS;
  let formReady = false;
  let connectionRetried = false;
  while (Date.now() < deadline) {
    if (isLoggedIn(page)) {
      logStep("session still valid — skipping login");
      return;
    }
    if (await rutInput.isVisible().catch(() => false)) {
      formReady = true;
      break;
    }
    const connectionError = await loginPanelConnectionErrorText(page);
    if (connectionError) {
      if (connectionRetried) {
        const { base } = await saveLoginDiagnostics(page, frame, `connection-error card again after «Volver a intentar»: ${connectionError}`);
        throw new Error(
          `The login panel reported a connection error twice: «${connectionError}» — the login frame could not be ` +
            `loaded from the private-app host even after «Volver a intentar». Evidence in ${base}.{png,txt}`,
        );
      }
      connectionRetried = true;
      log(`login panel reported a connection error («${connectionError}») — clicking «Volver a intentar»`);
      const retry = page.getByText(TEXT.loginPanelRetry).first();
      await retry.click({ timeout: 5_000 }).catch(async (err: unknown) => {
        const { base } = await saveLoginDiagnostics(page, frame, `«Volver a intentar» could not be clicked: ${firstLine(err)}`);
        throw new Error(`The login panel's «Volver a intentar» could not be clicked (${firstLine(err)}) — evidence in ${base}.{png,txt}`);
      });
      // Give the retry time to replace the card; a card still there afterwards is the second one.
      await page
        .getByText(TEXT.loginPanelConnectionError)
        .first()
        .waitFor({ state: "hidden", timeout: CONNECTION_RETRY_SETTLE_MS })
        .catch(() => undefined);
      deadline = Date.now() + LOGIN_FORM_TIMEOUT_MS;
      continue;
    }
    await page.waitForTimeout(LOGIN_FORM_POLL_MS);
  }
  if (!formReady) {
    // Whether the panel produced the iframe at all is the one fact the log needs: on 2026-09-21 the
    // click went through and this branch fired 45 s later with nothing saved, so the night was
    // unexplainable — the frame loads from the private-app host, and a stall there looks exactly like
    // a panel that never opened.
    const frameElement = page.locator(SELECTOR.loginFrame).first();
    const frameState =
      (await frameElement.count().catch(() => 0)) === 0
        ? "no login iframe element in the page"
        : `login iframe present (src ${(await frameElement.getAttribute("src").catch(() => null)) ?? "unset"})`;
    const { base, frameText } = await saveLoginDiagnostics(
      page,
      frame,
      `login form never appeared after opening the panel — ${frameState}`,
    );
    throw new Error(
      `Login form never appeared after opening the panel (${frameState}; still on ${page.url()}). ` +
        `The login frame shows: «${excerpt(frameText)}» — evidence in ${base}.{png,txt}`,
    );
  }

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

  await waitForLoginRedirect(page, frame);
  await settle(page, 20_000);
  if (!isLoggedIn(page)) {
    throw new Error(`Landed on ${page.url()} after submitting — expected a /private/ route.`);
  }
  logStep("logged in");
  clearLoginLatch("the bank accepted the login");
}
