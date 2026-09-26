import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { ENDPOINT, ROUTE, SELECTOR, TEXT } from "./routes.js";
import { gotoRoute } from "./login.js";
import { assertApiOk, innerResultCode, isSaldoInicialRow, pick, pickString } from "./payload.js";
import { settle, waitForNewApiCalls } from "../wait.js";
import { ensureDir } from "../paths.js";
import { log, logStep } from "../log.js";

/** Upper bound on swiper clicks — a stop condition in case the carousel loops instead of ending. */
const MAX_SLIDES = 8;

export type CardSlide = {
  index: number;
  /** From the request body (`Entrada.Moneda`): "CLP" or "USD". */
  currency: string | null;
  /** From the request body (`Entrada.Cuenta`) — identifies which card the rows belong to. */
  account: string | null;
  /** `MatrizMovimientos` verbatim, minus the SALDO INICIAL row. */
  rows: unknown[];
  /**
   * The SALDO INICIAL row(s), verbatim and kept apart from `rows`: dated at the card's latest
   * close and valued at that facturación's «Monto total facturado». Not a movement — importing
   * it as one would add the previous bill a second time — but the server reads it as the close's
   * evidence the morning after it happens, days before the statement e-mail.
   */
  saldoInicial: unknown[];
};

export type CardMovementsResult = {
  fetchedAt: string;
  slides: CardSlide[];
};

/**
 * Click through the card carousel, collecting every `consultaUltimosMovimientos` response.
 *
 * Each click loads one card/currency view. We stop when the next button disappears, goes disabled,
 * or stops producing new API calls — whichever comes first.
 */
export async function fetchCardMovements(page: Page, recorder: Recorder): Promise<CardMovementsResult> {
  logStep("credit card — movements");
  await gotoRoute(page, ROUTE.cardUnbilled);
  await recorder.screenshot(page, "card-unbilled-initial");

  // The initial load fetches the first card in CLP; each currency tab and each swiper step adds one call.
  await fetchUsdForCurrentCard(page, recorder, 0);

  for (let slide = 0; slide < MAX_SLIDES; slide++) {
    const next = page.locator(SELECTOR.swiperNext).first();
    if ((await next.count()) === 0) break;
    if (!(await next.isVisible())) break;
    const classes = (await next.getAttribute("class")) ?? "";
    if (classes.includes(SELECTOR.swiperDisabled)) {
      log("swiper reached the last slide");
      break;
    }
    const before = recorder.callsFor(ENDPOINT.cardMovements).length;
    await next.click();
    const gotNew = await waitForNewApiCalls(recorder, ENDPOINT.cardMovements, before);
    await settle(page, 4_000);
    await recorder.screenshot(page, `card-unbilled-slide-${slide + 1}`);
    if (!gotNew) {
      log("swiper click produced no new movements call — stopping");
      break;
    }
    await fetchUsdForCurrentCard(page, recorder, slide + 1);
  }

  const collected: CardSlide[] = recorder.callsFor(ENDPOINT.cardMovements).map((call, index) => {
    assertApiOk(call.responseBody, ENDPOINT.cardMovements);
    const entrada = pick(call.requestBody, "Entrada", "INPUT");
    const data = pick(call.responseBody, "DATA");
    const matrix = pick(data, "MatrizMovimientos");
    const allRows = Array.isArray(matrix) ? matrix : [];
    return {
      index,
      currency: pickString(entrada, "Moneda"),
      account: pickString(entrada, "Cuenta"),
      rows: allRows.filter((row) => !isSaldoInicialRow(row)),
      saldoInicial: allRows.filter((row) => isSaldoInicialRow(row)),
    };
  });

  // Restoring the Pesos tab re-fetches CLP, so each card yields the same CLP payload twice. Keep one
  // entry per (account, currency) — a duplicate slide would double-count on import.
  const byAccountCurrency = new Map<string, CardSlide>();
  for (const slide of collected) {
    byAccountCurrency.set(`${slide.account ?? "?"}|${slide.currency ?? "?"}`, slide);
  }
  const slides = [...byAccountCurrency.values()].map((slide, index) => ({ ...slide, index }));
  const dropped = collected.length - slides.length;
  if (dropped > 0) log(`collapsed ${dropped} duplicate currency re-fetches`);

  for (const slide of slides) {
    log(`slide ${slide.index}: ${slide.currency ?? "?"} · ${slide.rows.length} movements`);
  }
  return { fetchedAt: new Date().toISOString(), slides };
}

export type StatementDownload = {
  /** Billing period derived from "Pagar hasta: 10/MM/YYYY" — the statement bills month MM-1. */
  billingMonth: string | null;
  /** The statement JSON saved for this view. */
  file: string;
};

/**
 * Save the structured statement (`estadoCuentaNacional`) alongside the PDF.
 *
 * Not a replacement for the PDF parse: this endpoint is mainframe output — amounts are zero-padded
 * implied-decimal strings, several per-line fields arrive blank-padded, and the USD side lives on a
 * different endpoint entirely. Collecting it lets the two be diffed on the same statement before
 * anything downstream is allowed to depend on it.
 */
function saveStatementJson(recorder: Recorder, destDir: string): string | null {
  // Matches estadoCuentaNacional and its international/USD sibling, but not the PDF endpoint
  // (`estadoDeCuenta`), whose name starts differently.
  const call = recorder.calls.filter((c) => /^estadoCuenta/i.test(c.endpoint)).at(-1);
  if (!call) return null;
  const input = pick(call.requestBody, "INPUT", "Entrada");
  const account = pickString(input, "Cuenta") ?? "unknown";
  const extracto = pickString(input, "NumExtracto") ?? "0";
  const dest = path.join(ensureDir(destDir), `${account}-extracto-${extracto}-${call.endpoint}.json`);
  fs.writeFileSync(dest, JSON.stringify(call.responseBody, null, 2));
  return dest;
}

/**
 * Save the statement JSON of every card and currency in the billed view («Movimientos
 * facturados»).
 *
 * The page requests the statement PDF (`estadoDeCuenta`) by itself when each view loads. Its
 * answer is logged, never waited for: until 2026-09-26 the step clicked «Ver estado de cuenta» and
 * waited 60 s for a second request, twice per view, and none ever came — eight of the step's ten
 * minutes, every night. The endpoint had answered every request since 2026-08 with the bank's own
 * code 16 timeout, and the statement PDFs arrive by e-mail (`fetch:santander-docs`), so nothing
 * here downloads one.
 */
export async function fetchCardStatements(
  page: Page,
  recorder: Recorder,
  jsonDir: string,
): Promise<StatementDownload[]> {
  logStep("credit card — statements");
  await gotoRoute(page, ROUTE.cardBilled);
  await recorder.screenshot(page, "card-billed-initial");

  const saved: StatementDownload[] = [];
  const pdfCalls = { logged: 0 };
  for (let slide = 0; slide < MAX_SLIDES; slide++) {
    // The billed view carries the same Pesos/Dólares tabs as the movements view, and the USD
    // statement is its own backend call — so each currency has to be visited to be captured at all.
    for (const currency of ["Pesos", "Dólares"] as const) {
      const label = `slide ${slide + 1}/${currency}`;
      try {
        if (currency === "Dólares" && !(await selectCurrencyTab(page, TEXT.currencyUsd))) {
          log(`${label}: no Dólares tab`);
          continue;
        }
        saved.push(...(await captureStatementJson(page, recorder, jsonDir, label, pdfCalls)));
      } catch (err) {
        // One card must not cost us the others: a dormant card's endpoints can time out
        // bank-side, which must not stop the step before the active card is reached.
        log(`${label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      await recorder.screenshot(page, `card-billed-slide-${slide + 1}-${currency === "Pesos" ? "clp" : "usd"}`);
    }
    await selectCurrencyTab(page, TEXT.currencyClp);

    const next = page.locator(SELECTOR.swiperNext).first();
    if ((await next.count()) === 0 || !(await next.isVisible())) break;
    const classes = (await next.getAttribute("class")) ?? "";
    if (classes.includes(SELECTOR.swiperDisabled)) break;
    await next.click();
    await settle(page, 4_000);
  }
  return saved;
}

/** Click a currency tab if it exists. Returns false when the view has no such tab. */
async function selectCurrencyTab(page: Page, label: RegExp): Promise<boolean> {
  const tab = page.getByText(label).first();
  if ((await tab.count()) === 0) return false;
  await tab.click();
  await settle(page, 4_000);
  return true;
}

/** Save the statement JSON for the current view and log what the page's own PDF request got. */
async function captureStatementJson(
  page: Page,
  recorder: Recorder,
  jsonDir: string,
  label: string,
  pdfCalls: { logged: number },
): Promise<StatementDownload[]> {
  const billingMonth = await readBillingMonth(page);
  const jsonFile = saveStatementJson(recorder, jsonDir);
  if (jsonFile) log(`${label}: statement JSON → ${path.basename(jsonFile)}`);

  const calls = recorder.callsFor("estadoDeCuenta");
  for (const call of calls.slice(pdfCalls.logged)) {
    const data = pick(call.responseBody, "DATA");
    const hasPdf = Boolean(pickString(data, "imgNbs64"));
    const inner = innerResultCode(call.responseBody);
    log(
      `${label}: the page's statement-PDF request answered ` +
        (hasPdf
          ? "with a PDF (not saved — statement PDFs come by e-mail)"
          : inner
            ? `${inner.code} — ${inner.message}`
            : "without a PDF"),
    );
  }
  pdfCalls.logged = calls.length;
  return jsonFile ? [{ billingMonth, file: jsonFile }] : [];
}

/**
 * Click the "Dólares" tab so the USD side of the current card loads, then restore "Pesos".
 *
 * USD is not fetched by the swiper: each currency is its own `consultaUltimosMovimientos` call,
 * distinguished only by `Entrada.Moneda` (confirmed 2026-08-04 — a full swiper walk produced CLP
 * calls exclusively). Restoring the Pesos tab keeps the next slide's default view predictable.
 */
async function fetchUsdForCurrentCard(page: Page, recorder: Recorder, slide: number): Promise<void> {
  const usdTab = page.getByText(TEXT.currencyUsd).first();
  if ((await usdTab.count()) === 0) {
    log(`slide ${slide}: no currency tabs — CLP only`);
    return;
  }
  const before = recorder.callsFor(ENDPOINT.cardMovements).length;
  await usdTab.click();
  if (!(await waitForNewApiCalls(recorder, ENDPOINT.cardMovements, before, 15_000))) {
    log(`slide ${slide}: Dólares tab produced no call (card may have no USD side)`);
  }
  await recorder.screenshot(page, `card-unbilled-slide-${slide}-usd`);
  const clpTab = page.getByText(TEXT.currencyClp).first();
  if ((await clpTab.count()) > 0) await clpTab.click();
  await settle(page, 3_000);
}

/** Parse "Pagar hasta: 10/MM/YYYY" into the YYYY-MM facturación it settles (month − 1). */
async function readBillingMonth(page: Page): Promise<string | null> {
  // The billed view renders two <body> elements, so a strict single-element innerText() throws
  // ("resolved to 2 elements") — read them all; the pay-by text lives in whichever is real.
  const body = (await page.locator("body").allInnerTexts()).join("\n");
  const match = TEXT.payBy.exec(body);
  if (!match) return null;
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(month) || !Number.isFinite(year)) return null;
  const billingMonth = month === 1 ? 12 : month - 1;
  const billingYear = month === 1 ? year - 1 : year;
  return `${billingYear}-${String(billingMonth).padStart(2, "0")}`;
}
