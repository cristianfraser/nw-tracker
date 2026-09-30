import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { ROUTE, TEXT } from "./routes.js";
import { gotoRoute } from "./login.js";
import { downloadTo } from "../wait.js";
import { logStep } from "../log.js";

/**
 * Cuenta corriente — "Descargar últimos movimientos".
 *
 * The `.xlsx` this produces is already understood downstream by
 * `server/src/checkingUltimosMovimientosParse.ts`, so it goes to the inbox untouched.
 */
export async function fetchCheckingMovements(
  page: Page,
  recorder: Recorder,
  destDir: string,
): Promise<string> {
  logStep("cuenta corriente — movements");
  await gotoRoute(page, ROUTE.checkingMovements);
  await recorder.screenshot(page, "checking-movements");
  return downloadTo(page, destDir, async () => {
    await page.getByText(TEXT.downloadCheckingMovements).first().click();
  });
}

// The monthly cartola used to be downloaded here as an `.xlsx`. It now arrives as the PDF Santander
// mails every month ("Cartola Mensual de Cuentas."), fetched by `fetch:santander-docs` — one less
// authenticated navigation against a bank that is sensitive to traffic, and the PDF is the document
// the organizer already classifies. The web session is scoped to daily movements only.
