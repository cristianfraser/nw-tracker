import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { MOVEMENTS_URL, SELECTOR, TEXT } from "./routes.js";
import { settle, waitForNewApiCalls } from "../wait.js";
import { log, logStep } from "../log.js";
import { racionalListRowKey } from "./movements.js";

/**
 * Two different extraction paths, because Racional serves the two halves differently (see
 * routes.ts): holdings come from `api.racional.cl/positions` and are picked up by the recorder
 * like any XHR, while movements are pushed over a Firestore channel and only exist in readable
 * form in the rendered DOM. The run stages both as JSON; `import:racional-movements` (ingest → server)
 * turns the movement rows into ledger rows.
 */

/** Land on the app home and record whatever it loads. */
export async function openHome(page: Page, recorder: Recorder): Promise<number> {
  logStep("racional — home");
  await settle(page, 15_000);
  await recorder.screenshot(page, "home");
  return recorder.calls.length;
}

export type RacionalMovementRow = {
  /** Row label as printed, e.g. "Compra SLV", "Depósito", "Dividendo". */
  title: string;
  /** Amount exactly as printed, e.g. "US$x.xxx,xx" or "$3.xxx.xxx" — parsed downstream. */
  amount: string;
  /** Printed day, "dd/mm" — no year, which is why `occurred_on` exists. */
  day: string;
  /** `YYYY-MM-DD`, the day joined to the «Año NNNN» separator above the row. */
  occurred_on: string | null;
  /** `.movement-type` class: `buy` | `contribution` | `dividends` | … — not language-dependent. */
  kind_class: string | null;
  /** Canonical id from the detail route; only known for rows the crawl actually opened. */
  movement_id: string | null;
  /** Detail-panel text (units, price, commission, order id); only fetched for trades. */
  detail: string | null;
  /** The dividends-API record matched to this row (dividends only); see {@link RacionalApiDividend}. */
  dividend?: RacionalApiDividend | null;
  /**
   * On every row that needed its detail view (a trade, or a dividend no API record covered):
   * `opened` once the route id and the detail text were read, `unopened` when the row could not
   * be reached (`detail_error` says why). An unopened row is still staged, never dropped — the
   * importer checks the ledger for it and fails only if it would have to write it.
   */
  detail_status?: "opened" | "unopened";
  detail_error?: string;
};

/**
 * One entry of `api.racional.cl/users/movements/dividends`, which the app requests when the
 * movements page loads — so the recorder has it without a single click. It carries what the
 * list row never shows: the instrument, the gross dividend (`DIV`), the US withholding
 * (`DIVTAX`, negative) and the net the wallet received (`amount`). Verified live 2026-09-21:
 * the SOXX dividend the mail announced as US$x,xx was credited as 2,34.
 */
export type RacionalApiDividend = {
  id: string;
  asset_id: string;
  gross: number;
  /** Positive. */
  withholding: number;
  net: number;
  execution_date: string;
  is_interest: boolean;
};

const DIVIDENDS_ENDPOINT_URL = /\/users\/movements\/dividends(?:\?|$)/;
/** The recorder's label for that call (the URL's last path segment, see `Recorder.record`). */
const DIVIDENDS_ENDPOINT = "dividends";

/**
 * The dividends list from the latest successful `/users/movements/dividends` call, or null when
 * the app never made it this run. A response that IS there but has another shape throws: the
 * breakdown feeds the tax record, and a silently unparsed field would import a dividend
 * without its tax (the by-hand fallback is opening the detail view, which the caller keeps for
 * rows this list does not cover).
 */
export function apiDividendsFromRecorder(recorder: Recorder): RacionalApiDividend[] | null {
  const call = [...recorder.calls]
    .reverse()
    .find((c) => c.status === 200 && DIVIDENDS_ENDPOINT_URL.test(c.url));
  if (!call) return null;
  const list = (call.responseBody as { dividends?: unknown } | null)?.dividends;
  if (!Array.isArray(list)) {
    throw new Error("racional: the dividends API response has no `dividends` array — the endpoint shape changed");
  }
  return list.map((raw) => {
    const e = raw as Record<string, unknown>;
    const id = String(e.id ?? "").trim();
    const num = (v: unknown, field: string): number => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) throw new Error(`racional: dividends API entry ${id || "?"} has no numeric ${field}`);
      return n;
    };
    if (!id) throw new Error("racional: dividends API entry without an id");
    return {
      id,
      asset_id: String(e.assetId ?? "").trim().toUpperCase(),
      gross: num(e.DIV, "DIV"),
      withholding: Math.max(0, -num(e.DIVTAX, "DIVTAX")),
      net: num(e.amount, "amount"),
      execution_date: String(e.executionDate ?? ""),
      is_interest: e.isInterest === true || e.isRebateInterest === true,
    };
  });
}

/** The raw response body of that same call, kept verbatim for the importer and as provenance. */
export function rawDividendsResponseFromRecorder(recorder: Recorder): unknown {
  const call = [...recorder.calls]
    .reverse()
    .find((c) => c.status === 200 && DIVIDENDS_ENDPOINT_URL.test(c.url));
  return call?.responseBody ?? null;
}

/** Chile calendar day of an ISO instant — the day the list row prints. */
function chileYmdOfIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
}

/** "US$x,xx" → 2.34; null for anything else (a CLP row can never be a USD dividend). */
function usdAmountOfRow(amount: string): number | null {
  const m = /^US\$\s*(-?[\d.]+(?:,\d+)?)$/i.exec(String(amount ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isDividendRow(row: RacionalMovementRow): boolean {
  return row.kind_class === "dividends" || /^dividendo\b/i.test(row.title);
}

/**
 * Pair a list dividend row with its API record: same Chile day, same net to the cent. Two
 * records matching one row (two equal dividends the same day) is left unmatched — the detail
 * click then resolves it as before, and nothing is guessed.
 */
export function matchApiDividend(
  row: RacionalMovementRow,
  dividends: readonly RacionalApiDividend[],
): RacionalApiDividend | null {
  const net = usdAmountOfRow(row.amount);
  if (net == null || !row.occurred_on) return null;
  const hits = dividends.filter(
    (d) => !d.is_interest && chileYmdOfIso(d.execution_date) === row.occurred_on && Math.abs(d.net - net) <= 0.005,
  );
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * API dividends the rendered list should show but does not. The list is newest-first, so every
 * record dated after the oldest rendered row's day belongs inside the window; one missing means
 * the list was read before the page merged the dividends response into it (a record on that
 * oldest day may legitimately sit just below the window, so it is not counted).
 */
export function apiDividendsMissingFromList(
  rows: readonly RacionalMovementRow[],
  dividends: readonly RacionalApiDividend[],
): RacionalApiDividend[] {
  const days = rows.map((r) => r.occurred_on).filter((d): d is string => d != null).sort();
  const oldest = days[0];
  if (oldest == null) return [];
  return dividends.filter((d) => {
    const day = chileYmdOfIso(d.execution_date);
    if (d.is_interest || day == null || day <= oldest) return false;
    return !rows.some(
      (r) => isDividendRow(r) && r.occurred_on === day && Math.abs((usdAmountOfRow(r.amount) ?? Number.NaN) - d.net) <= 0.005,
    );
  });
}

/**
 * Read the rendered rows in document order.
 *
 * There is no `<a href>` and no routerLink — Ionic navigates from a click handler, so a row's
 * canonical id is simply not in the DOM. What IS there is enough to identify a row without
 * opening it: the year comes from the `<p class="period-label">Año 2026</p>` separator that
 * precedes each group (the row itself only prints "02/07"), and `.movement-type` carries a
 * language-independent kind (`buy`, `contribution`, `dividends`) that beats parsing the Spanish
 * label. That combination is what lets the crawl decide what is new before paying for a click.
 */
async function readRenderedRows(page: Page): Promise<RacionalMovementRow[]> {
  return (await page.evaluate(() => {
    const out: {
      title: string;
      amount: string;
      day: string;
      occurred_on: string | null;
      kind_class: string | null;
    }[] = [];
    // Each row sits in its own wrapper, so there is no shared container to walk — but a
    // combined selector still returns labels and rows in DOCUMENT order, which is all the
    // year-carrying needs. The year is local to this read: a page global would carry one
    // read's last label into the next.
    let year: string | null = null;
    for (const el of Array.from(document.querySelectorAll(".period-label, app-investment-movement"))) {
      if (el.classList.contains("period-label")) {
        const m = /(\d{4})/.exec((el as HTMLElement).innerText || "");
        if (m) year = m[1]!;
        continue;
      }
      const parts = ((el as HTMLElement).innerText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const day = parts[2] ?? "";
      const dm = /^(\d{2})\/(\d{2})$/.exec(day);
      const typeEl = el.querySelector(".movement-type");
      out.push({
        title: parts[0] ?? "",
        amount: parts[1] ?? "",
        day,
        occurred_on: year && dm ? `${year}-${dm[2]}-${dm[1]}` : null,
        kind_class: typeEl
          ? (typeEl.className || "").toString().replace("movement-type", "").trim() || null
          : null,
      });
    }
    return out;
  })) as RacionalMovementRow[];
}

/**
 * Identity of a row as seen in the list, before its detail route is known — e.g.
 * `2026-09-22|buy|US$xxx,xx`; the crawl cursor holds one (see `racionalListRowKey`).
 */
export function rowKey(row: RacionalMovementRow): string {
  return racionalListRowKey(row);
}

/**
 * The rows strictly newer than the watermark row (the list is newest-first) and whether it was
 * found. Not found, or no watermark → every rendered row: a first run, a state written before
 * list keys, or more movements since the last import than the window shows.
 */
export function rowsAboveWatermark(
  rows: readonly RacionalMovementRow[],
  watermarkKey: string | null,
): { fresh: RacionalMovementRow[]; reached: boolean } {
  const cutoff = watermarkKey == null ? -1 : rows.findIndex((r) => rowKey(r) === watermarkKey);
  return { fresh: cutoff >= 0 ? rows.slice(0, cutoff) : [...rows], reached: cutoff >= 0 };
}

/** Index of the `occurrence`-th (0-based) row whose key is `key` — twins share a key — or -1. */
export function nthRowIndex(rows: readonly RacionalMovementRow[], key: string, occurrence: number): number {
  let seen = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rowKey(rows[i]!) !== key) continue;
    if (seen === occurrence) return i;
    seen += 1;
  }
  return -1;
}

/**
 * The canonical id in a detail route's last segment (`…/<uid>_<ISO>_<amount>` for trades,
 * `…/passive/div_…_<TICKER>_<ISO>` for dividends), or null when the page is not on one — every
 * movement id carries its ISO timestamp, and the list itself ends in `/tabs/movements`, so a
 * click that went nowhere can never stage «movements» as an id.
 */
export function movementIdFromDetailUrl(url: string): string | null {
  const last = decodeURIComponent(String(url ?? "").split(/[?#]/)[0]!.split("/").pop() ?? "");
  return /_\d{4}-\d{2}-\d{2}T[\d:.]+Z(?:_|$)/.test(last) ? last : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The rendered rows once two reads a second apart agree (bounded): the page re-renders the list
 * as Firestore snapshots and the dividends response land.
 */
async function readSettledRows(page: Page): Promise<RacionalMovementRow[]> {
  const deadline = Date.now() + 10_000;
  let rows = await readRenderedRows(page);
  while (Date.now() < deadline) {
    await sleep(1_000);
    const again = await readRenderedRows(page);
    if (JSON.stringify(again) === JSON.stringify(rows)) return again;
    rows = again;
  }
  log("movements: the list was still re-rendering after 10s — using its latest state");
  return rows;
}

/** How long one movements-page load may take to bring its dividends response. */
const DIVIDENDS_WAIT_MS = 20_000;

/**
 * Load the movements list and wait until it is COMPLETE.
 *
 * The page merges two sources: Firestore pushes the movements, and the dividend rows come from
 * `/users/movements/dividends`, which the page requests on every load. Read before that response
 * lands, the list has no dividends and its 10-row window reaches further back: on 2026-09-26 the
 * first render lacked both September dividends, the window reached the 07-01 SLV buy, and after
 * the first detail view the list re-rendered with them and pushed the buy out of reach. So wait
 * for this load's response (HTTP 200), for the rows to settle, and for every API dividend the
 * window should show to be in it — reloading once if not.
 *
 * `strict` (the first load, which decides what is new and so where the watermark lands) throws
 * when the list never completes; the reloads between detail views only need to find a row, so
 * they log and return what they have.
 */
async function loadMovementsList(page: Page, recorder: Recorder, strict: boolean): Promise<RacionalMovementRow[]> {
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const baseline = recorder.callsFor(DIVIDENDS_ENDPOINT).length;
    await page.goto(MOVEMENTS_URL, { waitUntil: "domcontentloaded" });
    const arrived = await waitForNewApiCalls(recorder, DIVIDENDS_ENDPOINT, baseline, DIVIDENDS_WAIT_MS);
    await page.locator(SELECTOR.movementRow).first().waitFor({ state: "visible", timeout: 45_000 });
    const rows = await readSettledRows(page);
    const answered = recorder.callsFor(DIVIDENDS_ENDPOINT).slice(baseline);
    if (!arrived) {
      problem = `the page did not request /users/movements/dividends within ${DIVIDENDS_WAIT_MS / 1000}s`;
    } else if (!answered.some((c) => c.status === 200)) {
      problem = `/users/movements/dividends answered HTTP ${answered.map((c) => c.status).join(", ")}`;
    } else {
      const missing = apiDividendsMissingFromList(rows, apiDividendsFromRecorder(recorder) ?? []);
      if (missing.length === 0) return rows;
      problem =
        `the list lacks ${missing.length} dividend(s) the API returned (` +
        missing.map((d) => `${d.asset_id} US$${d.net} on ${chileYmdOfIso(d.execution_date)}`).join(", ") +
        ")";
    }
    log(`movements: list incomplete (load ${attempt}) — ${problem}`);
    if (!strict) return rows;
  }
  throw new Error(`racional: the movements list never completed — ${problem}; not staging an incomplete list`);
}

/**
 * Open one row's detail view: the route is the only place its canonical id exists, and the view
 * carries units, price, commission and order id.
 *
 * The list is re-read before every click and the target found by its list key (its nth
 * occurrence, for twins), never by a position remembered from an earlier render. A row that
 * cannot be reached is flagged `unopened`, never dropped: a dropped row lets the watermark pass
 * it for good, while a flagged one makes the importer look for it in the ledger.
 */
async function openRowDetail(
  page: Page,
  recorder: Recorder,
  row: RacionalMovementRow,
  occurrence: number,
): Promise<void> {
  const key = rowKey(row);
  let reason = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rendered = await readRenderedRows(page);
    const index = nthRowIndex(rendered, key, occurrence);
    if (index < 0) {
      reason = `not among the ${rendered.length} rendered rows`;
      break;
    }
    // The row is re-checked in the page right before the click: a re-render between the read
    // and the click must not open its neighbour.
    const clicked = await page.evaluate(
      ({ selector, i, title, amount, day }) => {
        const el = document.querySelectorAll(selector)[i] as HTMLElement | undefined;
        const parts = (el?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
        if (!el || parts[0] !== title || parts[1] !== amount || (parts[2] ?? "") !== day) return false;
        const item = el.querySelector("ion-item") as HTMLElement | null;
        item?.click();
        return item != null;
      },
      { selector: SELECTOR.movementRow, i: index, title: row.title, amount: row.amount, day: row.day },
    );
    if (!clicked) {
      reason = "the list changed under the click";
      await readSettledRows(page);
      continue;
    }
    await settle(page, 8_000);
    const id = movementIdFromDetailUrl(page.url());
    const detail = id
      ? await page.evaluate(() => {
          const hit = Array.from(document.querySelectorAll("ion-content"))
            .map((c) => (c as HTMLElement).innerText || "")
            .find((t) => /Compraste|Vendiste|Recibiste/i.test(t));
          return hit ?? null;
        })
      : null;
    if (id && detail) {
      row.movement_id = id;
      row.detail = detail;
      row.detail_status = "opened";
    } else {
      reason = id
        ? "its detail view printed no movement text"
        : `the click did not open a movement route (${page.url().split("?")[0]})`;
    }
    // Back to the list either way: the next row is searched in it.
    await loadMovementsList(page, recorder, false);
    if (row.detail_status === "opened") return;
  }
  row.detail_status = "unopened";
  row.detail_error = reason;
  log(`  could not open row ${key} — ${reason}; staged as unopened`);
}

/**
 * Scrape the movements list, newest first, stopping at the watermark.
 *
 * The list is the only readable form of this data (Firestore pushes it, so there is no XHR to
 * intercept). Because it is ordered newest-first, reaching the last movement the importer
 * recorded means everything older is already in the ledger — so the crawl stops there instead
 * of walking history every night. The app renders only the latest 10 rows (scrolling has never
 * loaded more), so with no watermark, or one that fell out of that window, the crawl stages the
 * whole window and says so.
 */
export async function openMovements(
  page: Page,
  recorder: Recorder,
  watermarkKey: string | null,
): Promise<string> {
  logStep("racional — movements");
  lastScrapedMovements = [];
  const before = recorder.calls.length;
  let rows = await loadMovementsList(page, recorder, true);
  await recorder.screenshot(page, "movements");

  const atWatermark = () => watermarkKey != null && rows.some((r) => rowKey(r) === watermarkKey);
  // Scroll until the watermark appears or the list stops growing. The cap is a runaway guard,
  // not a page budget — a first run legitimately needs many passes.
  for (let pass = 0; pass < 60 && !atWatermark(); pass += 1) {
    const seen = rows.length;
    await page.mouse.wheel(0, 4000);
    await settle(page, 4_000);
    rows = await readRenderedRows(page);
    if (rows.length === seen) break; // nothing more loaded
  }

  // Everything strictly newer than the watermark; the watermark row itself is already imported.
  const { fresh, reached } = rowsAboveWatermark(rows, watermarkKey);
  log(
    watermarkKey == null
      ? `movements: ${rows.length} row(s) (no watermark — staging the whole rendered list)`
      : reached
        ? `movements: ${fresh.length} new row(s) (reached watermark after ${rows.length} scanned)`
        : `movements: WARNING watermark NOT reached — ${watermarkKey} is not among the ${rows.length} rendered ` +
          `row(s): all of them are staged, and movements between the oldest of them and the watermark, if any, are missed`,
  );

  // Dividends first, from the API the page already loaded: the record carries the canonical id
  // (its route id), the paying instrument and the gross / withholding behind the credited net —
  // everything the detail click used to be opened for, plus the tax the click never gave.
  const apiDividends = apiDividendsFromRecorder(recorder);
  if (apiDividends) {
    let matched = 0;
    for (const row of fresh) {
      if (!isDividendRow(row) || row.movement_id) continue;
      const hit = matchApiDividend(row, apiDividends);
      if (!hit) continue;
      row.movement_id = hit.id;
      row.dividend = hit;
      matched += 1;
    }
    log(`movements: ${apiDividends.length} API dividend record(s), ${matched} matched to new row(s)`);
  }

  // Only NEW rows are opened, and only trades need to be: the click is the sole way to learn a
  // movement's canonical id (there is no href), and the detail view is where units, price and
  // commission live. A quiet day therefore opens nothing at all.
  // Trades need units/price/commission; a dividend needs its paying instrument, which appears
  // NOWHERE in the list row (no symbol, no logo) and only in the id its route exposes — the API
  // match above covers that, so only a dividend the API did not list is still clicked. Cash
  // rows are fully described by the list, so they are never opened.
  const NEEDS_DETAIL = new Set(["buy", "sell", "dividends"]);
  for (const [i, row] of fresh.entries()) {
    if (row.dividend) continue;
    const needsDetail =
      NEEDS_DETAIL.has(row.kind_class ?? "") || /^(compra|venta|dividendo)\b/i.test(row.title);
    if (!needsDetail) continue;
    // `fresh` is a prefix of `rows`, so this is the row's occurrence among its key twins.
    const occurrence = fresh.slice(0, i).filter((r) => rowKey(r) === rowKey(row)).length;
    try {
      await openRowDetail(page, recorder, row, occurrence);
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      log(`  detail failed for ${rowKey(row)}: ${message}`);
      if (row.detail_status !== "opened") {
        row.detail_status = "unopened";
        row.detail_error = message;
      }
      // Back to the list, or every later row fails the same way.
      await loadMovementsList(page, recorder, false).catch((reloadErr: unknown) =>
        log(`  could not reload the list: ${reloadErr instanceof Error ? reloadErr.message.split("\n")[0] : reloadErr}`),
      );
    }
  }

  const unopened = fresh.filter((r) => r.detail_status === "unopened").length;
  log(`movements: ${recorder.calls.length - before} API call(s) recorded`);
  lastScrapedMovements = fresh;
  return `${fresh.length} new row(s)${unopened > 0 ? `, ${unopened} staged unopened (detail view not reached)` : ""}`;
}

/** Rows from the most recent {@link openMovements}, for the runner to persist. */
let lastScrapedMovements: RacionalMovementRow[] = [];

export function takeScrapedMovements(): RacionalMovementRow[] {
  return lastScrapedMovements;
}

/**
 * Holdings + cash. Unlike movements these come from a real REST endpoint, so simply landing on
 * the home tab makes the app call `api.racional.cl/positions` and the recorder captures the
 * response verbatim — no scraping needed.
 */
export async function openPositions(page: Page, recorder: Recorder): Promise<string> {
  logStep("racional — positions");
  const before = recorder.calls.length;
  const entry = page.getByText(TEXT.home).first();
  if ((await entry.count()) > 0) {
    await entry.click();
  }
  await settle(page, 12_000);
  await recorder.screenshot(page, "positions");
  const calls = recorder.calls.length - before;
  log(`positions: ${calls} API call(s) recorded`);
  return `${calls} API call(s)`;
}
