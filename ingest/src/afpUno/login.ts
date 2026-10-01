import type { Frame, Page } from "playwright-core";
import { log } from "../log.js";

/** Links that lead to the private site's sign-in form. */
const LOGIN_LINK = /ingres|iniciar sesi|acceso|mi cuenta|sucursal virtual|clientes/i;

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
  let frame = await findPasswordField(page);
  if (!frame) {
    const link = page.getByRole("link", { name: LOGIN_LINK }).or(page.getByRole("button", { name: LOGIN_LINK })).first();
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
  await rutField.fill("");
  await rutField.fill(rut);
  await password.fill(clave);
  log("RUT and clave filled — submitting");
  await password.press("Enter");
  return true;
}

