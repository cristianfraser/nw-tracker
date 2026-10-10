import type { Page } from "playwright-core";
import type { ApiCall, Recorder } from "../capture.js";
import { ROUTE, TEXT } from "./routes.js";
import { openRoute } from "./navigate.js";
import { transactionsRequestAccount } from "./checkingUsd.js";
import { downloadTo, waitForNewApiCalls } from "../wait.js";
import { logStep } from "../log.js";

/** How long the movements page gets to ask for the peso account's transactions and show its button. */
const PAGE_READY_WAIT_MS = 20_000;

/**
 * Whether a recorded call is the checking transactions call for the PESO account: one of the
 * two transactions endpoints (Apigee `transactions`, Tibco `mvtosYDeposiDocCtas`) whose request
 * body names no currency or the peso. The movements page opens on the peso account and makes
 * this call as it loads; it is what the step waits for instead of `networkidle`.
 */
export function isPesoTransactionsCall(call: Pick<ApiCall, "url" | "requestBody">): boolean {
  const request = transactionsRequestAccount(call.url, call.requestBody);
  if (!request) return false;
  return request.currency === null || /clp|peso|^\s*\$\s*$/i.test(request.currency);
}

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
  const baseline = recorder.calls.filter(isPesoTransactionsCall).length;
  await openRoute(page, ROUTE.checkingMovements);
  // The first text match is not always the button on screen: on 2026-10-02 it resolved to a
  // hidden copy and the click waited 45 s for it to become visible.
  const button = page.getByText(TEXT.downloadCheckingMovements).filter({ visible: true }).first();
  // The page is ready when it has asked for the peso account's rows and shows the button.
  if (!(await waitForNewApiCalls(recorder, isPesoTransactionsCall, baseline, PAGE_READY_WAIT_MS))) {
    throw new Error("checking movements: no peso transactions call after opening the movements view");
  }
  await button.waitFor({ state: "visible", timeout: PAGE_READY_WAIT_MS });
  await recorder.screenshot(page, "checking-movements");
  return downloadTo(page, destDir, async () => {
    await button.click();
  });
}

// The monthly cartola used to be downloaded here as an `.xlsx`. It now arrives as the PDF Santander
// mails every month ("Cartola Mensual de Cuentas."), fetched by `fetch:santander-docs` — one less
// authenticated navigation against a bank that is sensitive to traffic, and the PDF is the document
// the organizer already classifies. The web session is scoped to daily movements only.
