/**
 * Sign in to MetLife's «Portal de Clientes» (w3.metlife.cl): RUT + clave, then the «Clave
 * Dinámica» MetLife mails (`./codeMail.ts`). No captcha, per the user.
 *
 * The page has never been driven yet, so every step is found by what is visible — a RUT-ish text
 * field, the password field, a button named «Ingresar», then a code field (one input, or a row of
 * single-digit boxes) — in any frame, with a timeout on every wait. A rejection is quoted and a
 * changed page fails with a screenshot (`cfraser/scraper-diagnostics/`) instead of guessing; in a
 * supervised capture the user finishes by hand and the run keeps recording.
 */
import type { Frame, Locator, Page } from "playwright-core";
import { saveClaveUnicaDiagnostics } from "../claveUnica/login.js";
import { log } from "../log.js";

export type MetlifeCodeProvider = (requestedAt: Date) => Promise<string>;

export type MetlifeLoginOptions = {
  rut: string;
  clave: string;
  /** Service name for the log and the diagnostics files. */
  label: string;
  /** The portal's own signed-in state; the login is over once it holds. */
  isSignedIn: (page: Page) => Promise<boolean>;
  code: MetlifeCodeProvider;
};

const OPEN_LOGIN = /ingres|iniciar sesi|portal de clientes|mi metlife|acceso clientes/i;
const SUBMIT_FORM = /ingresar|entrar|iniciar sesi|continuar|acceder/i;
const SUBMIT_CODE = /continuar|validar|verificar|ingresar|enviar|confirmar|aceptar/i;
const RUT_FIELD = /rut|usuario|user|login|documento/i;
const CODE_FIELD = /c[oó]digo|code|otp|token|clave din|pin/i;
const CODE_PAGE = /clave din[aá]mica|c[oó]digo de acceso|c[oó]digo temporal/i;
const REJECTED = /incorrect|inv[aá]lid|no coincide|bloquead|no existe|intente nuevamente|err[oó]ne|expir/i;
const FORM_WAIT_MS = 45_000;
const CODE_PAGE_WAIT_MS = 60_000;
const SIGNED_IN_WAIT_MS = 60_000;
const TEXT_INPUTS = 'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])';

async function frameText(frame: Frame): Promise<string> {
  try {
    return await frame.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

function livePages(page: Page): Page[] {
  return page.context().pages().filter((p) => !p.isClosed());
}

function current(page: Page): Page {
  return livePages(page).at(-1) ?? page;
}

/** The frame holding a visible password field. */
async function findLoginForm(page: Page): Promise<Frame | null> {
  for (const p of livePages(page)) {
    for (const frame of p.frames()) {
      try {
        if (await frame.locator('input[type="password"]:visible').count()) return frame;
      } catch {
        // detached frame
      }
    }
  }
  return null;
}

async function describeInput(el: Locator): Promise<string> {
  return [await el.getAttribute("name"), await el.getAttribute("id"), await el.getAttribute("placeholder"), await el.getAttribute("aria-label"), await el.getAttribute("autocomplete")]
    .filter(Boolean)
    .join(" ");
}

/** The RUT field: a text input named for it, else the first visible text input of the form. */
async function findRutField(frame: Frame): Promise<Locator | null> {
  const inputs = frame.locator(TEXT_INPUTS);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) if (RUT_FIELD.test(await describeInput(inputs.nth(i)))) return inputs.nth(i);
  return n > 0 ? inputs.first() : null;
}

/** A visible code field (no password field beside it): one named for it, or a row of single-character boxes. */
async function findCodeField(page: Page): Promise<{ frame: Frame; fields: Locator; boxes: boolean } | null> {
  for (const p of livePages(page)) {
    for (const frame of p.frames()) {
      try {
        if (await frame.locator('input[type="password"]:visible').count()) {
          // A code field may be a password-type input on its own page; only when the page asks for a code.
          if (!CODE_PAGE.test(await frameText(frame))) continue;
          const pw = frame.locator('input[type="password"]:visible');
          if ((await pw.count()) === 1 && (await frame.locator(TEXT_INPUTS).count()) === 0) return { frame, fields: pw, boxes: false };
          continue;
        }
        const boxes = frame.locator('input[maxlength="1"]:visible');
        if ((await boxes.count()) >= 4) return { frame, fields: boxes, boxes: true };
        const inputs = frame.locator(TEXT_INPUTS);
        const n = await inputs.count();
        if (n === 0) continue;
        const asksForCode = CODE_PAGE.test(await frameText(frame));
        if (n >= 4 && asksForCode) return { frame, fields: inputs, boxes: true };
        for (let i = 0; i < n; i++) {
          const d = await describeInput(inputs.nth(i));
          if (CODE_FIELD.test(d) || /one-time-code/.test(d)) return { frame, fields: inputs.nth(i), boxes: false };
        }
        if (n === 1 && asksForCode) return { frame, fields: inputs.first(), boxes: false };
      } catch {
        // detached frame
      }
    }
  }
  return null;
}

async function typeInto(field: Locator, value: string): Promise<void> {
  await field.click({ timeout: 10_000 });
  await field.fill("").catch(() => undefined);
  await field.pressSequentially(value, { delay: 40 });
}

/** The visible line quoting a rejection, if the page shows one. */
async function rejection(page: Page): Promise<string | null> {
  for (const p of livePages(page)) {
    for (const frame of p.frames()) {
      const line = (await frameText(frame)).split("\n").map((l) => l.trim()).find((l) => l.length < 200 && REJECTED.test(l));
      if (line) return line;
    }
  }
  return null;
}

async function clickSubmit(frame: Frame, name: RegExp, label: string): Promise<boolean> {
  const button = frame.getByRole("button", { name }).or(frame.locator('input[type="submit"]:visible')).first();
  if (!(await button.count().catch(() => 0))) return false;
  log(`${label}: clicking «${(await button.innerText().catch(() => "")).trim().slice(0, 30) || "submit"}»`);
  await button.click({ timeout: 10_000 }).catch(() => undefined);
  return true;
}

async function fail(page: Page, label: string, why: string, tag: string): Promise<never> {
  throw new Error(`${label}: ${why} (${await saveClaveUnicaDiagnostics(current(page), tag)})`);
}

export async function signInWithMetlife(page: Page, opts: MetlifeLoginOptions): Promise<Page> {
  if (await opts.isSignedIn(page)) {
    log(`${opts.label}: already signed in (session kept by the browser profile)`);
    return page;
  }

  // 1. The login form: on the page, or behind a «Portal de Clientes» / «Ingresar» link.
  let form = await findLoginForm(page);
  const formDeadline = Date.now() + FORM_WAIT_MS;
  let opened = false;
  while (!form && Date.now() < formDeadline) {
    if (await opts.isSignedIn(current(page))) return current(page);
    if (!opened) {
      const opener = page.getByRole("link", { name: OPEN_LOGIN }).or(page.getByRole("button", { name: OPEN_LOGIN })).first();
      if (await opener.count().catch(() => 0)) {
        log(`${opts.label}: opening the login via «${(await opener.innerText().catch(() => "")).trim().slice(0, 40)}»`);
        await opener.click({ timeout: 10_000 }).catch(() => undefined);
        opened = true;
      }
    }
    await page.waitForTimeout(1_000);
    form = await findLoginForm(page);
  }
  if (!form) return fail(page, opts.label, "the login form (a password field) never appeared", "metlife-login-form");

  // 2. RUT + clave. The RUT is typed as written in the config; a field that formats it does so itself.
  const rutField = await findRutField(form);
  if (!rutField) return fail(form.page(), opts.label, "the login form has no RUT field", "metlife-login-form");
  await typeInto(rutField, opts.rut);
  const password = form.locator('input[type="password"]:visible').first();
  await typeInto(password, opts.clave);
  log(`${opts.label}: RUT and clave filled — submitting`);
  const requestedAt = new Date();
  if (!(await clickSubmit(form, SUBMIT_FORM, opts.label))) await password.press("Enter");

  // 3. The portal (no second factor), a rejection, or the code step.
  let code: Awaited<ReturnType<typeof findCodeField>> = null;
  const codeDeadline = Date.now() + CODE_PAGE_WAIT_MS;
  while (!code && Date.now() < codeDeadline) {
    await page.waitForTimeout(1_000);
    if (await opts.isSignedIn(current(page))) {
      log(`${opts.label}: signed in without a second factor`);
      return current(page);
    }
    const refused = (await findLoginForm(page)) ? await rejection(page) : null;
    if (refused) return fail(page, opts.label, `the RUT or clave was refused — «${refused}»`, "metlife-login-rejected");
    code = await findCodeField(page);
  }
  if (!code) return fail(page, opts.label, `no code step ${CODE_PAGE_WAIT_MS / 1000} s after submitting`, "metlife-code-page");

  // 4. The Clave Dinámica from the mailbox (never printed).
  const value = (await opts.code(requestedAt)).trim();
  if (!/^\d{6}$/.test(value)) throw new Error(`${opts.label}: the code read is not 6 digits`);
  if (code.boxes) {
    const n = await code.fields.count();
    if (n < value.length) return fail(code.frame.page(), opts.label, `${n} code box(es) for a ${value.length}-digit code`, "metlife-code-page");
    for (let i = 0; i < value.length; i++) await typeInto(code.fields.nth(i), value[i]!);
  } else {
    await typeInto(code.fields, value);
  }
  log(`${opts.label}: code entered — submitting`);
  await code.frame.page().waitForTimeout(500);
  if (!(await clickSubmit(code.frame, SUBMIT_CODE, opts.label))) await (code.boxes ? code.fields.last() : code.fields).press("Enter").catch(() => undefined);

  // 5. The portal.
  const deadline = Date.now() + SIGNED_IN_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (await opts.isSignedIn(current(page))) {
      log(`${opts.label}: signed in`);
      return current(page);
    }
    const refused = (await findCodeField(page)) ? await rejection(page) : null;
    if (refused) return fail(page, opts.label, `the code was refused — «${refused}»`, "metlife-code-rejected");
  }
  return fail(page, opts.label, `not signed in ${SIGNED_IN_WAIT_MS / 1000} s after the code`, "metlife-signed-in");
}
