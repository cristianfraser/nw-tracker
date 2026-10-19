/**
 * Sign in to a service through ClaveÚnica (RUN + clave on accounts.claveunica.gob.cl, then its
 * e-mail code), as a person does: open the service's «ClaveÚnica» button, fill the form, wait for
 * the code step, type the code the mailbox received, and wait until the service's own page is back.
 *
 * Every step is found by what is visible — a password field, a code field, a button named for
 * what it does — and logged, so a changed page fails loudly with a screenshot instead of guessing.
 * A captcha is never worked around: in a supervised run the user finishes the step by hand and the
 * wait below notices the signed-in page either way.
 */
import fs from "node:fs";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright-core";
import { log } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";

export type ClaveUnicaCodeProvider = (requestedAt: Date) => Promise<string>;

/** The Keychain item holding the ClaveÚnica clave (account = the RUN); shared by every ClaveÚnica service. */
export const CLAVE_UNICA_KEYCHAIN_SERVICE = "nw-tracker-clave-unica";

const CLAVE_UNICA_HOST = /claveunica\.gob\.cl/i;
const OPEN_BUTTON = /clave\s*[úu]nica/i;
const CHOOSE_EMAIL = /correo|e-?mail/i;
const ANNOUNCES_CODE = /enviaremos un c[oó]digo/i;
const CONTINUE = /continuar/i;
const SUBMIT_FORM = /^\s*ingresa/i;
const SUBMIT_CODE = /continuar|validar|verificar|ingresar|enviar|confirmar/i;
const CODE_FIELD = /c[oó]digo|code|otp|token/i;
const CODE_PAGE = /c[oó]digo de validaci[oó]n|escribe el c[oó]digo/i;
const REJECTED = /incorrect|inv[aá]lid|no coincide|expir|bloquead/i;

export type ClaveUnicaLoginOptions = {
  run: string;
  clave: string;
  code: ClaveUnicaCodeProvider;
  /** The service's own signed-in state; the login is over once it holds. */
  isSignedIn: (page: Page) => Promise<boolean>;
  /** Service name for the log and the diagnostics files. */
  label: string;
  timeoutMs?: number;
};

async function visibleCount(frame: Frame, selector: string): Promise<number> {
  try {
    return await frame.locator(selector).count();
  } catch {
    return 0; // a frame that navigated away
  }
}

async function findFrameWith(page: Page, selector: string): Promise<Frame | null> {
  for (const p of page.context().pages()) {
    if (p.isClosed()) continue;
    for (const frame of p.frames()) if (await visibleCount(frame, selector)) return frame;
  }
  return null;
}

async function frameText(frame: Frame): Promise<string> {
  try {
    return await frame.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

export async function saveClaveUnicaDiagnostics(page: Page, label: string): Promise<string> {
  const base = path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    fs.writeFileSync(`${base}.txt`, `${page.url()}\n\n${await pageText(page)}`);
    return `see ${path.relative(resolveCfraserDir(), base)}.png`;
  } catch (err) {
    return `no screenshot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The frame (on a ClaveÚnica page) holding a visible password field. */
async function findClaveUnicaForm(page: Page): Promise<Frame | null> {
  const frame = await findFrameWith(page, 'input[type="password"]:visible');
  if (!frame) return null;
  return CLAVE_UNICA_HOST.test(frame.url()) || CLAVE_UNICA_HOST.test(frame.page().url()) ? frame : null;
}

/** A visible code field: one named for it, or the first of a row of single-character boxes. */
async function findCodeField(page: Page): Promise<{ frame: Frame; field: Locator; boxes: boolean } | null> {
  for (const p of page.context().pages()) {
    if (p.isClosed()) continue;
    for (const frame of p.frames()) {
      try {
        const inputs = frame.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
        const n = await inputs.count();
        if (n === 0) continue;
        const boxes = frame.locator('input[maxlength="1"]:visible');
        if ((await boxes.count()) >= 4) return { frame, field: boxes.first(), boxes: true };
        // Boxes without a maxlength: a row of four or more plain inputs on a page asking for the code.
        if (n >= 4 && CODE_PAGE.test(await frameText(frame))) return { frame, field: inputs.first(), boxes: true };
        for (let i = 0; i < n; i++) {
          const el = inputs.nth(i);
          const descriptor = [await el.getAttribute("name"), await el.getAttribute("id"), await el.getAttribute("placeholder"), await el.getAttribute("aria-label"), await el.getAttribute("autocomplete")]
            .filter(Boolean)
            .join(" ");
          if (CODE_FIELD.test(descriptor) || /one-time-code/.test(descriptor)) return { frame, field: el, boxes: false };
        }
      } catch {
        // detached frame
      }
    }
  }
  return null;
}

/** Type as a person does: click, wait for the field to accept input, then key by key. */
async function typeInto(field: Locator, value: string): Promise<void> {
  await field.click();
  for (let i = 0; (await field.getAttribute("readonly")) !== null; i++) {
    if (i >= 50) throw new Error("ClaveÚnica: a field stayed readonly after a click");
    await field.page().waitForTimeout(100);
  }
  await field.fill("").catch(() => undefined);
  await field.pressSequentially(value, { delay: 40 });
}

export async function signInWithClaveUnica(page: Page, opts: ClaveUnicaLoginOptions): Promise<Page> {
  const timeoutMs = opts.timeoutMs ?? 480_000;
  const deadline = Date.now() + timeoutMs;
  const current = (): Page => page.context().pages().find((p) => !p.isClosed()) ?? page;

  // 1. The service's «ClaveÚnica» button (unless the form is already up, or the session is still valid).
  let form = await findClaveUnicaForm(page);
  if (!form) {
    const button = page.getByRole("link", { name: OPEN_BUTTON }).or(page.getByRole("button", { name: OPEN_BUTTON })).first();
    for (let i = 0; i < 30 && !form && !(await button.count()); i++) {
      if (await opts.isSignedIn(page)) {
        log(`${opts.label}: already signed in (session kept by the browser profile)`);
        return page;
      }
      await page.waitForTimeout(1_000);
      form = await findClaveUnicaForm(page);
    }
    if (!form && (await button.count())) {
      log(`${opts.label}: opening ClaveÚnica via «${(await button.innerText().catch(() => "")).trim().slice(0, 40)}»`);
      await button.click();
    }
    for (let i = 0; i < 60 && !form; i++) {
      await page.waitForTimeout(1_000);
      form = await findClaveUnicaForm(page);
      if (!form && (await opts.isSignedIn(current()))) return current();
    }
  }
  if (!form) throw new Error(`${opts.label}: the ClaveÚnica sign-in form never appeared (${await saveClaveUnicaDiagnostics(current(), "clave-unica-form")})`);
  page = form.page();

  // 2. RUN + clave. The RUN field is the visible text-like input before the password field; the RUN
  //    is typed compact («12345678-9») — ClaveÚnica's field formats it itself.
  const password = form.locator('input[type="password"]:visible').first();
  const runField = form.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])').first();
  if (!(await runField.count())) throw new Error(`${opts.label}: ClaveÚnica form has no RUN field (${await saveClaveUnicaDiagnostics(page, "clave-unica-form")})`);
  await typeInto(runField, opts.run.replace(/\./g, "").toUpperCase());
  await typeInto(password, opts.clave);
  log(`${opts.label}: RUN and clave filled — submitting`);
  let requestedAt = new Date();
  await password.press("Enter");
  // Enter submits the form; when it did not (the form is still up), the «INGRESA» control is clicked.
  await page.waitForTimeout(2_000);
  if (await findClaveUnicaForm(page)) {
    const submit = form.getByRole("button", { name: SUBMIT_FORM }).or(form.getByRole("link", { name: SUBMIT_FORM })).first();
    if (await submit.count().catch(() => 0)) {
      log(`${opts.label}: clicking «${(await submit.innerText().catch(() => "")).trim().slice(0, 30)}»`);
      await submit.click().catch(() => undefined);
    }
  }

  // 3. Either the service is back (no second factor) or the code step shows.
  let code: { frame: Frame; field: Locator; boxes: boolean } | null = null;
  let emailChosen = false;
  while (!code && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const p = current();
    if (await opts.isSignedIn(p)) {
      log(`${opts.label}: signed in without a second factor`);
      return p;
    }
    const text = await pageText(p);
    if (REJECTED.test(text) && !(await findClaveUnicaForm(p))) {
      // Only a verdict on a page that is no longer the form (the form's own help text is not one).
    }
    if (REJECTED.test(text) && (await findClaveUnicaForm(p))) {
      throw new Error(`${opts.label}: ClaveÚnica rejected the RUN or clave (${await saveClaveUnicaDiagnostics(p, "clave-unica-rejected")})`);
    }
    code = await findCodeField(p);
    if (!code && !emailChosen) {
      // «Te enviaremos un código de 6 dígitos a tu correo registrado … Continuar →» (2026-10-17):
      // the mail is sent on that click, so the request time is taken from it.
      const announced = ANNOUNCES_CODE.test(text);
      const choose = announced
        ? p.getByRole("button", { name: CONTINUE }).or(p.getByRole("link", { name: CONTINUE })).first()
        : p.getByRole("button", { name: CHOOSE_EMAIL }).or(p.getByRole("link", { name: CHOOSE_EMAIL })).or(p.getByLabel(CHOOSE_EMAIL)).first();
      if (await choose.count().catch(() => 0)) {
        log(`${opts.label}: ${announced ? "asking for the e-mail code («Continuar»)" : "choosing the e-mail code"}`);
        requestedAt = new Date();
        await choose.click().catch(() => undefined);
        emailChosen = true;
      }
    }
  }
  if (!code) throw new Error(`${opts.label}: neither the signed-in page nor a code field appeared after the ClaveÚnica form (${await saveClaveUnicaDiagnostics(current(), "clave-unica-after-form")})`);
  page = code.frame.page();
  log(`${opts.label}: code step reached (${code.boxes ? "single-character boxes" : "one field"}) — reading the mailbox`);

  // 4. The code, from the mailbox; typed, then submitted.
  const value = (await opts.code(requestedAt)).trim();
  if (!/^[A-Z0-9]{4,8}$/i.test(value)) throw new Error(`${opts.label}: «${value}» does not look like a ClaveÚnica code`);
  await typeInto(code.field, value.toUpperCase());
  const urlBefore = page.url();
  await code.field.press("Enter").catch(() => undefined);
  await page.waitForTimeout(3_000);
  if (!(await opts.isSignedIn(current())) && page.url() === urlBefore) {
    const submit = page.getByRole("button", { name: SUBMIT_CODE }).first();
    if (await submit.count().catch(() => 0)) {
      log(`${opts.label}: submitting the code via «${(await submit.innerText().catch(() => "")).trim().slice(0, 30)}»`);
      await submit.click().catch(() => undefined);
    }
  }
  while (Date.now() < deadline) {
    const p = current();
    if (await opts.isSignedIn(p)) {
      log(`${opts.label}: signed in`);
      return p;
    }
    const text = await pageText(p);
    if (REJECTED.test(text) && (await findCodeField(p))) {
      throw new Error(`${opts.label}: ClaveÚnica rejected the code (${await saveClaveUnicaDiagnostics(p, "clave-unica-code-rejected")})`);
    }
    await p.waitForTimeout(1_000);
  }
  throw new Error(`${opts.label}: not signed in ${Math.round(timeoutMs / 1000)} s after the ClaveÚnica form (${await saveClaveUnicaDiagnostics(current(), "clave-unica-timeout")})`);
}
