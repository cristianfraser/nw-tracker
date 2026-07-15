/**
 * Month writers for the synthetic databases (demo + test presets). Everything is written
 * through the same tables the real imports use (movements, valuations, cc_statements +
 * cc_statement_lines, cc_installment_purchases/payments), so balances, billing months,
 * gastos categories, installment ledgers and charts are consistent by construction.
 *
 * Conventions:
 * - Checking balance = movements cumsum (no valuations rows needed) — same as real
 *   cuenta corriente accounts.
 * - CC statements use `import:web-paste|demo|…` sources: web-paste statements are exempt
 *   from the on-disk-PDF invariants (assertAllCcStatementPdfsResolvable skips them).
 * - Cuota events also write the installment LEDGER (purchase + one payment per billed
 *   cuota) so plan/paid-tracking views have rows, mirroring what import:cc-parsed builds.
 * - Fund/AFP/property values are book `valuations` at month-end: cumulative deposits
 *   growing along a seeded return path (2020-03 crash + recovery baked in). Swap for
 *   real `equity_daily`/`fund_unit_daily` backfills later if the demo should track real
 *   market series.
 */
import { db } from "../db.js";
import { getCcExpenseCategoryBySlug, normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import {
  deptoPaymentColumnsFromPaymentRow,
  deptoPaymentHumanNote,
  insertDeptoPaymentRow,
  mortgageFlowKindFromCuota,
  type DeptoDividendosPaymentRow,
} from "../deptoDividendosLedger.js";
import { fxRowOnOrBefore, ufRowOnOrBefore } from "../fxRates.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { invalidateCcExpenseGenericUniqueMerchantCache } from "../ccExpenseGenericUniqueMerchants.js";
import { expandYearMonthsInclusive, monthEndUtcYmd } from "../calendarMonth.js";
import {
  chapterForMonth,
  type DemoCard,
  type DemoChapter,
  type DemoMonth,
  type DemoNarrative,
} from "./demoNarrative.js";

export type DemoAccounts = {
  checkingId: number;
  /** last4 → CC master account id. */
  ccMasterIdByLast4: Map<string, number>;
  fondoId: number | null;
  /** One account per configured ticker (equity_ticker set — MTM valuation). */
  stockIdByTicker: Map<string, number>;
  /** Corredora USD cash hub (compra_usd_venta_clp in, stock_buy out). */
  usdCashId: number | null;
  cryptoId: number | null;
  afpId: number | null;
  afcId: number | null;
  savingsId: number | null;
  vistaId: number | null;
  propertyId: number | null;
  mortgageId: number | null;
};

/* ------------------------------- merchant pools ---------------------------------- */

type DemoMerchant = {
  name: string;
  category: "supermarket" | "fun" | "delivery" | "bills" | "home" | "transport" | "subs" | "clothes";
};

const MERCHANTS: DemoMerchant[] = [
  { name: "SUPERMERCADO AUSTRAL", category: "supermarket" },
  { name: "MINIMARKET LOS ROBLES", category: "supermarket" },
  { name: "FERIA DIGITAL SPA", category: "home" },
  { name: "RESTOBAR EL MUELLE", category: "fun" },
  { name: "CINE PACIFICO", category: "fun" },
  { name: "APP DELIVERY ANDES", category: "delivery" },
  { name: "FARMACIA DEL VALLE", category: "bills" },
  { name: "BENCINERA RUTA SUR", category: "transport" },
  { name: "TIENDA HOGAR CENTRO", category: "home" },
  { name: "CAFETERIA LA PLAZA", category: "fun" },
  { name: "NETFLIX.COM", category: "subs" },
  { name: "SPOTIFY", category: "subs" },
  { name: "TIENDA ROPA URBANA", category: "clothes" },
  { name: "GRANDES TIENDAS DEL PARQUE", category: "clothes" },
];

const USD_MERCHANTS = ["STREAMING GLOBAL INC", "CLOUD TOOLS LLC", "BOOKSTORE INTL"];

function pickMerchant(
  rng: () => number,
  chapterWeights: DemoChapter["categoryWeights"],
  cardBias: DemoCard["merchantBias"]
): DemoMerchant {
  const pool = MERCHANTS.map((m) => ({
    m,
    w: (chapterWeights?.[m.category] ?? 1) * (cardBias?.[m.category] ?? 1),
  }));
  const total = pool.reduce((s, p) => s + p.w, 0);
  let r = rng() * total;
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) return p.m;
  }
  return pool[pool.length - 1]!.m;
}

/* ------------------------------- movement helpers -------------------------------- */

const insMovementFull = db.prepare(
  `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

function movementWithUnits(
  accountId: number,
  m: {
    amount_clp: number;
    occurred_on: string;
    note: string;
    units_delta?: number | null;
    flow_kind?: string | null;
    amount_usd?: number | null;
    ticker?: string | null;
  }
): void {
  insMovementFull.run(
    accountId,
    m.amount_clp,
    m.occurred_on,
    m.note,
    m.units_delta ?? null,
    m.flow_kind ?? null,
    m.amount_usd ?? null,
    m.ticker ?? null
  );
}

const insTransferFull = db.prepare(
  `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
   VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/** Transfer row (account_id NULL, from/to set) — the manual stock_buy/stock_sell shape. */
function stockTransfer(m: {
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
  note: string;
  flow_kind: "stock_buy" | "stock_sell";
  amount_usd: number;
  units_delta: number;
  ticker: string;
}): void {
  insTransferFull.run(
    m.from_account_id,
    m.to_account_id,
    0,
    m.occurred_on,
    m.note,
    m.units_delta,
    m.flow_kind,
    m.amount_usd,
    m.ticker
  );
}

const insMovement = db.prepare(
  `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind)
   VALUES (?, ?, ?, ?, ?)`
);

function movement(
  accountId: number,
  amountClp: number,
  ymd: string,
  note: string,
  flowKind: string | null = null
): void {
  insMovement.run(accountId, Math.round(amountClp), ymd, note, flowKind);
}

function lastInsertedMovementId(): number {
  const r = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return Number(r.id);
}

const insValuation = db.prepare(
  `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')
   ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency`
);

function valuation(accountId: number, ymd: string, valueClp: number): void {
  insValuation.run(accountId, ymd, Math.round(valueClp));
}

function dayInMonth(month: DemoMonth, day: number): string {
  return `${month}-${String(day).padStart(2, "0")}`;
}

function ddmmyyyy(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

/** Whole months from `a` to `b` (positive when `b` is after `a`). */
function monthsBetween(a: DemoMonth, b: DemoMonth): number {
  return (
    (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 +
    (Number(b.slice(5, 7)) - Number(a.slice(5, 7)))
  );
}

/**
 * First month of the market price series (equity_daily / fx_daily / uf_daily). When the narrative
 * sets `marketHistoryYears`, the series reaches that many years before `lastMonth` — so the
 * watchlist 10Y anchor has data — without moving the portfolio window; else it starts at `firstMonth`.
 */
function marketHistoryFirstMonth(narrative: DemoNarrative): DemoMonth {
  const years = narrative.marketHistoryYears;
  if (years == null) return narrative.firstMonth;
  const [ly, lm] = narrative.lastMonth.split("-").map(Number) as [number, number];
  const idx = ly * 12 + (lm - 1) - Math.round(years * 12);
  const candidate: DemoMonth = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
  return candidate < narrative.firstMonth ? candidate : narrative.firstMonth;
}

function prevMonthOf(month: DemoMonth): DemoMonth {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function nextMonthOf(month: DemoMonth): DemoMonth {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function jitter(rng: () => number, base: number, pct: number): number {
  return base * (1 + (rng() * 2 - 1) * pct);
}

/* --------------------------- demo mortgage (UF schedule) ------------------------- */

/** Flat seguros charged on top of the dividendo. */
const DEMO_DEPTO_INCENDIO_CLP = 25_000;
const DEMO_DEPTO_DESGRAVAMEN_CLP = 3_000;

type DemoHouse = NonNullable<DemoNarrative["house"]>;

function ufClpOnOrBefore(ymd: string): number {
  const uf = ufRowOnOrBefore(ymd)?.clp_per_uf;
  if (uf == null || uf <= 0) {
    throw new Error(`demo: uf_daily missing on/before ${ymd} (writeMarketSeries first)`);
  }
  return uf;
}

/** Mortgage principal in UF, fixed at the purchase-month payment day (UF-denominated credit). */
function demoMortgagePrincipalUf(house: DemoHouse): number {
  return house.mortgageClp / ufClpOnOrBefore(dayInMonth(house.month, 10));
}

/**
 * Chilean-style French schedule in UF: the dividendo is a FIXED UF amount whose CLP value
 * tracks UF, and `credito_restante_uf` follows the UF schedule — so the implied rate the
 * payment-projection scenarios recompute from the ledger equals `house.monthlyRate`.
 * Closed form (no run state) so the checking bill and the ledger movements derive the
 * identical cuota independently.
 */
function demoMortgageCuotaUf(
  house: DemoHouse,
  cuotaN: number
): { pmtUf: number; interestUf: number; amortUf: number; balanceAfterUf: number } {
  const i = house.monthlyRate;
  const principalUf = demoMortgagePrincipalUf(house);
  const pmtUf = (principalUf * i) / (1 - Math.pow(1 + i, -house.termMonths));
  const growth = Math.pow(1 + i, cuotaN - 1);
  const balanceBeforeUf = principalUf * growth - (pmtUf * (growth - 1)) / i;
  const interestUf = balanceBeforeUf * i;
  const amortUf = pmtUf - interestUf;
  return { pmtUf, interestUf, amortUf, balanceAfterUf: balanceBeforeUf - amortUf };
}

/** UF balance after the cuotas paid so far (the full principal before the first one). */
function demoMortgageBalanceUf(house: DemoHouse, cuotasPaid: number): number {
  return cuotasPaid >= 1
    ? demoMortgageCuotaUf(house, cuotasPaid).balanceAfterUf
    : demoMortgagePrincipalUf(house);
}

/**
 * CLP the dividendo takes out of checking for `month` (cuota × UF that day + seguros), or
 * null when no cuota posts that month (purchase month = pie only; pay day still ahead).
 */
function demoDeptoCuotaClpForMonth(house: DemoHouse, month: DemoMonth): number | null {
  const cuotaN = monthsBetween(house.month, month);
  if (cuotaN < 1) return null;
  const payYmd = dayInMonth(month, 10);
  if (payYmd > chileCalendarTodayYmd()) return null;
  return (
    Math.round(demoMortgageCuotaUf(house, cuotaN).pmtUf * ufClpOnOrBefore(payYmd)) +
    DEMO_DEPTO_INCENDIO_CLP +
    DEMO_DEPTO_DESGRAVAMEN_CLP
  );
}

/* --------------------------- synthetic price series ------------------------------ */

/**
 * Era-realistic USD price anchors per ticker (log-linear interpolation + small seeded
 * weekly noise). These drive BOTH the written `equity_daily` rows and the generator's own
 * unit math, so demo holdings are valued exactly like real ones: units × close × fx.
 */
const EQUITY_PRICE_ANCHORS: Record<string, ReadonlyArray<[string, number]>> = {
  // Split-adjusted-ish NVDA: the exponential engine of the story (≈30x 2018→2026, with
  // the 2018 crypto-hangover, COVID dip, 2022 AI winter, and the 2023 earnings gap).
  NVDA: [
    ["2018-01-01", 5.9], ["2018-09-30", 7.1], ["2018-12-24", 3.2], ["2019-12-31", 5.9],
    ["2020-03-20", 4.9], ["2020-12-31", 13], ["2021-11-20", 33], ["2022-10-14", 11.2],
    ["2023-05-24", 30.5], ["2023-12-31", 49.5], ["2024-06-20", 130], ["2024-12-31", 137],
    ["2025-04-07", 97], ["2025-12-31", 182], ["2026-12-31", 196],
  ],
  SPY: [
    ["2018-01-01", 265], ["2020-02-15", 335], ["2020-03-20", 230], ["2020-12-31", 372],
    ["2021-12-31", 475], ["2022-10-15", 358], ["2023-12-31", 475], ["2024-12-31", 590],
    ["2025-04-15", 505], ["2026-12-31", 640],
  ],
  // Developed-intl ETF: sideways decade, 2022 dip, strong 2025 rally.
  VEA: [
    ["2018-01-01", 45], ["2018-12-24", 37.5], ["2019-12-31", 44], ["2020-03-20", 30],
    ["2020-12-31", 47], ["2021-12-31", 52], ["2022-10-14", 35.5], ["2023-12-31", 48],
    ["2024-12-31", 50], ["2025-12-31", 61], ["2026-12-31", 64],
  ],
  // Total-bond ETF: the boring ballast (2022 rate shock, slow recovery).
  BND: [
    ["2018-01-01", 79], ["2020-08-01", 89], ["2021-12-31", 84], ["2022-10-14", 70],
    ["2023-10-15", 68.5], ["2023-12-31", 72.5], ["2024-12-31", 72.5], ["2025-12-31", 74.5],
    ["2026-12-31", 76],
  ],
  // Semis ETF: the supercycle with the 2022 drawdown and the Aug-2024 air pocket.
  SMH: [
    ["2018-01-01", 95], ["2018-12-24", 78], ["2019-12-31", 142], ["2020-03-20", 98],
    ["2020-12-31", 218], ["2021-12-27", 313], ["2022-10-14", 155], ["2023-12-31", 173],
    ["2024-07-10", 283], ["2024-08-05", 202], ["2024-12-31", 240], ["2025-04-07", 172],
    ["2025-12-31", 300], ["2026-12-31", 338],
  ],
  // The turnaround trap: AI-hope rally into early 2024, then the August 2024 collapse.
  INTC: [
    ["2018-01-01", 45], ["2020-01-24", 66], ["2020-07-24", 50], ["2021-04-15", 65],
    ["2022-10-14", 25], ["2023-12-31", 48], ["2024-03-31", 44], ["2024-07-31", 30],
    ["2024-08-05", 19.5], ["2024-12-31", 20], ["2025-04-07", 18], ["2026-12-31", 24],
  ],
  CCJ: [
    ["2018-01-01", 12], ["2020-03-20", 9], ["2021-11-15", 26], ["2022-12-31", 21],
    ["2024-05-31", 52], ["2025-12-31", 60], ["2026-12-31", 64],
  ],
  "BTC-USD": [
    ["2018-01-01", 13500], ["2018-12-15", 3300], ["2019-06-30", 11000], ["2020-03-15", 5300],
    ["2020-12-31", 29000], ["2021-04-15", 63000], ["2021-07-20", 29800], ["2021-11-10", 67500],
    ["2022-06-18", 18000], ["2022-12-31", 16500], ["2024-03-15", 70000], ["2024-12-31", 95000],
    ["2025-10-01", 115000], ["2026-12-31", 105000],
  ],
};

function daysSinceEpoch(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`) / 86_400_000;
}

function anchorPriceUsd(ticker: string, ymd: string): number {
  const anchors = EQUITY_PRICE_ANCHORS[ticker];
  if (!anchors) throw new Error(`demo: no price anchors for ticker ${ticker}`);
  const t = daysSinceEpoch(ymd);
  if (t <= daysSinceEpoch(anchors[0]![0])) return anchors[0]![1];
  for (let i = 1; i < anchors.length; i++) {
    const [d1, p1] = anchors[i]!;
    const t1 = daysSinceEpoch(d1);
    if (t <= t1) {
      const [d0, p0] = anchors[i - 1]!;
      const t0 = daysSinceEpoch(d0);
      const w = (t - t0) / (t1 - t0);
      return Math.exp(Math.log(p0) + w * (Math.log(p1) - Math.log(p0)));
    }
  }
  return anchors[anchors.length - 1]![1];
}

/** Weekly [ymd, closeUsd] series per ticker, built once per run (used for rows AND unit math). */
export type DemoEquitySeries = Map<string, [string, number][]>;

function ymdAddDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildDemoEquitySeries(
  narrative: DemoNarrative,
  rng: () => number
): DemoEquitySeries {
  const tickers = new Set<string>();
  for (const p of narrative.stocks?.positions ?? []) tickers.add(p.ticker);
  for (const p of narrative.stocks?.longTermPositions ?? []) tickers.add(p.ticker);
  if (narrative.withCrypto) tickers.add("BTC-USD");
  const portfolioStart = dayInMonth(narrative.firstMonth, 1);
  const marketStart = dayInMonth(marketHistoryFirstMonth(narrative), 1);
  const end = monthEndUtcYmd(narrative.lastMonth);
  const out: DemoEquitySeries = new Map();
  for (const ticker of tickers) {
    const rows: [string, number][] = [];
    // Pre-portfolio history uses anchor prices only (no shared-rng noise), so the portfolio-era
    // rows below keep their exact original values and rng draws — these old rows only feed the
    // watchlist 10Y anchor, never portfolio unit math.
    for (let d = marketStart; d < portfolioStart; d = ymdAddDays(d, 7)) {
      rows.push([d, Math.round(anchorPriceUsd(ticker, d) * 100) / 100]);
    }
    for (let d = portfolioStart; d <= end; d = ymdAddDays(d, 7)) {
      const noisy = anchorPriceUsd(ticker, d) * (1 + (rng() * 2 - 1) * 0.015);
      rows.push([d, Math.round(noisy * 100) / 100]);
    }
    out.set(ticker, rows);
  }
  return out;
}

/** Last close ≤ ymd from the built series (same rule as `equityCloseEod`). */
export function demoEquityCloseUsd(series: DemoEquitySeries, ticker: string, ymd: string): number {
  const rows = series.get(ticker);
  if (!rows?.length) throw new Error(`demo: no price series for ${ticker}`);
  let last: number | null = null;
  for (const [d, p] of rows) {
    if (d > ymd) break;
    last = p;
  }
  if (last == null) throw new Error(`demo: no ${ticker} close on/before ${ymd}`);
  return last;
}

export const DEMO_FONDO_FUND_SERIES_KEY = "fintual_risky_norris";

/** Monthly valor-cuota series for the demo fondo (fund units × this = valuation). */
export function buildDemoFondoCuotaSeries(
  narrative: DemoNarrative,
  rng: () => number
): [string, number][] {
  const months = expandYearMonthsInclusive(narrative.firstMonth, narrative.lastMonth);
  const rows: [string, number][] = [];
  let cuota = 30_000;
  for (const m of months) {
    rows.push([dayInMonth(m, 1), Math.round(cuota * 10000) / 10000]);
    cuota *= 1 + demoMonthlyReturn(m, rng);
    rows.push([monthEndUtcYmd(m), Math.round(cuota * 10000) / 10000]);
  }
  return rows;
}

export function demoFondoCuotaAt(series: [string, number][], ymd: string): number {
  let last: number | null = null;
  for (const [d, v] of series) {
    if (d > ymd) break;
    last = v;
  }
  if (last == null) throw new Error(`demo: no fondo cuota on/before ${ymd}`);
  return last;
}

/** Persist the built price series: equity_daily (weekly closes) + fund_unit_daily. */
export function writeDemoPriceSeries(state: DemoRunState): void {
  const insEq = db.prepare(
    `INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'usd')
     ON CONFLICT(ticker, trade_date) DO UPDATE SET close = excluded.close, currency = excluded.currency`
  );
  for (const [ticker, rows] of state.equitySeries) {
    for (const [d, p] of rows) insEq.run(ticker, d, p);
  }
  const insFu = db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'demo')
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp`
  );
  for (const [d, v] of state.fondoCuotaSeries) insFu.run(DEMO_FONDO_FUND_SERIES_KEY, d, v);
}

/* ---------------------------- synthetic return path ------------------------------ */

/**
 * Monthly nominal return for invested balances. Seeded noise around a positive drift,
 * with the 2020 pandemic crash and recovery hardcoded so the fund chart dips exactly
 * where the narrative's lockdown chapter sits.
 */
export function demoMonthlyReturn(month: DemoMonth, rng: () => number): number {
  if (month === "2020-03") return -0.12;
  if (month === "2020-04") return 0.05;
  if (month === "2022-06") return -0.06;
  if (month === "2025-04") return -0.05;
  // 2022: negative drift all year (rate-hike grind), not just the June air pocket.
  if (month.startsWith("2022")) return -0.015 + (rng() * 2 - 1) * 0.025;
  return 0.005 + (rng() * 2 - 1) * 0.02;
}


/* --------------------------------- month state ----------------------------------- */

type CardState = {
  /** Facturado of the previous CLP billing month — paid from checking this month. */
  prevFacturadoClp: number;
  /** Active installment plans billing one cuota per month on this card. */
  installments: {
    merchant: string;
    cuotaClp: number;
    remaining: number;
    total: number;
    startedOn: string;
    /** cc_installment_purchases id (ledger rows are appended per billed cuota). */
    purchaseId: number;
  }[];
};

export type DemoRunState = {
  cards: Map<string, CardState>;
  /** Fund cuotas held (fondo valuation = cuotas × valor cuota, like real Fintual accounts). */
  fondoUnits: number;
  /** Shares held per stock ticker (valuation = units × equity_daily close × fx — MTM). */
  stockUnits: Map<string, number>;
  /** BTC held (crypto MTM: units × BTC-USD close × fx). */
  cryptoUnits: number;
  afpValueClp: number;
  afcValueClp: number;
  savingsValueClp: number;
  checkingBalanceClp: number;
  /** Built once per run: weekly USD closes per ticker + monthly fondo valor cuota. */
  equitySeries: DemoEquitySeries;
  fondoCuotaSeries: [string, number][];
  /** CLP mark of the UF mortgage balance once the house is bought (null before). */
  mortgageOutstandingClp: number | null;
  /** Depto ledger counters (cuota number, CLP paid, principal UF incl. pie). */
  deptoCuotaN: number;
  deptoPagoAcumClp: number;
  deptoAmortAcumUf: number;
};

export function initialDemoRunState(
  narrative: DemoNarrative,
  rng: () => number
): DemoRunState {
  return {
    cards: new Map(
      narrative.cards.map((c) => [c.last4, { prevFacturadoClp: 0, installments: [] }])
    ),
    fondoUnits: 0,
    stockUnits: new Map((narrative.stocks?.positions ?? []).map((p) => [p.ticker, 0])),
    cryptoUnits: 0,
    afpValueClp: 0,
    afcValueClp: 0,
    savingsValueClp: 0,
    checkingBalanceClp: 0,
    equitySeries: buildDemoEquitySeries(narrative, rng),
    fondoCuotaSeries: narrative.withFondo ? buildDemoFondoCuotaSeries(narrative, rng) : [],
    mortgageOutstandingClp: null,
    deptoCuotaN: 0,
    deptoPagoAcumClp: 0,
    deptoAmortAcumUf: 0,
  };
}

function activeCards(narrative: DemoNarrative, month: DemoMonth): DemoCard[] {
  return narrative.cards.filter((c) => c.from <= month);
}

/** Real cartola note format: `import:cartola|<month>|<branch>|<desc>|on:<ymd>|amt:<signed>|idx:<i>`. */
function cartolaNote(month: DemoMonth, desc: string, ymd: string, amountClp: number, idx: number): string {
  return `import:cartola|${month}|Demo|${desc}|on:${ymd}|amt:${Math.round(amountClp)}|idx:${idx}`;
}

/* --------------------------------- writers --------------------------------------- */

function salaryForMonth(ch: DemoChapter, monthsSinceChapterStart: number): number {
  const years = monthsSinceChapterStart / 12;
  return ch.salaryClp * Math.pow(1 + ch.salaryAnnualGrowth, years);
}

/** Salary in, fixed costs + per-card CC payments + events out, sweep to fondo. */
export function writeCheckingMonth(
  narrative: DemoNarrative,
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  rng: () => number
): { flows: DemoMonthFlows; afpContribClp: number } {
  const ch = chapterForMonth(narrative, month);
  const monthsIn = Math.max(
    0,
    (Number(month.slice(0, 4)) - Number(ch.from.slice(0, 4))) * 12 +
      (Number(month.slice(5, 7)) - Number(ch.from.slice(5, 7)))
  );

  const gross = jitter(rng, salaryForMonth(ch, monthsIn), 0.02);
  const afpContribClp = narrative.withAfp ? Math.round(gross * 0.12) : 0;
  const net = Math.round(gross - afpContribClp);

  let idx = 0;
  const checkingMove = (amountClp: number, day: number, desc: string) => {
    const ymd = dayInMonth(month, day);
    movement(accounts.checkingId, amountClp, ymd, cartolaNote(month, desc, ymd, amountClp, idx++));
  };

  // Opening balance so the first month's bills (days 5–12) clear before the first salary.
  if (month === narrative.firstMonth) {
    checkingMove(1_000_000, 1, "ABONO APERTURA CUENTA");
  }
  checkingMove(net, 25, "ABONO REMUNERACIONES EMPRESA DEMO SPA");

  // Itemized bills — one categorized movement each (rent/dividendo, luz, agua, internet…).
  let billsTotal = 0;
  const monthNo = Number(month.slice(5, 7));
  for (const b of ch.bills) {
    const everyN = b.everyNMonths ?? 1;
    if (everyN > 1 && monthNo % everyN !== 0) continue;
    const amt = Math.round(jitter(rng, b.meanClp, 0.1));
    checkingMove(-amt, b.day, b.desc);
    billsTotal += amt;
  }

  // One PAGO per card with a closed facturado.
  let pagosTotal = 0;
  for (const card of activeCards(narrative, month)) {
    const cs = state.cards.get(card.last4)!;
    if (cs.prevFacturadoClp > 0) {
      checkingMove(-cs.prevFacturadoClp, 8, `PAGO TARJETA CREDITO ${card.last4}`);
      pagosTotal += cs.prevFacturadoClp;
    }
  }

  // Checking-side one-off events (e.g. pie de la casa).
  let eventChecking = 0;
  for (const ev of narrative.events) {
    if (ev.month !== month || !ev.viaChecking) continue;
    checkingMove(-ev.amountClp, 15, ev.label.toUpperCase());
    eventChecking += ev.amountClp;
  }

  // Sweep a lumpy fraction of the leftover into investments (cargo on checking + deposit
  // on the destination — the pair shape the deposits reconciliation machinery matches on).
  // ~30% of months skip the sweep, a few sweep extra hard; the rest jitter around the
  // chapter's savings rate. Uniform monthly saving looked lifeless on the net-worth chart.
  // Sells are valued from HOLDINGS: units × close(price series) × fx — the same MTM math
  // the app uses — never from a synthetic balance walk.
  const sellDay = 18;
  const sellYmd = dayInMonth(month, sellDay);
  const fxSell = fxRowOnOrBefore(sellYmd)?.clp_per_usd ?? null;
  const tradeFlows: DemoMonthFlows = {
    stockBuys: [],
    stockSells: [],
    cryptoBuy: 0,
    cryptoSell: null,
    fondoBuy: 0,
  };
  for (const tr of narrative.trades) {
    if (tr.month !== month) continue;
    if (tr.action === "buy") {
      const amt = Math.round(tr.amountClp ?? 0);
      if (amt <= 0) continue;
      if (tr.asset === "crypto") tradeFlows.cryptoBuy += amt;
      else {
        const ticker = tr.ticker ?? narrative.stocks?.positions[0]?.ticker;
        if (!ticker) throw new Error(`demo: stock buy at ${month} without a ticker`);
        tradeFlows.stockBuys.push({ ticker, clp: amt });
      }
    } else if (tr.asset === "stocks") {
      const ticker = tr.ticker ?? narrative.stocks?.positions[0]?.ticker;
      if (!ticker) throw new Error(`demo: stock sell at ${month} without a ticker`);
      if (fxSell == null) throw new Error(`demo: no fx on/before ${sellYmd}`);
      const held = state.stockUnits.get(ticker) ?? 0;
      const units = held * (tr.fraction ?? 0);
      if (units <= 0) continue;
      const priceUsd = demoEquityCloseUsd(state.equitySeries, ticker, sellYmd);
      const usd = Math.round(units * priceUsd * 100) / 100;
      const clp = Math.round(usd * fxSell);
      tradeFlows.stockSells.push({ ticker, units, usd, clp });
      checkingMove(clp, sellDay, "ABONO VENTA CORREDORA DEMO");
    } else {
      if (fxSell == null) throw new Error(`demo: no fx on/before ${sellYmd}`);
      const units = state.cryptoUnits * (tr.fraction ?? 0);
      if (units <= 0) continue;
      const priceUsd = demoEquityCloseUsd(state.equitySeries, "BTC-USD", sellYmd);
      const clp = Math.round(units * priceUsd * fxSell);
      tradeFlows.cryptoSell = { units, clp };
      checkingMove(clp, sellDay, "ABONO VENTA EXCHANGE DEMO");
    }
  }
  if (tradeFlows.fondoBuy > 0) {
    checkingMove(-tradeFlows.fondoBuy, 26, "TRANSFERENCIA FONDO DEMO");
  }
  for (const lot of tradeFlows.stockBuys) {
    checkingMove(-lot.clp, 26, "TRANSFERENCIA CORREDORA DEMO");
  }
  if (tradeFlows.cryptoBuy > 0) {
    checkingMove(-tradeFlows.cryptoBuy, 17, "TRANSFERENCIA EXCHANGE DEMO");
  }

  // Cash-savings flows. Baseline: quarterly 100k top-up. With a house on the horizon the
  // reserva becomes the pie fund — 500k/month for the 24 months before the purchase, then
  // most of the balance comes back to checking at the purchase month to pay the pie (the
  // down payment must drain accumulated savings, not appear out of nowhere).
  if (accounts.savingsId != null) {
    const house = narrative.house;
    const monthsToHouse = house == null ? null : monthsBetween(month, house.month);
    if (house != null && monthsToHouse != null && monthsToHouse >= 1 && monthsToHouse <= 24) {
      const ahorroPie = 500_000;
      checkingMove(-ahorroPie, 12, "TRANSF FONDO RESERVA DEMO");
      movement(accounts.savingsId, ahorroPie, dayInMonth(month, 12), "Depósito|demo");
    } else if (Number(month.slice(5, 7)) % 3 === 0) {
      checkingMove(-100_000, 12, "TRANSF FONDO RESERVA DEMO");
      movement(accounts.savingsId, 100_000, dayInMonth(month, 12), "Depósito|demo");
    }
    if (house != null && month === house.month) {
      const balance = (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements WHERE account_id = ?`
          )
          .get(accounts.savingsId) as { t: number }
      ).t;
      const rescate = Math.max(
        0,
        Math.floor(Math.min(balance - 400_000, 15_000_000) / 100_000) * 100_000
      );
      if (rescate > 0) {
        checkingMove(rescate, 14, "TRANSF FONDO RESERVA DEMO");
        movement(accounts.savingsId, -rescate, dayInMonth(month, 14), "Retiro|demo");
      }
    }
  }

  // Cash-cap rule: checking targets ~5M max (soft — target jitters 2.5–5.5M and ~15% of
  // months skip the sweep, letting cash build before a catch-up). Everything above the
  // target is invested (trading share + long-term core) or parked in the reserva. Runs LAST
  // so the actual posted balance — salary, bills, pagos, sells, scripted buys, pie —
  // drives it; a big sale or bonus gets swept the same month it lands.
  {
    const balanceClp = (
      db
        .prepare(`SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements WHERE account_id = ?`)
        .get(accounts.checkingId) as { t: number }
    ).t;
    const monthsToHouseForCash =
      narrative.house == null ? null : monthsBetween(month, narrative.house.month);
    // Hold cash in the sale month and the pie month — the down payment needs the balance.
    const holdForPie =
      monthsToHouseForCash != null && monthsToHouseForCash >= 0 && monthsToHouseForCash <= 1;
    const lazyMonth = rng() < 0.15;
    // Next month's pre-salary fixed outflows (bills incl. dividendo + card pagos land on
    // days 5–15, salary on the 25th) must survive the sweep — proxy with this month's,
    // plus this month's card-billed events: they close into THIS facturado and get paid
    // next month, which the plain pago proxy misses (e.g. the Verano spikes).
    const cardEventClp = narrative.events
      .filter((ev) => ev.month === month && !ev.viaChecking)
      .reduce(
        (s, ev) => s + (ev.cuotas && ev.cuotas > 1 ? Math.round(ev.amountClp / ev.cuotas) : ev.amountClp),
        0
      );
    // The first dividendo bills this month's facturado but only shows in pagosTotal from
    // next month on — bridge it once so the first post-purchase sweep leaves room.
    const firstCuotaBridgeClp =
      narrative.house != null && monthsBetween(narrative.house.month, month) === 1
        ? (demoDeptoCuotaClpForMonth(narrative.house, month) ?? 0)
        : 0;
    // Upcoming scripted buys (the INTC bet, crypto dips…) also draw on this balance
    // before their wires post — reserve over a two-month horizon (the last sweep before
    // a buy can be a month early when the in-between month skips its sweep), or a big
    // bet overdraws the account.
    const buyHorizon = [nextMonthOf(month), nextMonthOf(nextMonthOf(month))];
    const nextTradeBuysClp = narrative.trades
      .filter((tr) => buyHorizon.includes(tr.month) && tr.action === "buy")
      .reduce((s, tr) => s + Math.round(tr.amountClp ?? 0), 0);
    const preSalaryFloorClp =
      Math.ceil(
        (billsTotal + pagosTotal + cardEventClp + firstCuotaBridgeClp + nextTradeBuysClp + 700_000) /
          50_000
      ) * 50_000;
    const targetClp = Math.max(
      3_500_000 + Math.round((rng() * 3_000_000) / 50_000) * 50_000,
      preSalaryFloorClp
    );
    const sweepClp =
      holdForPie || lazyMonth
        ? 0
        : Math.max(0, Math.floor((balanceClp - targetClp) / 50_000) * 50_000);
    if (sweepClp >= 100_000) {
      const stocksActive = narrative.stocks != null && month >= narrative.stocks.from;
      const stocksShare = stocksActive ? narrative.stocks!.sweepShare : 0;
      const stocksClp = Math.round((sweepClp * stocksShare) / 50_000) * 50_000;
      let reservaClp =
        accounts.savingsId != null ? Math.round((sweepClp * 0.15) / 50_000) * 50_000 : 0;
      // Remainder = the low-risk core: long-term ETFs when configured (demo), else the
      // fondo (lean preset); before the brokerage era it parks in the reserva.
      const coreClp = sweepClp - stocksClp - reservaClp;
      const longTerm = narrative.stocks?.longTermPositions ?? [];
      const pushStockLots = (
        positions: readonly { ticker: string; weight: number }[],
        totalClp: number
      ) => {
        const weightSum = positions.reduce((a, p) => a + p.weight, 0);
        let assigned = 0;
        positions.forEach((p, i) => {
          const clp =
            i === positions.length - 1
              ? totalClp - assigned
              : Math.round((totalClp * p.weight) / weightSum / 1000) * 1000;
          assigned += clp;
          if (clp > 0) {
            tradeFlows.stockBuys.push({ ticker: p.ticker, clp });
            checkingMove(-clp, 26, "TRANSFERENCIA CORREDORA DEMO");
          }
        });
      };
      if (coreClp > 0) {
        if (stocksActive && longTerm.length > 0) {
          pushStockLots(longTerm, coreClp);
        } else if (accounts.fondoId != null) {
          tradeFlows.fondoBuy += coreClp;
          checkingMove(-coreClp, 26, "TRANSFERENCIA FONDO DEMO");
        } else if (accounts.savingsId != null) {
          reservaClp += coreClp;
        }
      }
      if (reservaClp > 0 && accounts.savingsId != null) {
        checkingMove(-reservaClp, 26, "TRANSF FONDO RESERVA DEMO");
        movement(accounts.savingsId, reservaClp, dayInMonth(month, 26), "Depósito|demo");
      }
      if (stocksClp > 0 && narrative.stocks) {
        pushStockLots(narrative.stocks.positions, stocksClp);
      }
    }
  }

  // Register the month in the cartola registry so cartola-months / ledger-anchor
  // machinery sees a normal imported month (saldo chain from the movement cumsum).
  const saldoInicial = Math.round(state.checkingBalanceClp);
  const monthNet =
    net -
    Math.round(jitterlessMonthOutflows(state, accounts, month)) ;
  void monthNet;
  const movementCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND occurred_on BETWEEN ? AND ?`
      )
      .get(accounts.checkingId, dayInMonth(month, 1), monthEndUtcYmd(month)) as { c: number }
  ).c;
  const saldoFinal = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements WHERE account_id = ? AND occurred_on <= ?`
      )
      .get(accounts.checkingId, monthEndUtcYmd(month)) as { t: number }
  ).t;
  db.prepare(
    `INSERT INTO checking_cartola_imports (
       account_id, period_month, source_file, movement_count,
       saldo_inicial_clp, saldo_final_clp, period_from, period_to
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, period_month) DO UPDATE SET
       movement_count = excluded.movement_count, saldo_final_clp = excluded.saldo_final_clp`
  ).run(
    accounts.checkingId,
    month,
    `screenshot:demo-cartola-${month}`,
    movementCount,
    saldoInicial,
    Math.round(saldoFinal),
    dayInMonth(month, 1),
    monthEndUtcYmd(month)
  );
  state.checkingBalanceClp = saldoFinal;

  // Cuenta vista: token monthly activity so vista-kind machinery has an account to resolve.
  if (accounts.vistaId != null) {
    const inYmd = dayInMonth(month, 3);
    movement(
      accounts.vistaId,
      30_000,
      inYmd,
      cartolaNote(month, "ABONO CUENTA VISTA DEMO", inYmd, 30_000, 0)
    );
    const outYmd = dayInMonth(month, 18);
    movement(
      accounts.vistaId,
      -25_000,
      outYmd,
      cartolaNote(month, "COMPRA DEBITO DEMO", outYmd, -25_000, 1)
    );
    const vistaSaldo = (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements WHERE account_id = ? AND occurred_on <= ?`
        )
        .get(accounts.vistaId, monthEndUtcYmd(month)) as { t: number }
    ).t;
    db.prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_inicial_clp, saldo_final_clp, period_from, period_to
       ) VALUES (?, ?, ?, 2, ?, ?, ?, ?)
       ON CONFLICT(account_id, period_month) DO NOTHING`
    ).run(
      accounts.vistaId,
      month,
      `screenshot:demo-vista-${month}`,
      Math.round(vistaSaldo) - 5_000,
      Math.round(vistaSaldo),
      dayInMonth(month, 1),
      monthEndUtcYmd(month)
    );
  }

  return { flows: tradeFlows, afpContribClp };
}

export type DemoMonthFlows = {
  /**
   * One lot per ticker per month: each lot is its own checking wire + CLP→USD conversion
   * + stock_buy with IDENTICAL USD on both rows, so the funding pairing and the
   * deposit-matcher line up exactly (pooled wires never match per-buy capital flows).
   */
  stockBuys: { ticker: string; clp: number }[];
  stockSells: { ticker: string; units: number; usd: number; clp: number }[];
  cryptoBuy: number;
  cryptoSell: { units: number; clp: number } | null;
  fondoBuy: number;
};

/** Placeholder for readability in the registry block (outflows already posted above). */
function jitterlessMonthOutflows(_s: DemoRunState, _a: DemoAccounts, _m: DemoMonth): number {
  return 0;
}

/* ------------------------------ credit-card month -------------------------------- */

const insStatement = db.prepare(
  `INSERT INTO cc_statements (
     account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
     card_last4, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// parser_row_id = dedupe_key: real statement lines always carry a parser row id, and the
// gastos purchase keys (line-pr:/installment-pr:) plus the mortgage-link bills assignment
// key off it — fallback keys would leave linked dividendo lines unclassified.
const insLine = db.prepare(
  `INSERT INTO cc_statement_lines (
     statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag,
     nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, dedupe_key, parser_row_id
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const insLedgerPurchase = db.prepare(
  `INSERT INTO cc_installment_purchases (
     account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
     cuotas_totales, merchant, source
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pdf')`
);

const insLedgerPayment = db.prepare(
  `INSERT INTO cc_installment_payments (
     purchase_id, pay_by_date, statement_date, source_pdf, amount_clp,
     cuota_current, cuota_total, statement_period_month
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * One closed CLP billing month per active card (21 prev → 20 this): merchant-pool lines
 * split by spend share, active installment cuotas (statement lines + ledger payments),
 * PAGO of the prior facturado, plus a small USD statement for USD-enabled cards.
 */
export function writeCreditCardMonth(
  narrative: DemoNarrative,
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  rng: () => number
): void {
  const ch = chapterForMonth(narrative, month);
  const cards = activeCards(narrative, month);
  if (cards.length === 0) return;
  const shareTotal = cards.reduce((s, c) => s + c.spendShare, 0);

  const periodTo = dayInMonth(month, 20);
  const prevMonth = prevMonthOf(month);
  const periodFrom = dayInMonth(prevMonth, 21);
  const statementDate = periodTo;
  const payBy = dayInMonth(nextMonthOf(month), 8);

  for (const card of cards) {
    const cs = state.cards.get(card.last4)!;
    const ccMasterId = accounts.ccMasterIdByLast4.get(card.last4)!;
    const lines: {
      date: string;
      merchant: string;
      amount: number;
      installment?: { current: number; total: number; cuota: number };
    }[] = [];

    // Discretionary spend for this card's share of the chapter mean.
    // Lumpy discretionary spend: ~12% blowout months (1.6–2.2×), ~18% frugal months
    // (0.55–0.75×), the rest 0.75–1.25× — flat 0.25 jitter read as lifeless.
    const spendRoll = rng();
    const spendMult =
      spendRoll < 0.12 ? 1.6 + rng() * 0.6 : spendRoll < 0.3 ? 0.55 + rng() * 0.2 : 0.75 + rng() * 0.5;
    const target = ((ch.ccSpendMeanClp * card.spendShare) / shareTotal) * spendMult;
    const nPurchases = 4 + Math.floor(rng() * 8);
    let spent = 0;
    for (let i = 0; i < nPurchases && spent < target; i++) {
      const merchant = pickMerchant(rng, ch.categoryWeights, card.merchantBias);
      const amount = Math.max(3_000, Math.round(jitter(rng, target / nPurchases, 0.6) / 10) * 10);
      const day = 21 + Math.floor(rng() * 28);
      const date =
        day <= 31 && day > 20 ? dayInMonth(prevMonth, Math.min(day, 28)) : dayInMonth(month, day - 28);
      lines.push({ date, merchant: merchant.name, amount });
      spent += amount;
    }

    // New events billed on this card this month.
    const defaultCard = cards[0]!.last4;
    for (const ev of narrative.events) {
      if (ev.month !== month || ev.viaChecking) continue;
      if ((ev.cardLast4 ?? defaultCard) !== card.last4) continue;
      const purchaseOn = dayInMonth(month, 10);
      if (ev.cuotas && ev.cuotas > 1) {
        const cuota = Math.round(ev.amountClp / ev.cuotas / 10) * 10;
        // Ledger purchase row — payments append monthly as cuotas bill.
        const purchaseId = Number(
          insLedgerPurchase.run(
            ccMasterId,
            card.cardGroup,
            `demo:${month}:${ev.label}`,
            purchaseOn,
            Math.max(1, cuota * ev.cuotas),
            ev.cuotas,
            ev.label.toUpperCase()
          ).lastInsertRowid
        );
        cs.installments.push({
          merchant: ev.label.toUpperCase(),
          cuotaClp: cuota,
          remaining: ev.cuotas,
          total: ev.cuotas,
          startedOn: purchaseOn,
          purchaseId,
        });
      } else {
        lines.push({ date: purchaseOn, merchant: ev.label.toUpperCase(), amount: ev.amountClp });
      }
    }

    // Dividendo bills on the main card (like the real DB's PAT), for the exact ledger
    // cuota on the cuota day — syncMortgageExpenseDepositLinksFromSheet matches CC lines
    // by amount + date against the depto ledger, splitting gastos into carrying cost
    // (bills, in totals) and amortization (chart stack only).
    if (narrative.house != null && card.last4 === defaultCard) {
      const cuotaClp = demoDeptoCuotaClpForMonth(narrative.house, month);
      if (cuotaClp != null) {
        lines.push({
          date: dayInMonth(month, 10),
          merchant: "DIVIDENDO HIPOTECARIO BANCO DEMO",
          amount: cuotaClp,
        });
      }
    }

    // Bill one cuota per active plan: statement line + ledger payment row.
    for (const plan of cs.installments) {
      if (plan.remaining <= 0) continue;
      const current = plan.total - plan.remaining + 1;
      lines.push({
        date: plan.startedOn,
        merchant: plan.merchant,
        amount: plan.cuotaClp,
        installment: { current, total: plan.total, cuota: plan.cuotaClp },
      });
      insLedgerPayment.run(
        plan.purchaseId,
        payBy,
        ddmmyyyy(statementDate),
        `import:web-paste|demo|${card.last4}|${month}`,
        plan.cuotaClp,
        current,
        plan.total,
        month
      );
      plan.remaining -= 1;
    }
    cs.installments = cs.installments.filter((p) => p.remaining > 0);

    const pago = cs.prevFacturadoClp;
    const compras = lines.reduce((s, l) => s + l.amount, 0);
    const facturado = compras;

    const stmt = insStatement.run(
      ccMasterId,
      card.cardGroup,
      `import:web-paste|demo|${card.last4}|${month}`,
      ddmmyyyy(statementDate),
      ddmmyyyy(periodFrom),
      ddmmyyyy(periodTo),
      ddmmyyyy(payBy),
      card.last4,
      "compact",
      "clp",
      pago > 0 ? pago : null,
      pago > 0 ? pago : null,
      compras,
      facturado,
      facturado
    );
    const statementId = Number(stmt.lastInsertRowid);

    let i = 0;
    for (const l of lines) {
      insLine.run(
        statementId,
        ddmmyyyy(l.date),
        l.merchant,
        Math.round(l.amount),
        null,
        l.installment ? 1 : 0,
        l.installment?.current ?? null,
        l.installment?.total ?? null,
        l.installment?.cuota ?? null,
        `demo|${card.last4}|${month}|${i}|${l.merchant}`,
        `demo|${card.last4}|${month}|${i++}|${l.merchant}`
      );
    }
    if (pago > 0) {
      insLine.run(
        statementId,
        ddmmyyyy(dayInMonth(month, 8)),
        "PAGO",
        -pago,
        null,
        0,
        null,
        null,
        null,
        `demo|${card.last4}|${month}|pago`,
        `demo|${card.last4}|${month}|pago`
      );
    }

    // Small international USD statement for USD-enabled cards.
    if (card.usdMonthly) {
      const usdStmt = insStatement.run(
        ccMasterId,
        card.cardGroup,
        `import:web-paste|demo-usd|${card.last4}|${month}`,
        ddmmyyyy(statementDate),
        ddmmyyyy(periodFrom),
        ddmmyyyy(periodTo),
        ddmmyyyy(payBy),
        card.last4,
        "international_usd",
        "usd",
        null,
        null,
        null,
        null,
        null
      );
      const usdStatementId = Number(usdStmt.lastInsertRowid);
      const nUsd = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < nUsd; k++) {
        const amountUsd = Math.round(jitter(rng, card.usdMonthly.meanUsd / nUsd, 0.5) * 100) / 100;
        insLine.run(
          usdStatementId,
          ddmmyyyy(dayInMonth(prevMonth, 22 + k)),
          USD_MERCHANTS[k % USD_MERCHANTS.length]!,
          null,
          Math.max(1, amountUsd),
          0,
          null,
          null,
          null,
          `demo-usd|${card.last4}|${month}|${k}`,
          `demo-usd|${card.last4}|${month}|${k}`
        );
      }
    }

    cs.prevFacturadoClp = Math.round(facturado);
  }
}

/** Fondo/stocks/crypto + AFP month-end valuations along seeded return paths; house once bought. */
export function writeInvestmentMonth(
  narrative: DemoNarrative,
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  flows: DemoMonthFlows,
  afpContribClp: number,
  rng: () => number
): void {
  const monthEnd = monthEndUtcYmd(month);
  const r = demoMonthlyReturn(month, rng);
  const buyYmd = dayInMonth(month, 26);
  const sellYmd = dayInMonth(month, 18);
  const cryptoYmd = dayInMonth(month, 17);

  // Fondo: cuota purchases (units × valor cuota = valuation, like real Fintual accounts).
  if (accounts.fondoId != null && flows.fondoBuy > 0) {
    const cuota = demoFondoCuotaAt(state.fondoCuotaSeries, buyYmd);
    const units = Math.round((flows.fondoBuy / cuota) * 1e4) / 1e4;
    state.fondoUnits = Math.round((state.fondoUnits + units) * 1e4) / 1e4;
    movementWithUnits(accounts.fondoId, {
      amount_clp: flows.fondoBuy,
      occurred_on: buyYmd,
      note: "Depósito|demo",
      units_delta: units,
    });
  }
  if (accounts.fondoId != null && state.fondoUnits > 0) {
    const cuotaEnd = demoFondoCuotaAt(state.fondoCuotaSeries, monthEnd);
    valuation(accounts.fondoId, monthEnd, Math.round(state.fondoUnits * cuotaEnd));
  }

  // Stocks: per lot, CLP→USD conversion on the corredora cash account + a stock_buy
  // transfer with the SAME USD amount (funding pairing + deposit matching line up), then
  // units × close × fx MTM — no book valuations; equity_daily carries the prices.
  if (narrative.stocks && accounts.usdCashId != null && accounts.stockIdByTicker.size > 0) {
    for (const lot of flows.stockBuys) {
      const fx = fxRowOnOrBefore(buyYmd)?.clp_per_usd;
      if (fx == null || fx <= 0) throw new Error(`demo: no fx on/before ${buyYmd}`);
      const stockId = accounts.stockIdByTicker.get(lot.ticker);
      if (stockId == null) throw new Error(`demo: no account for ticker ${lot.ticker}`);
      const usd = Math.round((lot.clp / fx) * 100) / 100;
      if (usd <= 0) continue;
      movementWithUnits(accounts.usdCashId, {
        amount_clp: lot.clp,
        occurred_on: buyYmd,
        note: "import:panel|demo|compra-usd",
        flow_kind: "compra_usd_venta_clp",
        amount_usd: usd,
      });
      const price = demoEquityCloseUsd(state.equitySeries, lot.ticker, buyYmd);
      const units = Math.round((usd / price) * 1e6) / 1e6;
      state.stockUnits.set(lot.ticker, (state.stockUnits.get(lot.ticker) ?? 0) + units);
      stockTransfer({
        from_account_id: accounts.usdCashId,
        to_account_id: stockId,
        occurred_on: buyYmd,
        note: "import:panel|demo|stock-buy",
        flow_kind: "stock_buy",
        amount_usd: usd,
        units_delta: units,
        ticker: lot.ticker,
      });
    }
    for (const sale of flows.stockSells) {
      const stockId = accounts.stockIdByTicker.get(sale.ticker);
      if (stockId == null) throw new Error(`demo: no account for ticker ${sale.ticker}`);
      state.stockUnits.set(
        sale.ticker,
        Math.max(0, (state.stockUnits.get(sale.ticker) ?? 0) - sale.units)
      );
      stockTransfer({
        from_account_id: stockId,
        to_account_id: accounts.usdCashId,
        occurred_on: sellYmd,
        note: "import:panel|demo|stock-sell",
        flow_kind: "stock_sell",
        amount_usd: sale.usd,
        units_delta: Math.round(sale.units * 1e6) / 1e6,
        ticker: sale.ticker,
      });
      // Proceeds leave USD cash the same day (wired back to checking as the ABONO leg).
      movementWithUnits(accounts.usdCashId, {
        amount_clp: -sale.clp,
        occurred_on: sellYmd,
        note: "import:panel|demo|venta-usd",
        flow_kind: "withdrawal_usd",
        amount_usd: -sale.usd,
      });
    }
  }

  // Crypto: wallet-style rows like the real cripto-sheet import (units in `coin=`).
  if (accounts.cryptoId != null) {
    if (flows.cryptoBuy > 0) {
      const fx = fxRowOnOrBefore(cryptoYmd)?.clp_per_usd;
      if (fx == null || fx <= 0) throw new Error(`demo: no fx on/before ${cryptoYmd}`);
      const price = demoEquityCloseUsd(state.equitySeries, "BTC-USD", cryptoYmd);
      const units = Math.round((flows.cryptoBuy / (price * fx)) * 1e8) / 1e8;
      state.cryptoUnits = Math.round((state.cryptoUnits + units) * 1e8) / 1e8;
      movementWithUnits(accounts.cryptoId, {
        amount_clp: flows.cryptoBuy,
        occurred_on: cryptoYmd,
        note: `import:excel|cripto-sheet|BTC|dep|coin=${units}|demo`,
        units_delta: units,
      });
    }
    if (flows.cryptoSell) {
      const units = Math.round(flows.cryptoSell.units * 1e8) / 1e8;
      state.cryptoUnits = Math.max(0, Math.round((state.cryptoUnits - units) * 1e8) / 1e8);
      movementWithUnits(accounts.cryptoId, {
        amount_clp: -flows.cryptoSell.clp,
        occurred_on: sellYmd,
        note: `import:excel|cripto-sheet|BTC|wdw|coin=${units}|demo`,
        units_delta: -units,
      });
    }
  }

  if (accounts.afpId != null && afpContribClp > 0) {
    movement(accounts.afpId, afpContribClp, dayInMonth(month, 25), "Cotización obligatoria|demo");
    state.afpValueClp = Math.max(0, state.afpValueClp * (1 + r * 0.7) + afpContribClp);
    valuation(accounts.afpId, monthEnd, state.afpValueClp);
  }

  if (accounts.afcId != null) {
    const afcContrib = Math.round(afpContribClp * 0.125);
    if (afcContrib > 0) {
      movement(accounts.afcId, afcContrib, dayInMonth(month, 25), "Cotización AFC|demo");
      state.afcValueClp = Math.max(0, state.afcValueClp * (1 + r * 0.4) + afcContrib);
      valuation(accounts.afcId, monthEnd, state.afcValueClp);
    }
  }

  if (accounts.savingsId != null) {
    const deposited = (
      db
        .prepare(`SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements WHERE account_id = ? AND occurred_on <= ?`)
        .get(accounts.savingsId, monthEnd) as { t: number }
    ).t;
    if (deposited > 0) {
      state.savingsValueClp = deposited;
      valuation(accounts.savingsId, monthEnd, deposited);
    }
  }

  const house = narrative.house;
  if (accounts.propertyId != null && house && month >= house.month) {
    const monthsOwned =
      (Number(month.slice(0, 4)) - Number(house.month.slice(0, 4))) * 12 +
      (Number(month.slice(5, 7)) - Number(house.month.slice(5, 7)));
    const grossClp = house.valueClp * Math.pow(1.003, monthsOwned);

    if (accounts.mortgageId != null) {
      // Depto ledger movements + depto_payments rows — the SAME write shape import/manual
      // payments use on the real DB, so the movements loader, mortgage pages, payment
      // scenarios, and the dashboard card all run the identical code path on the demo.
      const payYmd = dayInMonth(month, 10);
      const ufDay = ufRowOnOrBefore(payYmd)?.clp_per_uf ?? null;
      if (ufDay == null || ufDay <= 0) {
        throw new Error(`demo: uf_daily missing on/before ${payYmd} (writeMarketSeries first)`);
      }
      const uf4 = (v: number) => Math.round((v / ufDay) * 1e4) / 1e4;
      const uf5 = (v: number) => Math.round((v / ufDay) * 1e5) / 1e5;
      const emitDeptoMovements = (r: DeptoDividendosPaymentRow, ymd: string) => {
        const cols = deptoPaymentColumnsFromPaymentRow(r);
        movement(accounts.propertyId!, r.amount_clp, ymd, deptoPaymentHumanNote("dividendos", r.cuota, false));
        insertDeptoPaymentRow({
          movement_id: lastInsertedMovementId(),
          kind: "dividendos",
          origin: "import",
          ...cols,
        });
        if (r.cuota !== "pie") {
          movement(
            accounts.mortgageId!,
            Math.abs(r.amount_clp),
            ymd,
            deptoPaymentHumanNote("mortgage", r.cuota, false),
            mortgageFlowKindFromCuota(r.cuota)
          );
          insertDeptoPaymentRow({
            movement_id: lastInsertedMovementId(),
            kind: "mortgage",
            origin: "import",
            ...cols,
          });
        }
      };
      const baseRow = (over: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow => ({
        cuota: "",
        occurred_on: payYmd,
        amount_clp: 0,
        amount_uf: null,
        uf_clp_day: ufDay,
        credito_restante_uf: null,
        valor_vivienda_uf: null,
        valor_neto_uf: null,
        valor_neto_clp: null,
        pagado_neto_uf: null,
        pago_acumulado_clp: null,
        min_uf: null,
        amortizacion_clp: null,
        amortizacion_uf: null,
        amortizacion_ext_clp: null,
        amortizacion_ext_uf: null,
        interes_clp: null,
        interes_uf: null,
        incendio_clp: null,
        desgravamen_clp: null,
        ...over,
      });

      if (state.mortgageOutstandingClp == null) {
        state.mortgageOutstandingClp = house.mortgageClp;
        const pieClp = Math.round(house.valueClp - house.mortgageClp);
        state.deptoPagoAcumClp = pieClp;
        state.deptoAmortAcumUf = uf4(pieClp);
        emitDeptoMovements(
          baseRow({
            cuota: "pie",
            amount_clp: pieClp,
            amount_uf: uf5(pieClp),
            credito_restante_uf: uf4(house.mortgageClp),
            valor_vivienda_uf: uf4(grossClp),
            valor_neto_uf: uf4(grossClp - house.mortgageClp),
            valor_neto_clp: Math.round(grossClp - house.mortgageClp),
            pagado_neto_uf: uf4(pieClp),
            pago_acumulado_clp: pieClp,
          }),
          payYmd
        );
      } else if (payYmd <= chileCalendarTodayYmd()) {
        // UF French schedule (see demoMortgageCuotaUf): the dividendo is a fixed UF
        // amount, its CLP value rises with UF, and cruf follows the schedule. The current
        // month's cuota only exists once its payment day has passed — the real ledger
        // never carries future-dated payments.
        state.deptoCuotaN += 1;
        const s = demoMortgageCuotaUf(house, state.deptoCuotaN);
        const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
        const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
        const fireClp = DEMO_DEPTO_INCENDIO_CLP;
        const desClp = DEMO_DEPTO_DESGRAVAMEN_CLP;
        const pagoClp = Math.round(s.pmtUf * ufDay) + fireClp + desClp;
        state.deptoPagoAcumClp += pagoClp;
        state.deptoAmortAcumUf = r4(state.deptoAmortAcumUf + s.amortUf);
        const crufR = r4(s.balanceAfterUf);
        const vvufR = uf4(grossClp);
        emitDeptoMovements(
          baseRow({
            cuota: String(state.deptoCuotaN),
            amount_clp: pagoClp,
            amount_uf: uf5(pagoClp),
            credito_restante_uf: crufR,
            valor_vivienda_uf: vvufR,
            valor_neto_uf: r4(vvufR - crufR),
            valor_neto_clp: Math.round((vvufR - crufR) * ufDay),
            pagado_neto_uf: state.deptoAmortAcumUf,
            pago_acumulado_clp: state.deptoPagoAcumClp,
            min_uf: r5(s.pmtUf),
            amortizacion_clp: Math.round(s.amortUf * ufDay),
            amortizacion_uf: r5(s.amortUf),
            interes_clp: Math.round(s.interestUf * ufDay),
            interes_uf: r5(s.interestUf),
            incendio_clp: fireClp,
            desgravamen_clp: desClp,
          }),
          payYmd
        );
      }
      // CLP mark: UF balance × month-end UF — a UF credit's CLP balance can rise while
      // the UF balance falls, which is the real shape of a Chilean mortgage.
      state.mortgageOutstandingClp =
        demoMortgageBalanceUf(house, state.deptoCuotaN) * ufClpOnOrBefore(monthEnd);
      valuation(accounts.mortgageId, monthEnd, Math.round(state.mortgageOutstandingClp));
    } else if (state.mortgageOutstandingClp == null) {
      state.mortgageOutstandingClp = house.mortgageClp;
    }

    // Property valuations are EQUITY (gross − outstanding hipoteca), mirroring the real
    // DB where the depto account is maintained net of the linked mortgage. At purchase
    // equity == the pie that left checking, so net worth stays continuous.
    const equityClp = Math.max(0, grossClp - (state.mortgageOutstandingClp ?? 0));
    valuation(accounts.propertyId, monthEnd, Math.round(equityClp));
  } else if (accounts.propertyId != null && narrative.withProperty && !house && month >= "2024-08") {
    const monthsOwned = (Number(month.slice(0, 4)) - 2024) * 12 + (Number(month.slice(5, 7)) - 8);
    valuation(accounts.propertyId, monthEnd, 18_000_000 * Math.pow(1.003, monthsOwned));
  }
}

/* ------------------------------ category rules ----------------------------------- */

/**
 * The demo persona files gardener bills under a "Hobbies" category, so the seeded
 * `trees` ("Jardín / plantas") reference row is renamed in the generated DB only —
 * real DBs keep the original slug and label.
 */
export function renameDemoTreesCategoryToHobbies(): void {
  const res = db
    .prepare(
      `UPDATE cc_expense_categories
       SET slug = 'hobbies', label = 'Hobbies',
           label_i18n_key = 'expenses.creditCard.categories.hobbies'
       WHERE slug = 'trees'`
    )
    .run();
  if (res.changes !== 1) {
    throw new Error(
      "demo: cc_expense_categories missing slug trees (reference migrations not applied?)"
    );
  }
}

const MERCHANT_CATEGORY_SLUGS: Record<DemoMerchant["category"], string> = {
  supermarket: "supermarket",
  fun: "fun",
  delivery: "food",
  bills: "healthcare",
  home: "others",
  transport: "transportation",
  subs: "subscriptions",
  clothes: "clothes",
};

/** Merchant → category rules per card so the gastos charts stack out of the box. */
export function seedDemoMerchantCategoryRules(ccMasterIds: readonly number[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)`
  );
  let n = 0;
  for (const masterId of ccMasterIds) {
    for (const m of MERCHANTS) {
      const slug = MERCHANT_CATEGORY_SLUGS[m.category];
      const cat = getCcExpenseCategoryBySlug(slug);
      if (!cat) {
        throw new Error(
          `demo: cc_expense_categories missing slug ${slug} (reference migrations not applied?)`
        );
      }
      n += ins.run(masterId, normalizeCcExpenseMerchantKey(m.name), cat.id).changes;
    }
  }
  return n;
}

/**
 * Register the demo's named transfer descriptions as generic-unique merchants — the same
 * extension point the admin panel offers for real cartolas. Without this the
 * checking→investment legs fail `checkingWithdrawalMayAutoMatchDeposit` (named-payee
 * guard) and every sweep/trade shows up as an unclassified gasto.
 */
export function seedDemoGenericTransferMerchants(): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_generic_unique_merchants (merchant_key, sort_order)
     VALUES (?, ?)`
  );
  const keys = [
    "TRANSFERENCIA FONDO DEMO",
    "TRANSFERENCIA CORREDORA DEMO",
    "TRANSFERENCIA EXCHANGE DEMO",
    "TRANSF FONDO RESERVA DEMO",
  ];
  let n = 0;
  keys.forEach((k, i) => {
    n += ins.run(normalizeCcExpenseMerchantKey(k), 1000 + i * 10).changes;
  });
  invalidateCcExpenseGenericUniqueMerchantCache();
  return n;
}

const EVENT_KIND_CATEGORY_SLUGS: Record<string, string> = {
  vacation_small: "fun",
  vacation_medium: "fun",
  vacation_big: "fun",
  moving_costs: "others",
  house_down_payment: "no_cuenta",
};

const USD_MERCHANT_CATEGORY_SLUGS: Record<string, string> = {
  "STREAMING GLOBAL INC": "subscriptions",
  "CLOUD TOOLS LLC": "others",
  "BOOKSTORE INTL": "fun",
};

/** Rules for USD-statement merchants and one-off event purchases (viaje → Ocio, …). */
export function seedDemoEventAndUsdCategoryRules(
  narrative: DemoNarrative,
  checkingId: number,
  vistaId: number | null,
  ccMasterIds: readonly number[]
): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)`
  );
  const catId = (slug: string): number => {
    const cat = getCcExpenseCategoryBySlug(slug);
    if (!cat) throw new Error(`demo: cc_expense_categories missing slug ${slug}`);
    return cat.id;
  };
  let n = 0;
  for (const masterId of ccMasterIds) {
    for (const [name, slug] of Object.entries(USD_MERCHANT_CATEGORY_SLUGS)) {
      n += ins.run(masterId, normalizeCcExpenseMerchantKey(name), catId(slug)).changes;
    }
  }
  for (const ev of narrative.events) {
    const slug = EVENT_KIND_CATEGORY_SLUGS[ev.kind];
    if (!slug) continue;
    const key = normalizeCcExpenseMerchantKey(ev.label.toUpperCase());
    if (!key) continue;
    const accountIds = ev.viaChecking ? [checkingId] : ccMasterIds;
    for (const accountId of accountIds) {
      n += ins.run(accountId, key, catId(slug)).changes;
    }
  }
  if (vistaId != null) {
    n += ins.run(
      vistaId,
      normalizeCcExpenseMerchantKey("COMPRA DEBITO DEMO"),
      catId("supermarket")
    ).changes;
  }
  return n;
}

/** Merchant-wide category rules for the checking bills (rent, luz, dividendo, …). */
export function seedDemoCheckingBillCategoryRules(
  checkingId: number,
  narrative: DemoNarrative
): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)`
  );
  const seen = new Set<string>();
  let n = 0;
  for (const ch of narrative.chapters) {
    for (const b of ch.bills) {
      const key = normalizeCcExpenseMerchantKey(b.desc);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cat = getCcExpenseCategoryBySlug(b.categorySlug);
      if (!cat) {
        throw new Error(
          `demo: cc_expense_categories missing slug ${b.categorySlug} (bill ${b.desc})`
        );
      }
      n += ins.run(checkingId, key, cat.id).changes;
    }
  }
  return n;
}

/* ------------------------------ market series ------------------------------------ */

/**
 * Synthetic fx_daily (weekly) + uf_daily (monthly) across the narrative window: USD/CLP
 * conversions, UF valuations and bid/ask inference (transient, from fx_daily) all read
 * these tables — without them every USD/UF code path is dead on a generated DB.
 */
export function writeMarketSeries(narrative: DemoNarrative, rng: () => number): void {
  const insFx = db.prepare(
    `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  );
  // BCentral dólar observado tracks the market rate; readers that require the official
  // series (wealth percentile year-end conversions) fail fast on an empty table.
  const insFxBcentral = db.prepare(
    `INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  );
  const insUf = db.prepare(
    `INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf`
  );

  // Start ~6 weeks before the first month: prior-month-close marks (e.g. USD cash
  // balance at firstMonth − 1 month-end) need fx/UF coverage on or before that date.
  const startYmd = ymdAddDays(dayInMonth(narrative.firstMonth, 1), -40);
  const endYmd = monthEndUtcYmd(narrative.lastMonth);

  const fxLevelForYmd = (ymd: string): number => {
    const yrs = (new Date(`${ymd}T00:00:00Z`).getTime() - Date.UTC(2018, 0, 1)) / (365.25 * 24 * 3600 * 1000);
    return Math.min(1100, Math.max(550, 610 * Math.pow(1.055, yrs)));
  };

  // Pre-narrative fx/bcentral history (deterministic anchor curve, no rng) so the random walk
  // below — and every portfolio-era conversion it feeds — stays byte-identical. Only lights the
  // watchlist 10Y anchor for USD. `< startYmd` keeps it disjoint from the walk's first bar.
  {
    let ed = new Date(`${dayInMonth(marketHistoryFirstMonth(narrative), 1)}T00:00:00Z`);
    const walkStart = new Date(`${startYmd}T00:00:00Z`);
    while (ed < walkStart) {
      const ymd = ed.toISOString().slice(0, 10);
      const level = Math.round(fxLevelForYmd(ymd) * 100) / 100;
      insFx.run(ymd, level);
      insFxBcentral.run(ymd, level);
      ed = new Date(ed.getTime() + 7 * 24 * 3600 * 1000);
    }
  }

  // Era-anchored level (~610 CLP/USD in 2018 drifting ~5.5%/yr to ~950 by 2026) so a
  // preset starting mid-history still opens at a realistic rate.
  const yearsSince2018 =
    (new Date(`${startYmd}T00:00:00Z`).getTime() - Date.UTC(2018, 0, 1)) / (365.25 * 24 * 3600 * 1000);
  let fx = 610 * Math.pow(1.055, Math.max(0, yearsSince2018));
  let d = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  while (d <= end) {
    const ymd = d.toISOString().slice(0, 10);
    fx = Math.min(1100, Math.max(550, fx * (1 + (rng() * 2 - 1) * 0.012 + 0.00105)));
    insFx.run(ymd, Math.round(fx * 100) / 100);
    insFxBcentral.run(ymd, Math.round(fx * 100) / 100);
    d = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
  }
  // Always a rate on the final day so "today" conversions never reach past the window.
  insFx.run(endYmd, Math.round(fx * 100) / 100);
  insFxBcentral.run(endYmd, Math.round(fx * 100) / 100);

  // Era-anchored UF (~26.800 in early 2018, ~39.000 by 2026 at 0.35%/month). Anchored to the 2018
  // calendar, so extending the start earlier (negative exponent) leaves firstMonth+ values unchanged.
  const ufFirstMonth = marketHistoryFirstMonth(narrative);
  const monthsSince2018 =
    (Number(ufFirstMonth.slice(0, 4)) - 2018) * 12 + (Number(ufFirstMonth.slice(5, 7)) - 1);
  let uf = 26_800 * Math.pow(1.0035, monthsSince2018);
  let m = ufFirstMonth;
  for (;;) {
    insUf.run(dayInMonth(m, 1), Math.round(uf * 100) / 100);
    uf *= 1.0035;
    if (m === narrative.lastMonth) break;
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  insUf.run(monthEndUtcYmd(narrative.lastMonth), Math.round(uf * 100) / 100);
}
