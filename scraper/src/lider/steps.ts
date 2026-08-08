import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { TEXT } from "./routes.js";
import { downloadTo, settle } from "../wait.js";
import { log, logStep } from "../log.js";

/**
 * Open the full movements view from the homepage's "últimos movimientos" panel.
 *
 * Unlike Santander, this bank's API is not yet known — the first capture run is what reveals the
 * endpoints and payload shapes. Until then these steps navigate and record rather than parse, which
 * is why nothing here extracts amounts.
 */
export async function openMovements(page: Page, recorder: Recorder): Promise<void> {
  logStep("lider — movements");
  await recorder.screenshot(page, "home");
  const more = page.getByText(TEXT.moreMovements).first();
  if ((await more.count()) === 0) {
    throw new Error('"Ver más movimientos" not found on the homepage — the layout may have changed.');
  }
  await more.click();
  await settle(page);
  await recorder.screenshot(page, "movements");
}

/** Visit both movement tabs; nacionales carries CLP, internacionales USD. */
export async function captureBothCurrencies(page: Page, recorder: Recorder): Promise<string[]> {
  const visited: string[] = [];
  for (const [label, pattern] of [
    ["nacionales", TEXT.nacionales],
    ["internacionales", TEXT.internacionales],
  ] as const) {
    const tab = page.getByText(pattern).first();
    if ((await tab.count()) === 0) {
      log(`tab "${label}" not found`);
      continue;
    }
    const before = recorder.calls.length;
    await tab.click();
    await settle(page, 8_000);
    await recorder.screenshot(page, `movements-${label}`);
    log(`${label}: ${recorder.calls.length - before} API calls`);
    visited.push(label);
  }
  return visited;
}

/**
 * Download the statement PDF ("Descargar estado de cuenta").
 *
 * Kept as a real download here — unlike Santander, there is no evidence yet that this bank delivers
 * the PDF as base64 in JSON. If no download event fires, the capture will show which call carried it.
 */
export async function downloadStatement(page: Page, recorder: Recorder, destDir: string): Promise<string> {
  logStep("lider — statement");
  const section = page.getByText(TEXT.statementSection).first();
  if ((await section.count()) > 0) {
    await section.click();
    await settle(page);
  }
  await recorder.screenshot(page, "statement");
  const trigger = page.getByText(TEXT.downloadStatement).first();
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  return downloadTo(page, destDir, async () => {
    await trigger.click();
  });
}
