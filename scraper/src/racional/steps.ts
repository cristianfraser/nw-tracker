import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { MOVEMENTS_URL, SELECTOR, TEXT } from "./routes.js";
import { settle } from "../wait.js";
import { log, logStep } from "../log.js";

/**
 * Two different extraction paths, because Racional serves the two halves differently (see
 * routes.ts): holdings come from `api.racional.cl/positions` and are picked up by the recorder
 * like any XHR, while movements are pushed over a Firestore channel and only exist in readable
 * form in the rendered DOM.
 *
 * Still capture-first: the row/detail scrape below is verified against the live app, but no
 * importer consumes it yet, so a run writes JSON for inspection rather than touching the
 * ledger.
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
};

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
    // year-carrying needs.
    for (const el of Array.from(document.querySelectorAll(".period-label, app-investment-movement"))) {
      if (el.classList.contains("period-label")) {
        const m = /(\d{4})/.exec((el as HTMLElement).innerText || "");
        if (m) (globalThis as { __racionalYear?: string }).__racionalYear = m[1]!;
        continue;
      }
      const year = (globalThis as { __racionalYear?: string }).__racionalYear ?? null;
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

/** Identity of a row as seen in the list, before its detail route is known. */
function rowKey(row: RacionalMovementRow): string {
  return `${row.occurred_on ?? row.day}|${row.kind_class ?? row.title}|${row.amount}`;
}

/**
 * Scrape the movements list, newest first, stopping at the watermark.
 *
 * The list is the only readable form of this data (Firestore pushes it, so there is no XHR to
 * intercept) and it lazy-loads as you scroll. Because it is ordered newest-first, reaching the
 * last movement the importer recorded means everything older is already in the ledger — so the
 * crawl stops there instead of walking years of history every night. With no watermark (first
 * run) it walks until the list stops growing.
 */
export async function openMovements(
  page: Page,
  recorder: Recorder,
  watermarkKey: string | null,
): Promise<string> {
  logStep("racional — movements");
  const before = recorder.calls.length;
  await page.goto(MOVEMENTS_URL, { waitUntil: "domcontentloaded" });
  await settle(page, 12_000);
  await page.locator(SELECTOR.movementRow).first().waitFor({ state: "visible", timeout: 45_000 });
  await recorder.screenshot(page, "movements");

  let rows = await readRenderedRows(page);
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
  const cutoff = watermarkKey != null ? rows.findIndex((r) => rowKey(r) === watermarkKey) : -1;
  const fresh = cutoff >= 0 ? rows.slice(0, cutoff) : rows;
  log(
    watermarkKey == null
      ? `movements: ${rows.length} row(s) (no watermark — full crawl)`
      : cutoff >= 0
        ? `movements: ${fresh.length} new row(s) (reached watermark after ${rows.length} scanned)`
        : `movements: ${fresh.length} row(s) — watermark NOT reached; the list may have been reordered`,
  );

  // Only NEW rows are opened, and only trades need to be: the click is the sole way to learn a
  // movement's canonical id (there is no href), and the detail view is where units, price and
  // commission live. A quiet day therefore opens nothing at all.
  // Trades need units/price/commission; a dividend needs its paying instrument, which appears
  // NOWHERE in the list row (no symbol, no logo) and only in the id its route exposes. Cash
  // rows are fully described by the list, so they are never opened.
  const NEEDS_DETAIL = new Set(["buy", "sell", "dividends"]);
  for (const row of fresh) {
    const needsDetail =
      NEEDS_DETAIL.has(row.kind_class ?? "") || /^(compra|venta|dividendo)\b/i.test(row.title);
    if (!needsDetail) continue;
    try {
      const opened = await page.evaluate((key) => {
        let year: string | null = null;
        for (const el of Array.from(
          document.querySelectorAll(".period-label, app-investment-movement"),
        )) {
          if (el.classList.contains("period-label")) {
            const m = /(\d{4})/.exec((el as HTMLElement).innerText || "");
            if (m) year = m[1]!;
            continue;
          }
          const parts = ((el as HTMLElement).innerText || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          const dm = /^(\d{2})\/(\d{2})$/.exec(parts[2] ?? "");
          const typeEl = el.querySelector(".movement-type");
          const kind = typeEl
            ? (typeEl.className || "").toString().replace("movement-type", "").trim()
            : "";
          const on = year && dm ? `${year}-${dm[2]}-${dm[1]}` : parts[2];
          if (`${on}|${kind || parts[0]}|${parts[1]}` !== key) continue;
          (el.querySelector("ion-item") as HTMLElement | null)?.click();
          return true;
        }
        return false;
      }, rowKey(row));
      if (!opened) {
        log(`  could not open row ${rowKey(row)} — skipping its detail`);
        continue;
      }
      await settle(page, 8_000);
      // The route is the only place the canonical id exists.
      row.movement_id = decodeURIComponent(page.url().split("?")[0]!.split("/").pop() ?? "") || null;
      row.detail = await page.evaluate(() => {
        const hit = Array.from(document.querySelectorAll("ion-content"))
          .map((c) => (c as HTMLElement).innerText || "")
          .find((t) => /Compraste|Vendiste|Recibiste/i.test(t));
        return hit ?? null;
      });
      await page.goto(MOVEMENTS_URL, { waitUntil: "domcontentloaded" });
      await settle(page, 6_000);
    } catch (err) {
      log(`  detail failed for ${rowKey(row)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  log(`movements: ${recorder.calls.length - before} API call(s) recorded`);
  lastScrapedMovements = fresh;
  return `${fresh.length} new row(s)`;
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
