import type { Page } from "playwright-core";
import { LOGIN_URL, SELECTOR } from "./routes.js";
import { settle } from "../wait.js";
import { log, logStep } from "../log.js";

/** Compare RUTs regardless of the field's formatting ("123456785" ≡ "12.345.678-5"). */
function normalizeRut(value: string): string {
  return value.replace(/[.\-\s]/g, "").toUpperCase();
}

/**
 * Wait for Cloudflare Turnstile to issue a token.
 *
 * The login form carries a hidden `cf-turnstile-response` input that Cloudflare fills once the
 * browser passes its check. Waiting on that value — rather than on the submit button, which also
 * depends on field validation — is what distinguishes "the bot check failed" from "the form is
 * incomplete", and it is the failure this bank is most likely to produce.
 */
async function waitForTurnstileToken(page: Page, timeoutMs = 60_000): Promise<void> {
  logStep("waiting for Cloudflare Turnstile");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await page
      .locator(SELECTOR.turnstileToken)
      .first()
      .inputValue()
      .catch(() => "");
    if (token.trim().length > 0) {
      log("Turnstile passed");
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    "Cloudflare Turnstile never issued a token — the bot check did not pass. " +
      "Run with a visible window (no --background) once to see the challenge, and keep the " +
      "persistent profile so Cloudflare recognises the browser next time.",
  );
}

/**
 * Log in with RUT + Clave de internet.
 *
 * Same clear-then-verify discipline as Santander: a browser-autofilled value left in the field gets
 * merged with the typed one and produces an invalid RUT.
 */
export async function login(page: Page, rut: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await settle(page);

  if (!page.url().includes("/login")) {
    logStep("session still valid — skipping login");
    return;
  }

  logStep("logging in");
  const rutInput = page.locator(SELECTOR.loginRut).first();
  const passInput = page.locator(SELECTOR.loginPass).first();
  await rutInput.waitFor({ state: "visible" });

  await rutInput.click();
  await rutInput.clear();
  await rutInput.fill(rut);
  await rutInput.blur();
  const landed = await rutInput.inputValue();
  if (normalizeRut(landed) !== normalizeRut(rut)) {
    throw new Error(`RUT field holds "${landed}" after typing — expected "${rut}".`);
  }

  await passInput.click();
  await passInput.clear();
  await passInput.fill(password);
  const passLength = (await passInput.inputValue()).length;
  if (passLength !== password.length) {
    throw new Error(`Password field holds ${passLength} characters, expected ${password.length}.`);
  }
  await passInput.blur();

  await waitForTurnstileToken(page);

  const submit = page.locator(SELECTOR.loginSubmit).first();
  await submit.waitFor({ state: "visible" });
  await submit.click();

  // The site shows a loading screen before the homepage renders.
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 90_000 });
  await settle(page, 20_000);
  logStep("logged in");
}
