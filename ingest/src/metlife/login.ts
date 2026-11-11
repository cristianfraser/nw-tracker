/**
 * Sign in to MetLife Hipotecario's «Portal de Clientes» (portaldeclientes.metlife.cl), as the first
 * capture recorded it (2026-11-11). The portal sends the browser to MetLife's Ping sign-in
 * (federate.sso.metlife.com), three pages:
 *
 *   1. «¡Hola! Ingresa tu RUT y Clave de Acceso» — «RUT (Sin puntos, ni guión)», «Clave de
 *      Acceso», «CONTINUAR»;
 *   2. «Valida tu identidad para continuar … Elige dónde recibir tu clave» — «RECIBIR CLAVE POR
 *      EMAIL» / «RECIBIR CLAVE POR SMS», «SIGUIENTE» (the e-mail is chosen: the code is read from
 *      the mailbox);
 *   3. «¡Tu Clave Dinámica fue enviada!» — six boxes, «VALIDAR CLAVE»; the code is valid 15 minutes
 *      and may be requested at most three times, so an attempt asks for it once and never resends.
 *
 * Then the portal (`/PIP/…`). Every wait has a timeout; overlays are closed through their own
 * close control before each navigation and click (`../overlays.ts`); a refused RUT/clave latches
 * MetLife logins off until the Keychain item changes (`metlifeLoginLatch`); any other failure is
 * quoted with a screenshot under `cfraser/scraper-diagnostics/`.
 */
import type { Frame, Locator, Page } from "playwright-core";
import { saveClaveUnicaDiagnostics } from "../claveUnica/login.js";
import { loginLatch } from "../loginLatch.js";
import { log } from "../log.js";
import { clickPastOverlays, dismissOverlays } from "../overlays.js";

export const METLIFE_LOGIN_URL = "https://portaldeclientes.metlife.cl/PIP/login";

/** MetLife's credentials latch: a refused RUT/clave stops further logins until the Keychain item changes. */
export const metlifeLoginLatch = loginLatch({
  fileName: ".metlife-login-rejected.json",
  site: "MetLife",
  credentials: "RUT/Clave de Acceso",
});

export type MetlifeCodeProvider = (requestedAt: Date) => Promise<string>;

export type MetlifeLoginOptions = {
  /** The config's RUT in any format; typed without dots or dash, as the field asks. */
  rut: string;
  clave: string;
  /** Service name for the log and the diagnostics files. */
  label: string;
  code: MetlifeCodeProvider;
};

export type MetlifeLoginStage = "credentials" | "channel" | "code" | "portal" | "unknown";

const CREDENTIALS_PAGE = /Ingresa tu RUT y Clave de Acceso/i;
const CHANNEL_PAGE = /Elige d[oó]nde recibir tu clave/i;
const CODE_PAGE = /Clave Din[aá]mica fue enviada/i;
const CREDENTIALS_REFUSED = /incorrect|inv[aá]lid|no coincide|err[oó]ne|bloquead|no existe/i;
const CODE_REFUSED = /incorrect|inv[aá]lid|no coincide|err[oó]ne|expirad|caducad|bloquead/i;

const PAGE_WAIT_MS = 45_000;
const STEP_WAIT_MS = 60_000;
const POLL_MS = 1_000;
/** How long the code page gets to submit itself after the last digit before «VALIDAR CLAVE» is clicked. */
const CODE_SELF_SUBMIT_WAIT_MS = 4_000;
const TEXT_INPUTS = 'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])';

/** The RUT as the field asks for it: no dots, no dash, the verifier digit kept («12.345.678-9» → «123456789»). */
export function metlifeRutForLogin(rut: string): string {
  const compact = rut.replace(/[.\-\s]/g, "").toUpperCase();
  if (!/^\d{7,8}[0-9K]$/.test(compact)) throw new Error(`MetLife: the configured RUT is not a RUT (expected e.g. 12.345.678-9)`);
  return compact;
}

/** A page of the signed-in portal: portaldeclientes.metlife.cl under /PIP/, never its login route. */
export function isMetlifePortalUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === "portaldeclientes.metlife.cl" && u.pathname.startsWith("/PIP/") && !/^\/PIP\/login\b/i.test(u.pathname);
}

/** Which step of the sign-in a page is, from its URL and its visible text. */
export function metlifeLoginStage(url: string, text: string): MetlifeLoginStage {
  if (isMetlifePortalUrl(url)) return "portal";
  if (CODE_PAGE.test(text)) return "code";
  if (CHANNEL_PAGE.test(text)) return "channel";
  if (CREDENTIALS_PAGE.test(text)) return "credentials";
  return "unknown";
}

/** The visible line refusing what the stage submitted (the RUT/clave, or the code), or null. */
export function metlifeRejection(stage: MetlifeLoginStage, text: string): string | null {
  const pattern = stage === "credentials" ? CREDENTIALS_REFUSED : stage === "code" ? CODE_REFUSED : null;
  if (!pattern) return null;
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l.length < 200 && pattern.test(l)) ?? null;
}

function current(page: Page): Page {
  return page.context().pages().filter((p) => !p.isClosed()).at(-1) ?? page;
}

async function pageText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const frame of page.frames()) {
    try {
      parts.push(await frame.evaluate(() => document.body?.innerText ?? ""));
    } catch {
      // detached frame
    }
  }
  return parts.join("\n");
}

async function stageOf(page: Page): Promise<{ stage: MetlifeLoginStage; text: string; page: Page }> {
  const p = current(page);
  const text = await pageText(p);
  return { stage: metlifeLoginStage(p.url(), text), text, page: p };
}

async function waitForStage(page: Page, wanted: readonly MetlifeLoginStage[], ms: number): Promise<{ stage: MetlifeLoginStage; text: string; page: Page } | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await stageOf(page);
    if (wanted.includes(s.stage)) return s;
    if (Date.now() >= deadline) return null;
    await s.page.waitForTimeout(POLL_MS);
  }
}

/** The frame holding a visible password field (the credentials form). */
async function credentialsFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('input[type="password"]:visible').count()) return frame;
    } catch {
      // detached frame
    }
  }
  return null;
}

async function fail(page: Page, label: string, why: string, tag: string): Promise<never> {
  throw new Error(`${label}: ${why} (${await saveClaveUnicaDiagnostics(current(page), tag)})`);
}

async function typeInto(page: Page, field: Locator, value: string, label: string): Promise<void> {
  await clickPastOverlays(page, field, label, "metlife-login");
  await field.fill("", { timeout: 5_000 }).catch(() => undefined);
  await field.pressSequentially(value, { delay: 40, timeout: 30_000 });
}

async function clickButton(page: Page, scope: Page | Frame, name: RegExp, label: string, tag: string): Promise<void> {
  const button = scope.getByRole("button", { name }).first();
  if (!(await button.count().catch(() => 0))) return fail(page, label, `no «${name.source}» button`, tag);
  log(`${label}: clicking «${(await button.innerText().catch(() => "")).trim().slice(0, 30)}»`);
  await clickPastOverlays(page, button, label, tag);
}

/** Pick «RECIBIR CLAVE POR EMAIL» (a radio, or its label) and check it took. */
async function chooseEmailChannel(page: Page, label: string): Promise<void> {
  const radio = page.getByRole("radio", { name: /email/i }).first();
  if (await radio.count().catch(() => 0)) {
    if (!(await radio.isChecked().catch(() => false))) await clickPastOverlays(page, radio, label, "metlife-channel");
    if (!(await radio.isChecked().catch(() => false))) return fail(page, label, "the e-mail option did not stay selected", "metlife-channel");
    return;
  }
  const option = page.getByText(/RECIBIR CLAVE POR EMAIL/i).first();
  if (!(await option.count().catch(() => 0))) return fail(page, label, "the code-channel page offers no e-mail option", "metlife-channel");
  await clickPastOverlays(page, option, label, "metlife-channel");
}

/** Six boxes, or one field, on the code page. */
async function codeFields(page: Page): Promise<{ fields: Locator; boxes: boolean } | null> {
  for (const frame of page.frames()) {
    try {
      const inputs = frame.locator(TEXT_INPUTS);
      const n = await inputs.count();
      if (n >= 6) return { fields: inputs, boxes: true };
      if (n === 1) return { fields: inputs.first(), boxes: false };
    } catch {
      // detached frame
    }
  }
  return null;
}

export async function signInWithMetlife(page: Page, opts: MetlifeLoginOptions): Promise<Page> {
  const rut = metlifeRutForLogin(opts.rut);
  await dismissOverlays(page, opts.label, "metlife-login");
  await page.goto(METLIFE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // 1. The credentials page (or the portal itself, the session kept by the browser profile).
  const first = await waitForStage(page, ["credentials", "portal"], PAGE_WAIT_MS);
  if (!first) return fail(page, opts.label, `the sign-in page never appeared (${PAGE_WAIT_MS / 1000} s)`, "metlife-login-form");
  if (first.stage === "portal") {
    log(`${opts.label}: already signed in (session kept by the browser profile)`);
    metlifeLoginLatch.clear("MetLife accepted the session");
    return first.page;
  }
  let p = first.page;
  const form = await credentialsFrame(p);
  if (!form) return fail(p, opts.label, "the sign-in page has no password field", "metlife-login-form");
  const labelled = form.getByLabel(/RUT/i).first();
  const rutField = (await labelled.count().catch(() => 0)) ? labelled : form.locator(TEXT_INPUTS).first();
  if (!(await rutField.count().catch(() => 0))) return fail(p, opts.label, "the sign-in page has no RUT field", "metlife-login-form");
  await typeInto(p, rutField, rut, opts.label);
  await typeInto(p, form.locator('input[type="password"]:visible').first(), opts.clave, opts.label);
  log(`${opts.label}: RUT and clave filled — submitting`);
  let requestedAt = new Date();
  await clickButton(p, form, /continuar/i, opts.label, "metlife-login-form");

  // 2. The channel choice (e-mail), once; or straight to the code; or the portal; or a refusal.
  let channelChosen = false;
  const deadline = Date.now() + STEP_WAIT_MS;
  let stage: Awaited<ReturnType<typeof stageOf>>;
  for (;;) {
    await p.waitForTimeout(POLL_MS);
    stage = await stageOf(p);
    p = stage.page;
    if (stage.stage === "portal") {
      log(`${opts.label}: signed in without a second factor`);
      metlifeLoginLatch.clear("MetLife accepted the login");
      return p;
    }
    if (stage.stage === "code") break;
    if (stage.stage === "credentials") {
      const refused = metlifeRejection("credentials", stage.text);
      if (refused) {
        metlifeLoginLatch.recordCredentialsRejected(refused);
        return fail(p, opts.label, `the RUT or clave was refused — «${refused}»`, "metlife-login-rejected");
      }
    }
    if (stage.stage === "channel" && !channelChosen) {
      await chooseEmailChannel(p, opts.label);
      requestedAt = new Date();
      await clickButton(p, p, /siguiente/i, opts.label, "metlife-channel");
      channelChosen = true;
    }
    if (Date.now() >= deadline) return fail(p, opts.label, `no code page ${STEP_WAIT_MS / 1000} s after submitting (${stage.stage} page showing)`, "metlife-code-page");
  }

  // 3. The Clave Dinámica from the mailbox (never printed), into the boxes, then VALIDAR CLAVE.
  const value = (await opts.code(requestedAt)).trim();
  if (!/^\d{6}$/.test(value)) throw new Error(`${opts.label}: the code read is not 6 digits`);
  const code = await codeFields(p);
  if (!code) return fail(p, opts.label, "the code page has neither six boxes nor one code field", "metlife-code-page");
  if (code.boxes) {
    for (let i = 0; i < value.length; i++) await typeInto(p, code.fields.nth(i), value[i]!, opts.label);
  } else {
    await typeInto(p, code.fields, value, opts.label);
  }
  log(`${opts.label}: code entered — validating`);
  // The six boxes submit the code by themselves once the last digit is typed (2026-11-11: the page
  // was already on the portal when «VALIDAR CLAVE» was clicked, and the click timed out). Click it
  // only while the code page is still showing; a click the navigation overtakes is not a failure.
  const submittedBy = Date.now() + CODE_SELF_SUBMIT_WAIT_MS;
  let left = false;
  while (Date.now() < submittedBy) {
    await p.waitForTimeout(POLL_MS);
    const s = await stageOf(p);
    p = s.page;
    if (s.stage !== "code") {
      left = true;
      break;
    }
  }
  if (left) {
    log(`${opts.label}: the code submitted itself`);
  } else {
    try {
      await clickButton(p, p, /validar/i, opts.label, "metlife-code-page");
    } catch (err) {
      const s = await stageOf(p);
      p = s.page;
      if (s.stage !== "portal") throw err;
      log(`${opts.label}: the code page moved on while «VALIDAR CLAVE» was being clicked`);
    }
  }

  // 4. The portal.
  const signedInBy = Date.now() + STEP_WAIT_MS;
  for (;;) {
    await p.waitForTimeout(POLL_MS);
    const s = await stageOf(p);
    p = s.page;
    if (s.stage === "portal") {
      log(`${opts.label}: signed in`);
      metlifeLoginLatch.clear("MetLife accepted the login");
      return p;
    }
    const refused = s.stage === "code" ? metlifeRejection("code", s.text) : null;
    if (refused) return fail(p, opts.label, `the code was refused — «${refused}»`, "metlife-code-rejected");
    if (s.stage === "credentials") return fail(p, opts.label, "sent back to the sign-in page after the code", "metlife-code-rejected");
    if (Date.now() >= signedInBy) return fail(p, opts.label, `not signed in ${STEP_WAIT_MS / 1000} s after the code`, "metlife-signed-in");
  }
}
