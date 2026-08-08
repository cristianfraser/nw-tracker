import type { Page } from "playwright-core";
import { LOGIN_URL, SELECTOR, TEXT } from "./routes.js";
import { settle } from "../wait.js";
import { log, logStep } from "../log.js";

/**
 * Log in with e-mail + password.
 *
 * Racional signs in with an e-mail, not a RUT — the only bank here that does. Same
 * clear-then-verify discipline as the other two: Chrome's password manager is disabled on the
 * profile, but an autofilled value left in a field would otherwise merge with the typed one and
 * fail authentication in a way that looks like a wrong password.
 *
 * The inputs are Ionic components that hydrate after first paint, so every locator here waits
 * rather than assuming the field exists.
 */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await settle(page);

  if (!page.url().includes("/login")) {
    logStep("session still valid — skipping login");
    return;
  }

  logStep("logging in");
  const emailInput = page.locator(SELECTOR.loginEmail).first();
  const passInput = page.locator(SELECTOR.loginPassword).first();
  // Ionic creates the native input only once the component hydrates.
  await emailInput.waitFor({ state: "visible", timeout: 60_000 });

  await emailInput.click();
  await emailInput.clear();
  await emailInput.fill(email);
  await emailInput.blur();
  const landed = (await emailInput.inputValue()).trim();
  if (landed.toLowerCase() !== email.toLowerCase()) {
    throw new Error(`E-mail field holds "${landed}" after typing — expected "${email}".`);
  }

  await passInput.click();
  await passInput.clear();
  await passInput.fill(password);
  // Never compare or log the value itself; length is enough to prove the field took it cleanly.
  const passLength = (await passInput.inputValue()).length;
  if (passLength !== password.length) {
    throw new Error(`Password field holds ${passLength} characters, expected ${password.length}.`);
  }
  await passInput.blur();

  await enableKeepSession(page);

  const submit = page.locator(SELECTOR.loginSubmit).first();
  await submit.waitFor({ state: "visible" });
  // The button starts disabled and enables on form validity — waiting for that is also the
  // clearest signal that both fields were accepted.
  await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLButtonElement | null;
        return !!el && !el.disabled && !el.getAttribute("disabled");
      },
      'ion-button:not([disabled]), button:not([disabled])',
      { timeout: 30_000 },
    )
    .catch(() => {
      /* Some builds never set the attribute; fall through to the click and let it fail loudly. */
    });
  await submit.click();

  await waitForLoginToLand(page);
  await settle(page, 20_000);
  logStep("logged in");
}

/**
 * Tick «Mantener sesión» before submitting.
 *
 * This is what makes unattended runs possible at all: Racional e-mails a verification code on a
 * fresh session, and nobody is there to read it at 22:00. Keeping the session alive in the
 * persistent profile means the code is asked for once, during the supervised first run.
 */
async function enableKeepSession(page: Page): Promise<void> {
  const toggle = page.getByText(TEXT.keepSession).first();
  if ((await toggle.count()) === 0) {
    log("«Mantener sesión» control not found — the session may not survive to the next run");
    return;
  }
  const control = page.locator(SELECTOR.keepSession).first();
  const alreadyOn = await control
    .first()
    .evaluate((el) => el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true)
    .catch(() => false);
  if (alreadyOn) {
    log("«Mantener sesión» already enabled");
    return;
  }
  await toggle.click();
  log("«Mantener sesión» enabled — the session should outlive this run");
}

/**
 * Wait for the app to leave /login, tolerating the e-mailed verification step.
 *
 * The code cannot be read by the fetcher (it arrives in e-mail), so this deliberately does not
 * try: it detects the challenge and gives a supervised run a long window to type it, while an
 * unattended one fails immediately with an instruction rather than hanging until timeout.
 */
async function waitForLoginToLand(page: Page): Promise<void> {
  const landed = page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 60_000 });
  try {
    await landed;
    return;
  } catch {
    /* still on /login — check whether a verification code is being asked for */
  }

  const challenge = await page
    .getByText(TEXT.verificationCode)
    .first()
    .count()
    .catch(() => 0);
  if (challenge === 0) {
    throw new Error("Login did not complete and no verification prompt appeared — check the password.");
  }

  if (!process.stdout.isTTY) {
    throw new Error(
      "Racional asked for the e-mailed verification code, and this run is unattended. " +
        "Run `npm run fetch:racional -- --capture --force` yourself once, enter the code, and " +
        "make sure «Mantener sesión» stays ticked so scheduled runs reuse the session.",
    );
  }
  log("⏳ Racional sent a verification code by e-mail — enter it in the window (waiting up to 5 min)");
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 300_000 });
}
