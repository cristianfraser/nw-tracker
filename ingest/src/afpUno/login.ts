import type { Frame, Page } from "playwright-core";
import { log } from "../log.js";

/** Links that lead to the private site's sign-in form. */
const LOGIN_LINK = /unonline|ingres|iniciar sesi|acceso|mi cuenta|sucursal virtual|clientes/i;

/** Visible password field in any frame of the page, with its frame. */
async function findPasswordField(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      if (await frame.locator('input[type="password"]:visible').count()) return frame;
    } catch {
      // detached frame
    }
  }
  return null;
}

/**
 * Best effort: open the sign-in form from the homepage and fill RUT + clave. Returns false (and the
 * user signs in by hand) when no form is found — a capture must never guess its way through a page.
 */
export async function tryLogin(page: Page, rut: string, clave: string): Promise<boolean> {
  // The homepage renders its header after load: wait for the form or the link that opens it.
  const link = page.getByRole("link", { name: LOGIN_LINK }).or(page.getByRole("button", { name: LOGIN_LINK })).first();
  let frame = await findPasswordField(page);
  for (let i = 0; i < 30 && !frame && !(await link.count()); i++) {
    await page.waitForTimeout(1_000);
    frame = await findPasswordField(page);
  }
  if (!frame) {
    if (await link.count()) {
      log(`opening the sign-in form via «${(await link.innerText()).trim().slice(0, 40)}»`);
      await link.click();
      for (let i = 0; i < 20 && !frame; i++) {
        await page.waitForTimeout(1_000);
        for (const p of page.context().pages()) {
          frame = await findPasswordField(p);
          if (frame) {
            page = p;
            break;
          }
        }
      }
    }
  }
  if (!frame) return false;
  const password = frame.locator('input[type="password"]:visible').first();
  // The RUT field: the visible text-like input placed before the password field.
  const rutField = frame.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"])').first();
  if (!(await rutField.count())) return false;
  // The drawer's fields are readonly until focused (an anti-autofill trick): click, as a person
  // does, wait for the field to accept input, then type.
  for (const [field, value] of [[rutField, rut], [password, clave]] as const) {
    await field.click();
    for (let i = 0; (await field.getAttribute("readonly")) !== null; i++) {
      if (i >= 50) throw new Error("AFP UNO: a sign-in field stayed readonly after a click");
      await page.waitForTimeout(100);
    }
    await field.fill("");
    await field.pressSequentially(value, { delay: 40 });
  }
  log("RUT and clave filled — submitting");
  await password.press("Enter");
  return true;
}

