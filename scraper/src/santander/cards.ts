import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { Recorder } from "../capture.js";
import { ENDPOINT, ROUTE, SELECTOR, TEXT } from "./routes.js";
import { gotoRoute } from "./login.js";
import { assertApiOk, innerResultCode, isSaldoInicialRow, pick, pickString } from "./payload.js";
import { settle, waitForNewApiCalls } from "../wait.js";
import { ensureDir } from "../paths.js";
import { hasDocument, recordDocument } from "../documentLedger.js";
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
  droppedSaldoInicial: number;
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
    const rows = allRows.filter((row) => !isSaldoInicialRow(row));
    return {
      index,
      currency: pickString(entrada, "Moneda"),
      account: pickString(entrada, "Cuenta"),
      rows,
      droppedSaldoInicial: allRows.length - rows.length,
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
  file: string;
};

/**
 * Save the statement PDF that arrived as base64 inside an `estadoDeCuenta` response.
 *
 * The bank does not serve this as a file download — the SPA renders bytes it got in JSON — so the
 * filename is ours to build. `80_<seq>_<account>_<YYYYMMDD>.pdf` is the shape the inbox organizer
 * parses, and it maps the account to a card via `cfraser/organize-identifiers.json`.
 */
function saveStatementPdfFromBase64(base64: string, account: string, yyyymmdd: string, destDir: string): string {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new Error("statement PDF payload decoded to zero bytes");
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error("statement payload is not a PDF (missing %PDF header)");
  }
  const dest = path.join(ensureDir(destDir), `80_1_${account}_${yyyymmdd}.pdf`);
  fs.writeFileSync(dest, bytes);
  log(`saved ${path.basename(dest)} (${Math.round(bytes.length / 1024)} KB)`);
  return dest;
}

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

/** Pull the statement PDF out of whichever `estadoDeCuenta` call the page just made. */
function statementPdfFromCalls(recorder: Recorder): { base64: string; account: string; date: string } | null {
  for (const call of [...recorder.callsFor("estadoDeCuenta")].reverse()) {
    const data = pick(call.responseBody, "DATA");
    const base64 = pickString(data, "imgNbs64");
    if (!base64) continue;
    const entrada = pick(call.requestBody, "Entrada", "INPUT");
    const account = pickString(entrada, "Cuenta") ?? "unknown";
    const date = pickString(entrada, "Fecha") ?? "";
    if (!/^\d{8}$/.test(date)) continue;
    return { base64, account, date };
  }
  return null;
}

/**
 * Download available credit-card statements ("Ver estado de cuenta") from the billed view.
 *
 * The page prints "Pagar hasta: 10/MM/YYYY"; that pay-by date belongs to the facturación of the
 * PREVIOUS month, which is the month recorded here.
 */
export async function fetchCardStatements(
  page: Page,
  recorder: Recorder,
  destDir: string,
  jsonDir: string,
): Promise<StatementDownload[]> {
  logStep("credit card — statements");
  await gotoRoute(page, ROUTE.cardBilled);
  await recorder.screenshot(page, "card-billed-initial");

  const downloads: StatementDownload[] = [];
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
        downloads.push(...(await captureStatements(page, recorder, destDir, jsonDir, label)));
      } catch (err) {
        // One card must not cost us the others: the first card in the carousel is dormant and its
        // statement endpoint times out bank-side, which previously aborted the step before the
        // active card was ever reached.
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
  return downloads;
}

/** Click a currency tab if it exists. Returns false when the view has no such tab. */
async function selectCurrencyTab(page: Page, label: RegExp): Promise<boolean> {
  const tab = page.getByText(label).first();
  if ((await tab.count()) === 0) return false;
  await tab.click();
  await settle(page, 4_000);
  return true;
}

/** Save the statement JSON for the current view and download every statement PDF it offers. */
async function captureStatements(
  page: Page,
  recorder: Recorder,
  destDir: string,
  jsonDir: string,
  label: string,
): Promise<StatementDownload[]> {
  const billingMonth = await readBillingMonth(page);
  // The JSON is free — the page already fetched it — so it is always saved, even when the PDF for
  // this facturación is already on disk.
  const jsonFile = saveStatementJson(recorder, jsonDir);
  if (jsonFile) log(`${label}: statement JSON → ${path.basename(jsonFile)}`);

  const out: StatementDownload[] = [];
  // A facturación's PDF never changes once issued, so ask for it exactly once.
  const ledgerKey = `${label.split("/")[1] ?? "?"}|${billingMonth ?? "?"}`;
  if (billingMonth && hasDocument("santander", "statement", ledgerKey)) {
    log(`${label}: ${billingMonth} statement already fetched — skipped`);
    return out;
  }
  // Matched by text, not role: the trigger is a link on some views and a button on others.
  const triggers = page.getByText(TEXT.viewStatement);
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    // Codigo 16 is the bank's own backend timing out ("favor intente nuevamente") — explicitly
    // retryable, so one more attempt before giving up on this statement.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = recorder.callsFor("estadoDeCuenta").length;
      await triggers.nth(i).click();
      if (!(await waitForNewApiCalls(recorder, "estadoDeCuenta", before, 60_000))) {
        log(`${label}: statement request never returned (attempt ${attempt})`);
        continue;
      }
      const pdf = statementPdfFromCalls(recorder);
      if (pdf) {
        out.push({ billingMonth, file: saveStatementPdfFromBase64(pdf.base64, pdf.account, pdf.date, destDir) });
        if (billingMonth) recordDocument("santander", "statement", ledgerKey);
        break;
      }
      const inner = innerResultCode(recorder.callsFor("estadoDeCuenta").at(-1)?.responseBody);
      log(`${label}: no PDF in response${inner ? ` (${inner.code} — ${inner.message})` : ""} (attempt ${attempt})`);
      if (inner?.code !== "16") break;
    }
  }
  return out;
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
