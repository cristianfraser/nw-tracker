import type { Page, Response } from "playwright-core";
import type { Recorder } from "../capture.js";
import { APP_ORIGIN, HOME_URL, POSITIONS_URL, SELECTOR } from "./routes.js";
import { settle } from "../wait.js";
import { log, logStep } from "../log.js";
import { normalizeRacionalListRowKey, racionalListRowKey, type RacionalScrapedRow } from "./movements.js";
import {
  isRacionalDetailResultFor,
  isRacionalMovementsListResult,
  racionalDividendRecord,
  racionalMovementsListPage,
  racionalPrintedAmount,
  racionalTradeFill,
  racionalTypeNeedsDetail,
  racionalWithdrawalLiquidation,
  serverFnResult,
  stagedRowFromListRow,
  type RacionalApiListPage,
} from "./appData.js";

/**
 * The crawl reads Racional's own data, not the page (since the 2026-11 rebuild, `appData.ts`):
 * opening «Movimientos» makes the app ask its server for the list (newest first, 100 rows), and
 * opening a movement asks for that movement's detail. Both answers are taken from the network as
 * the page receives them; the crawl never calls the server itself.
 *
 * Only navigation INSIDE the app asks: a page loaded by URL arrives with its data rendered on
 * the server, and no answer crosses the network (seen 2026-11-18). So the crawl opens the list
 * from the app's menu and each movement by clicking its row.
 */

/** A staged row (the importer's `RacionalScrapedRow`). */
export type RacionalMovementRow = RacionalScrapedRow;

/** Land on the app home and record whatever it loads. */
export async function openHome(page: Page, recorder: Recorder): Promise<number> {
  logStep("racional — home");
  await settle(page, 15_000);
  await recorder.screenshot(page, "home");
  return recorder.calls.length;
}

const LIST_WAIT_MS = 45_000;
const DETAIL_WAIT_MS = 30_000;

/** The decoded result of a server-function answer, or null for any other response. */
async function serverFnResultOf(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.url().startsWith(`${APP_ORIGIN}/_serverFn/`) || response.status() !== 200) return null;
  const body = await response.json().catch(() => null);
  return serverFnResult(body);
}

/** Run `act` (a navigation inside the app) and wait for the first server answer `accept` takes; the wait starts first. */
async function awaitResultDuring<T>(
  page: Page,
  act: () => Promise<void>,
  accept: (result: Record<string, unknown>) => T | null,
  timeoutMs: number,
  what: string,
): Promise<T> {
  // The predicate runs once per response, possibly concurrently: only a match writes, and an
  // answer that is ours but unreadable is kept as the error to throw (not a timeout).
  let accepted: T | null = null;
  let unreadable: unknown = null;
  const waiting = page.waitForResponse(
    async (response) => {
      const result = await serverFnResultOf(response).catch(() => null);
      if (result == null || accepted != null || unreadable != null) return false;
      try {
        const value = accept(result);
        if (value == null) return false;
        accepted = value;
      } catch (err) {
        unreadable = err;
      }
      return true;
    },
    { timeout: timeoutMs },
  );
  await act();
  try {
    await waiting;
  } catch {
    throw new Error(`racional: ${what} never arrived within ${timeoutMs / 1000}s`);
  }
  if (unreadable != null) throw unreadable;
  return accepted as T;
}

/** Whether a staged row is the one a stored cursor names (the cursor may carry a `pending-` state). */
function rowMatchesKey(row: RacionalMovementRow, storedKey: string): boolean {
  return racionalListRowKey(row) === normalizeRacionalListRowKey(storedKey);
}

/**
 * The rows strictly newer than the watermark row (the list is newest-first) and whether it was
 * found. Not found, or no watermark → every row: a first run, or more movements since the last
 * import than the first page holds.
 */
export function rowsAboveWatermark(
  rows: readonly RacionalMovementRow[],
  watermarkKey: string | null,
): { fresh: RacionalMovementRow[]; reached: boolean } {
  const cutoff = watermarkKey == null ? -1 : rows.findIndex((r) => rowMatchesKey(r, watermarkKey));
  return { fresh: cutoff >= 0 ? rows.slice(0, cutoff) : [...rows], reached: cutoff >= 0 };
}

type RenderedRow = { label: string; amount: string };

/** The list's rendered rows in order: label and amount of every clickable row. */
async function renderedRows(page: Page): Promise<RenderedRow[]> {
  return page.evaluate(
    ({ row, label, amount }) =>
      Array.from(document.querySelectorAll(row))
        .map((el) => ({
          label: ((el.querySelector(label) as HTMLElement | null)?.innerText ?? "").trim(),
          amount: ((el.querySelector(amount) as HTMLElement | null)?.innerText ?? "").trim(),
        }))
        .filter((r) => r.label && r.amount),
    { row: SELECTOR.movementRow, label: SELECTOR.movementLabel, amount: SELECTOR.movementAmount },
  );
}

/** Wait (bounded) until the list shows at least `count` rows. */
async function waitForRenderedRows(page: Page, count: number): Promise<RenderedRow[]> {
  const deadline = Date.now() + 20_000;
  let rows = await renderedRows(page);
  while (rows.length < count && Date.now() < deadline) {
    await page.waitForTimeout(500);
    rows = await renderedRows(page);
  }
  return rows;
}

/**
 * Read one row's detail answer into the row, by clicking the row at its position in the list.
 * The rendered list is checked against the answer's rows up to that position (label and amount)
 * before the click, so a re-render can never open a neighbour. A detail that does not arrive
 * leaves the row `unopened`, never dropped: a dropped row lets the watermark pass it for good,
 * while a flagged one makes the importer look for it in the ledger and fail only if it would
 * have to write it.
 */
async function readRowDetail(page: Page, rows: readonly RacionalMovementRow[], index: number): Promise<void> {
  const row = rows[index]!;
  const id = row.movement_id!;
  const type = row.api_type!;
  try {
    const rendered = await waitForRenderedRows(page, index + 1);
    for (let i = 0; i <= index; i += 1) {
      const r = rendered[i];
      if (!r || r.label !== rows[i]!.title || racionalPrintedAmount(r.amount) !== rows[i]!.amount) {
        throw new Error(`the rendered list does not match the answer at row ${i} (${r ? `${r.label} ${r.amount}` : "missing"})`);
      }
    }
    const result = await awaitResultDuring(
      page,
      () =>
        page
          .locator(SELECTOR.movementRow)
          .filter({ has: page.locator(SELECTOR.movementLabel) })
          .filter({ has: page.locator(SELECTOR.movementAmount) })
          .nth(index)
          .click(),
      (r) => (isRacionalDetailResultFor(r, id) ? r : null),
      DETAIL_WAIT_MS,
      `the detail of ${id}`,
    );
    if (type === "dividend") row.dividend = racionalDividendRecord(result, id);
    else if (type === "withdrawal") row.liquidation = racionalWithdrawalLiquidation(result, id);
    else row.fill = racionalTradeFill(result, id);
    row.detail_status = "opened";
  } catch (err) {
    row.detail_status = "unopened";
    row.detail_error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    log(`  could not read the detail of ${racionalListRowKey(row)} — ${row.detail_error}; staged as unopened`);
  }
  // Back to the list for the next row (history keeps it inside the app).
  if (!new URL(page.url()).pathname.replace(/\/$/, "").endsWith("/movements")) {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
}

/**
 * Read the movements list, newest first, stopping at the watermark, and the detail of every new
 * row that needs one (a trade's fill, a dividend's breakdown, what a Retiro sold). The first page
 * holds 100 rows; a watermark below it stages the whole page and says so.
 */
export async function openMovements(page: Page, recorder: Recorder, watermarkKey: string | null): Promise<string> {
  logStep("racional — movements");
  lastScrapedMovements = [];
  const before = recorder.calls.length;
  // The list is asked for only by a navigation inside the app: from the home, its menu link.
  if (new URL(page.url()).pathname.startsWith("/movements")) await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  const listPage = await awaitResultDuring<RacionalApiListPage>(
    page,
    () => page.locator(SELECTOR.movementsLink).first().click(),
    (r) => (isRacionalMovementsListResult(r) ? racionalMovementsListPage(r) : null),
    LIST_WAIT_MS,
    "the movements list",
  );
  await settle(page, 8_000);
  await recorder.screenshot(page, "movements");
  const rows = listPage.rows.map(stagedRowFromListRow);

  const { fresh, reached } = rowsAboveWatermark(rows, watermarkKey);
  log(
    watermarkKey == null
      ? `movements: ${rows.length} row(s) (no watermark — staging the whole first page)`
      : reached
        ? `movements: ${fresh.length} new row(s) (reached watermark after ${rows.length} listed)`
        : `movements: WARNING watermark NOT reached — ${watermarkKey} is not among the ${rows.length} listed ` +
          `row(s)${listPage.next_cursor ? " (older pages exist)" : ""}: all of them are staged, and movements between ` +
          `the oldest of them and the watermark, if any, are missed`,
  );

  // `fresh` is a prefix of `rows`, so a fresh row's index is its position in the list.
  for (const [i, row] of fresh.entries()) {
    if (racionalTypeNeedsDetail(row.api_type ?? "")) await readRowDetail(page, rows, i);
  }

  const unopened = fresh.filter((r) => r.detail_status === "unopened").length;
  log(`movements: ${recorder.calls.length - before} API call(s) recorded`);
  lastScrapedMovements = fresh;
  return `${fresh.length} new row(s)${unopened > 0 ? `, ${unopened} staged unopened (detail not read)` : ""}`;
}

/** Rows from the most recent {@link openMovements}, for the runner to persist. */
let lastScrapedMovements: RacionalMovementRow[] = [];

export function takeScrapedMovements(): RacionalMovementRow[] {
  return lastScrapedMovements;
}

/** Holdings: landing on «Stocks» makes the app load them, which the recorder keeps (not read yet). */
export async function openPositions(page: Page, recorder: Recorder): Promise<string> {
  logStep("racional — positions");
  const before = recorder.calls.length;
  await page.goto(POSITIONS_URL, { waitUntil: "domcontentloaded" });
  await settle(page, 12_000);
  await recorder.screenshot(page, "positions");
  const calls = recorder.calls.length - before;
  log(`positions: ${calls} API call(s) recorded`);
  return `${calls} API call(s)`;
}
