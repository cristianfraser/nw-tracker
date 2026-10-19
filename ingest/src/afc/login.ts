/**
 * Sign in to the AFC's sucursal virtual with the AFC's own clave (personas.afc.cl/auth/login:
 * «Ingrese su RUT», «Ingrese su contraseña», the button «Ingresar con contraseña AFC»; the page's
 * own invisible reCAPTCHA makes its token — nothing here touches it). No second factor, unlike
 * the ClaveÚnica path (`../claveUnica/login.ts`), which stays available behind `--clave-unica`.
 *
 * The button is `type="button"`, so Enter is not trusted: the button is clicked. A refused attempt
 * is reloaded and tried once more, as a person would (the captcha sometimes rejects a first try);
 * the bank's rejection wording is quoted, with a screenshot, when both fail.
 */
import type { Page } from "playwright-core";
import { saveClaveUnicaDiagnostics } from "../claveUnica/login.js";
import { log } from "../log.js";

// Both the Angular wrapper and the input carry id="rut" (2026-10-19): the input is the field.
const RUT_FIELD = "input#rut";
const SUBMIT = /ingresar con contrase[ñn]a afc/i;
const REJECTED = /incorrect|inv[aá]lid|no coincide|bloquead|no existe|intente nuevamente/i;
const FORM_WAIT_MS = 45_000;
const SIGNED_IN_WAIT_MS = 60_000;

export type AfcClaveLoginOptions = {
  rut: string;
  clave: string;
  isSignedIn: (page: Page) => Promise<boolean>;
  label: string;
};

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

async function attempt(page: Page, opts: AfcClaveLoginOptions): Promise<string | null> {
  const rut = page.locator(RUT_FIELD);
  const password = page.locator('input[type="password"]').first();
  await rut.waitFor({ state: "visible", timeout: FORM_WAIT_MS });
  await password.waitFor({ state: "visible", timeout: FORM_WAIT_MS });
  await rut.click();
  await rut.fill("");
  await rut.pressSequentially(opts.rut, { delay: 40 });
  await password.click();
  await password.fill("");
  await password.pressSequentially(opts.clave, { delay: 40 });
  log(`${opts.label}: RUT and clave filled — clicking «Ingresar con contraseña AFC»`);
  await page.getByRole("button", { name: SUBMIT }).first().click({ timeout: 10_000 });
  const deadline = Date.now() + SIGNED_IN_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (await opts.isSignedIn(page)) return null;
    const text = await pageText(page);
    const line = text.split("\n").map((l) => l.trim()).find((l) => REJECTED.test(l));
    if (line) return line;
  }
  return `not signed in ${SIGNED_IN_WAIT_MS / 1000} s after the click`;
}

export async function signInWithAfcClave(page: Page, opts: AfcClaveLoginOptions): Promise<Page> {
  if (await opts.isSignedIn(page)) {
    log(`${opts.label}: already signed in (session kept by the browser profile)`);
    return page;
  }
  let why: string | null = null;
  for (let i = 1; i <= 2; i++) {
    if (i === 2) {
      log(`${opts.label}: sign-in refused — «${why}»; reloading for a second attempt`);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    why = await attempt(page, opts);
    if (why == null) {
      log(`${opts.label}: signed in`);
      return page;
    }
  }
  throw new Error(`${opts.label}: sign-in refused twice — «${why}» (${await saveClaveUnicaDiagnostics(page, "afc-login")})`);
}
