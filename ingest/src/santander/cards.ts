import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { ApiCall, Recorder } from "../capture.js";
import { ENDPOINT, ROUTE, SELECTOR, TEXT } from "./routes.js";
import { openRoute } from "./navigate.js";
import { assertApiOk, innerResultCode, isSaldoInicialRow, pick, pickString } from "./payload.js";
import { matchesApiCall, waitForNewApiCalls, type ApiCallMatcher } from "../wait.js";
import { ensureDir } from "../paths.js";
import { log, logStep } from "../log.js";

/** Upper bound on swiper clicks — a stop condition in case the carousel loops instead of ending. */
const MAX_SLIDES = 8;

/**
 * How long the carousel arrow gets to produce the next card's call before the step swipes. The
 * arrow has done nothing since 2026-10-09 (for a person too); a working arrow answered within
 * ~2 s on every earlier night, so when it comes back the short path wins.
 */
const ARROW_WAIT_MS = 5_000;
/** How long a currency tab gets to produce its call; a card with no USD side produces none. */
const CURRENCY_TAB_WAIT_MS = 15_000;
/**
 * How long a view gets to render its currency tabs after its data call landed. The billed view
 * stays a skeleton — no tabs, no «Pagar hasta» — until the page's own PDF request answers, about
 * a second after the statement call (screenshots of 2026-10-10 02:54); the old 8 s `networkidle`
 * settle covered that by accident.
 */
const VIEW_RENDER_WAIT_MS = 15_000;

/** Both statement endpoints (`estadoCuentaNacional`, `estadoCuentaInternacional`), never the PDF one (`estadoDeCuenta`). */
const STATEMENT_CALL: ApiCallMatcher = /^estadoCuenta/i;

export type CurrencyTab = { currency: "CLP" | "USD"; label: RegExp; name: string };

/**
 * The currency tab with `label`, once it is on screen; null when the view shows none within the
 * wait (a view with no currency tabs, or one that never finished rendering — the caller logs it).
 */
async function visibleCurrencyTab(page: Page, label: RegExp): Promise<Locator | null> {
  const tab = page.getByText(label).first();
  try {
    await tab.waitFor({ state: "visible", timeout: VIEW_RENDER_WAIT_MS });
    return tab;
  } catch {
    return null;
  }
}

const CURRENCY_TABS: Record<"CLP" | "USD", CurrencyTab> = {
  CLP: { currency: "CLP", label: TEXT.currencyClp, name: "Pesos" },
  USD: { currency: "USD", label: TEXT.currencyUsd, name: "Dólares" },
};

/**
 * The tab to click after a view arrived in `currency` — the OTHER one. The carousel keeps the
 * selected tab across cards (verified 2026-10-09), so alternating the tab per card visits both
 * currencies of every card with one click each and no restore: CLP → click Dólares; the next
 * card opens on USD → click Pesos. Any other value is not a currency this step knows: never a
 * guess, the caller reports it.
 */
export function otherCurrencyTab(currency: string | null): CurrencyTab | null {
  const key = currency?.trim().toUpperCase();
  if (key === "CLP") return CURRENCY_TABS.USD;
  if (key === "USD") return CURRENCY_TABS.CLP;
  return null;
}

/**
 * The currency a statement call's endpoint stands for: `estadoCuentaNacional` is the Pesos
 * tab, `estadoCuentaInternacional` the Dólares tab (the international request names no
 * currency in its body). Anything else — the PDF endpoint, an unknown name — is null.
 */
export function statementCallCurrency(endpoint: string): "CLP" | "USD" | null {
  if (/^estadoCuentaNacional$/i.test(endpoint)) return "CLP";
  if (/^estadoCuentaInternacional$/i.test(endpoint)) return "USD";
  return null;
}

/**
 * The card contracts the session's product summary lists (`NUMEROCONTRATO` of its `TCR` rows —
 * the same number each card's calls carry as `Cuenta`, verified 2026-10-10), or null without a
 * usable summary. The carousel shows one tile per contract, so once every contract has been
 * visited the step is done: the swiper no longer marks its arrow disabled on the last tile, and
 * finding that out by swiping costs the arrow wait plus a full swipe wait (~26 s on 2026-10-10).
 */
export function cardContractsInSummary(recorder: Recorder): Set<string> | null {
  const { cupos } = collectCardCupos(recorder);
  if (!cupos) return null;
  const contracts = new Set(cupos.rows.map((row) => row.NUMEROCONTRATO ?? "").filter((n) => n.length > 0));
  return contracts.size > 0 ? contracts : null;
}

/** Whether every expected contract has been visited; never true without the summary's list. */
export function everyCardVisited(visited: Iterable<string | null>, expected: Set<string> | null): boolean {
  if (!expected) return false;
  const seen = new Set([...visited].filter((v): v is string => v !== null));
  return [...expected].every((contract) => seen.has(contract));
}

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

/**
 * The bank's own credit line per card and currency, as the landing page's product summary
 * (`cruceProductosOnline`) states it: the `TCR` rows of `MATRIZCAPTACIONES`, verbatim but for a
 * whitelist of fields (`CUPO` / `MONTOUTILIZADO` / `MONTODISPONIBLE` are 18-digit strings with two
 * implied decimals in both currencies). The request carries the client's RUT and is never kept.
 */
export type CardCupos = {
  /** When the summary arrived — about 20 s before the first movements call of the session. */
  observedAt: string;
  rows: Record<string, string>[];
};

/**
 * The same summary's deposit accounts — `CCC` (cuenta corriente, peso or dollar) and `CCM` (cuenta
 * vista) rows, whitelisted like the card rows; `MONTODISPONIBLE` is the balance (18 digits, two
 * implied decimals).
 */
export type DepositAccountBalances = {
  observedAt: string;
  rows: Record<string, string>[];
};

export type CardMovementsResult = {
  fetchedAt: string;
  slides: CardSlide[];
  /** Null when the session produced no usable summary; `cuposError` then says why. */
  cupos: CardCupos | null;
  cuposError?: string;
  /** Null when the summary had no deposit account; `accountsError` then says why. */
  accounts: DepositAccountBalances | null;
  accountsError?: string;
};

const CUPO_ROW_FIELDS = [
  "NUMEROCONTRATO",
  "NUMEROPAN",
  "CODIGOMONEDA",
  "CUPO",
  "MONTOUTILIZADO",
  "MONTODISPONIBLE",
  "GLOSAESTADO",
] as const;

/**
 * The card rows of the session's product summary. Never throws: the movements are the step's job,
 * and a missing summary is reported in the file for the server's cupo check to fail on instead.
 */
export function collectCardCupos(recorder: Recorder): Pick<CardMovementsResult, "cupos" | "cuposError"> {
  // The latest login's call: a relaunched browser logs in again and asks again.
  const call = recorder.callsFor(ENDPOINT.productSummary).at(-1);
  if (!call) return { cupos: null, cuposError: `the landing page made no ${ENDPOINT.productSummary} call this session` };
  try {
    assertApiOk(call.responseBody, ENDPOINT.productSummary);
  } catch (err) {
    return { cupos: null, cuposError: err instanceof Error ? err.message : String(err) };
  }
  const output = pick(pick(call.responseBody, "DATA"), "OUTPUT");
  const matrix = pick(pick(pick(output, "MATRICES"), "MATRIZCAPTACIONES"), "e1");
  const rows = (Array.isArray(matrix) ? matrix : [])
    .filter((row) => pickString(row, "AGRUPACIONCOMERCIAL") === "TCR")
    .map((row) => {
      const kept: Record<string, string> = {};
      for (const field of CUPO_ROW_FIELDS) kept[field] = pickString(row, field) ?? "";
      return kept;
    });
  if (rows.length === 0) {
    return { cupos: null, cuposError: `${ENDPOINT.productSummary} listed no credit card (TCR) rows` };
  }
  return { cupos: { observedAt: call.receivedAt, rows } };
}

const DEPOSIT_ROW_FIELDS = [
  "NUMEROCONTRATO",
  "AGRUPACIONCOMERCIAL",
  "CODIGOMONEDA",
  "MONTODISPONIBLE",
  "GLOSACORTA",
  "GLOSAESTADO",
] as const;

/** The deposit-account rows of the session's product summary. Never throws, like the card rows. */
export function collectDepositBalances(
  recorder: Recorder
): Pick<CardMovementsResult, "accounts" | "accountsError"> {
  const call = recorder.callsFor(ENDPOINT.productSummary).at(-1);
  if (!call) return { accounts: null, accountsError: `the landing page made no ${ENDPOINT.productSummary} call this session` };
  try {
    assertApiOk(call.responseBody, ENDPOINT.productSummary);
  } catch (err) {
    return { accounts: null, accountsError: err instanceof Error ? err.message : String(err) };
  }
  const output = pick(pick(call.responseBody, "DATA"), "OUTPUT");
  const matrix = pick(pick(pick(output, "MATRICES"), "MATRIZCAPTACIONES"), "e1");
  const rows = (Array.isArray(matrix) ? matrix : [])
    .filter((row) => ["CCC", "CCM"].includes(pickString(row, "AGRUPACIONCOMERCIAL") ?? ""))
    .map((row) => {
      const kept: Record<string, string> = {};
      for (const field of DEPOSIT_ROW_FIELDS) kept[field] = pickString(row, field) ?? "";
      return kept;
    });
  if (rows.length === 0) {
    return { accounts: null, accountsError: `${ENDPOINT.productSummary} listed no deposit account (CCC/CCM) rows` };
  }
  return { accounts: { observedAt: call.receivedAt, rows } };
}

/**
 * Click through the card carousel, collecting every `consultaUltimosMovimientos` response.
 *
 * Each click loads one card/currency view. We stop when the next button disappears, goes disabled,
 * or stops producing new API calls — whichever comes first.
 */
/**
 * Advances the card carousel the way a finger would: press on the active tile, drag left across
 * three quarters of its width in small steps (Swiper needs intermediate pointer moves to read a
 * swipe), release. Throws when there is no active tile to drag.
 */
async function swipeToNextCard(page: Page): Promise<void> {
  const box = await page.locator(SELECTOR.swiperActiveSlide).first().boundingBox();
  if (!box) throw new Error("card carousel: no active slide to swipe");
  const y = box.y + box.height / 2;
  const fromX = box.x + box.width * 0.85;
  const toX = box.x + box.width * 0.1;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / steps, y);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
}

/**
 * Advance the carousel to the next card and wait for the call that proves it loaded (`matcher`,
 * counted from `before`). Returns "last" when the swiper says there is no next slide, "moved"
 * when a new call arrived, "stuck" when neither the arrow nor a swipe produced one.
 *
 * The arrow is tried first with a short wait; it stopped working on 2026-10-09 (for a person
 * too), and a drag across the active tile still advances the carousel, so the swipe follows
 * with the full wait. No settle afterwards: the call is the proof the view loaded.
 */
async function advanceCarousel(
  page: Page,
  recorder: Recorder,
  matcher: ApiCallMatcher,
  before: number,
): Promise<"last" | "moved" | "stuck"> {
  const next = page.locator(SELECTOR.swiperNext).first();
  if ((await next.count()) === 0 || !(await next.isVisible())) return "last";
  const classes = (await next.getAttribute("class")) ?? "";
  if (classes.includes(SELECTOR.swiperDisabled)) {
    log("swiper reached the last slide");
    return "last";
  }
  try {
    await next.click({ timeout: ARROW_WAIT_MS });
    if (await waitForNewApiCalls(recorder, matcher, before, ARROW_WAIT_MS)) return "moved";
    log("swiper arrow produced no new call — swiping instead");
  } catch (err) {
    log(`swiper arrow could not be clicked (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — swiping instead`);
  }
  await swipeToNextCard(page);
  if (await waitForNewApiCalls(recorder, matcher, before)) return "moved";
  log("neither the arrow nor a swipe produced a new call — stopping");
  return "stuck";
}

export async function fetchCardMovements(page: Page, recorder: Recorder): Promise<CardMovementsResult> {
  logStep("credit card — movements");
  const baseline = recorder.callsFor(ENDPOINT.cardMovements).length;
  await openRoute(page, ROUTE.cardUnbilled);
  // The view's first movements call is the proof it loaded — `networkidle` never comes here.
  if (!(await waitForNewApiCalls(recorder, ENDPOINT.cardMovements, baseline))) {
    throw new Error(`card movements: no ${ENDPOINT.cardMovements} call after opening the unbilled view`);
  }
  await recorder.screenshot(page, "card-unbilled-initial");

  // The view opens on the first card in one currency; the other currency is its own call behind
  // the other tab, and the tab stays selected across cards, so each card costs one tab click.
  await fetchOtherCurrencyForCurrentCard(page, recorder, 0);

  const expected = cardContractsInSummary(recorder);
  const visited = () => recorder.callsFor(ENDPOINT.cardMovements).map((c) => pickString(pick(c.requestBody, "Entrada", "INPUT"), "Cuenta"));
  for (let slide = 0; slide < MAX_SLIDES; slide++) {
    if (everyCardVisited(visited(), expected)) {
      log(`every card in the product summary visited (${expected?.size}) — carousel done`);
      break;
    }
    const before = recorder.callsFor(ENDPOINT.cardMovements).length;
    const moved = await advanceCarousel(page, recorder, ENDPOINT.cardMovements, before);
    if (moved !== "moved") break;
    await recorder.screenshot(page, `card-unbilled-slide-${slide + 1}`);
    await fetchOtherCurrencyForCurrentCard(page, recorder, slide + 1);
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

  // One entry per (account, currency): alternating the tabs visits each exactly once, so this is a
  // safety net («collapsed 0» is the expected log) — a duplicate slide would double-count on import.
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
  const cupos = collectCardCupos(recorder);
  log(
    cupos.cupos
      ? `bank cupo: ${cupos.cupos.rows.length} card/currency row(s) observed ${cupos.cupos.observedAt}`
      : `bank cupo NOT captured — ${cupos.cuposError}`
  );
  const accounts = collectDepositBalances(recorder);
  log(
    accounts.accounts
      ? `bank balances: ${accounts.accounts.rows.length} deposit account row(s) observed`
      : `bank balances NOT captured — ${accounts.accountsError}`
  );
  return { fetchedAt: new Date().toISOString(), slides, ...cupos, ...accounts };
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
function saveStatementJson(call: ApiCall, destDir: string): string {
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
  const saved: StatementDownload[] = [];
  const progress = { statementsSaved: 0, pdfLogged: 0 };
  const statementCalls = () => recorder.calls.filter((c) => matchesApiCall(c, STATEMENT_CALL));

  // Entering the billed view resets the tab to Pesos (verified 2026-10-09), so the first call
  // is the national statement; from there the tabs alternate exactly as in the movements step
  // — the carousel keeps the tab — and every card costs one tab click, no restore.
  const baseline = statementCalls().length;
  await openRoute(page, ROUTE.cardBilled);
  if (!(await waitForNewApiCalls(recorder, STATEMENT_CALL, baseline))) {
    log("no statement call after opening the billed view");
    return saved;
  }
  await recorder.screenshot(page, "card-billed-initial");
  saved.push(...(await captureStatementJson(page, recorder, jsonDir, "slide 1", progress)));

  const expected = cardContractsInSummary(recorder);
  const visited = () => statementCalls().map((c) => pickString(pick(c.requestBody, "INPUT", "Entrada"), "Cuenta"));
  for (let slide = 0; slide < MAX_SLIDES; slide++) {
    const label = `slide ${slide + 1}`;
    try {
      // The USD statement is its own backend call behind the other tab.
      const latest = statementCalls().at(-1);
      const other = otherCurrencyTab(latest ? statementCallCurrency(latest.endpoint) : null);
      if (!other) {
        log(`${label}: latest statement call ${latest?.endpoint ?? "(none)"} names no currency — not switching tabs`);
      } else {
        const before = statementCalls().length;
        const tab = await visibleCurrencyTab(page, other.label);
        if (!tab) {
          log(`${label}: no ${other.name} tab`);
        } else {
          await tab.click();
          if (await waitForNewApiCalls(recorder, STATEMENT_CALL, before, CURRENCY_TAB_WAIT_MS)) {
            saved.push(...(await captureStatementJson(page, recorder, jsonDir, `${label}/${other.name}`, progress)));
          } else {
            log(`${label}: ${other.name} tab produced no statement call (card may have no ${other.currency} side)`);
          }
        }
      }
    } catch (err) {
      // One card must not cost us the others: a dormant card's endpoints can time out
      // bank-side, which must not stop the step before the active card is reached.
      log(`${label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    await recorder.screenshot(page, `card-billed-slide-${slide + 1}`);

    if (everyCardVisited(visited(), expected)) {
      log(`every card in the product summary visited (${expected?.size}) — carousel done`);
      break;
    }
    const before = statementCalls().length;
    const moved = await advanceCarousel(page, recorder, STATEMENT_CALL, before);
    if (moved !== "moved") break;
    saved.push(...(await captureStatementJson(page, recorder, jsonDir, `slide ${slide + 2}`, progress)));
  }
  return saved;
}

/**
 * Save every statement call that arrived since the last capture (named from its own INPUT) and
 * log what the page's own PDF request got. The billing month is read from the page once per view.
 */
async function captureStatementJson(
  page: Page,
  recorder: Recorder,
  jsonDir: string,
  label: string,
  progress: { statementsSaved: number; pdfLogged: number },
): Promise<StatementDownload[]> {
  // The call landed; the view renders its tabs and «Pagar hasta» a moment later.
  if (!(await visibleCurrencyTab(page, TEXT.currencyClp))) {
    log(`${label}: the billed view showed no currency tabs within ${VIEW_RENDER_WAIT_MS / 1000} s`);
  }
  const billingMonth = await readBillingMonth(page);
  const statementCalls = recorder.calls.filter((c) => matchesApiCall(c, STATEMENT_CALL));
  const saved: StatementDownload[] = [];
  for (const call of statementCalls.slice(progress.statementsSaved)) {
    const jsonFile = saveStatementJson(call, jsonDir);
    log(`${label}: statement JSON → ${path.basename(jsonFile)}`);
    saved.push({ billingMonth, file: jsonFile });
  }
  progress.statementsSaved = statementCalls.length;

  const calls = recorder.callsFor("estadoDeCuenta");
  for (const call of calls.slice(progress.pdfLogged)) {
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
  progress.pdfLogged = calls.length;
  return saved;
}

/**
 * Click the other currency tab of the current card and wait for its call.
 *
 * USD is not fetched by the swiper: each currency is its own `consultaUltimosMovimientos` call,
 * distinguished only by `Entrada.Moneda` (confirmed 2026-08-04 — a full swiper walk produced CLP
 * calls exclusively). The currency the card opened on is read from its call, never assumed, and
 * the tab is NOT restored afterwards: the carousel keeps the selected tab across cards, so the
 * next card opens on this currency and one click brings its other side.
 */
async function fetchOtherCurrencyForCurrentCard(page: Page, recorder: Recorder, slide: number): Promise<void> {
  const latest = recorder.callsFor(ENDPOINT.cardMovements).at(-1);
  const currency = pickString(pick(latest?.requestBody, "Entrada", "INPUT"), "Moneda");
  const other = otherCurrencyTab(currency);
  if (!other) {
    throw new Error(`slide ${slide}: the movements call names currency ${JSON.stringify(currency)} — not CLP or USD`);
  }
  const tab = await visibleCurrencyTab(page, other.label);
  if (!tab) {
    log(`slide ${slide}: no currency tabs — ${currency} only`);
    return;
  }
  const before = recorder.callsFor(ENDPOINT.cardMovements).length;
  await tab.click();
  if (!(await waitForNewApiCalls(recorder, ENDPOINT.cardMovements, before, CURRENCY_TAB_WAIT_MS))) {
    log(`slide ${slide}: ${other.name} tab produced no call (card may have no ${other.currency} side)`);
  }
  await recorder.screenshot(page, `card-unbilled-slide-${slide}-${other.currency.toLowerCase()}`);
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
