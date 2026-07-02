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
import {
  getCcExpenseCategoryBySlug,
  normalizeCcExpenseMerchantKey,
} from "../ccExpenseCategories.js";
import {
  buildDeptoDividendosMovementNote,
  buildDeptoMortgageMovementNote,
  type DeptoDividendosPaymentRow,
} from "../deptoDividendosLedger.js";
import { ufRowOnOrBefore } from "../fxRates.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { invalidateCcExpenseGenericUniqueMerchantCache } from "../ccExpenseGenericUniqueMerchants.js";
import { monthEndUtcYmd } from "../calendarMonth.js";
import {
  chapterForMonth,
  type DemoCard,
  type DemoChapter,
  type DemoMonth,
  type DemoNarrative,
  type DemoTrade,
} from "./demoNarrative.js";

export type DemoAccounts = {
  checkingId: number;
  /** last4 → CC master account id. */
  ccMasterIdByLast4: Map<string, number>;
  fondoId: number;
  stocksId: number | null;
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

const insValuation = db.prepare(
  `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
   ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
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

/**
 * Volatile tech/semis-flavored monthly return: melt-up 2019–2021, COVID crash/rip,
 * ~-50% grind through 2022, AI recovery 2023–2024, choppy 2025 with the April air pocket.
 */
export function demoStocksMonthlyReturn(month: DemoMonth, rng: () => number): number {
  if (month === "2020-03") return -0.18;
  if (month === "2020-04") return 0.13;
  if (month === "2022-06") return -0.11;
  if (month === "2022-10") return -0.09;
  if (month === "2025-04") return -0.1;
  const noise = (base: number, amp: number) => base + (rng() * 2 - 1) * amp;
  const year = month.slice(0, 4);
  switch (year) {
    case "2018": return noise(0.0, 0.05);
    case "2019": return noise(0.03, 0.04);
    case "2020": return noise(0.045, 0.05);
    case "2021": return noise(0.025, 0.06);
    case "2022": return noise(-0.05, 0.05);
    case "2023": return noise(0.042, 0.05);
    case "2024": return noise(0.028, 0.05);
    case "2025": return noise(0.008, 0.06);
    default: return noise(0.01, 0.05);
  }
}

/** Crypto-flavored monthly return: 2020–21 mania, May-2021 flush, 2022 winter, 2023–24 recovery. */
export function demoCryptoMonthlyReturn(month: DemoMonth, rng: () => number): number {
  if (month === "2021-05") return -0.32;
  if (month === "2021-12") return -0.14;
  if (month === "2022-06") return -0.35;
  if (month === "2024-03") return 0.25;
  const noise = (base: number, amp: number) => base + (rng() * 2 - 1) * amp;
  if (month >= "2020-10" && month <= "2020-12") return noise(0.22, 0.1);
  if (month >= "2021-01" && month <= "2021-04") return noise(0.16, 0.12);
  if (month >= "2021-06" && month <= "2021-11") return noise(0.1, 0.08);
  const year = month.slice(0, 4);
  switch (year) {
    case "2022": return noise(-0.14, 0.08);
    case "2023": return noise(0.075, 0.1);
    case "2024": return noise(0.065, 0.12);
    case "2025": return noise(0.0, 0.1);
    default: return noise(0.01, 0.08);
  }
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
  fondoValueClp: number;
  fondoDepositsClp: number;
  stocksValueClp: number;
  cryptoValueClp: number;
  afpValueClp: number;
  afcValueClp: number;
  savingsValueClp: number;
  checkingBalanceClp: number;
  /** Outstanding mortgage principal once the house is bought (null before). */
  mortgageOutstandingClp: number | null;
  /** Depto ledger counters (cuota number, CLP paid, principal UF incl. pie). */
  deptoCuotaN: number;
  deptoPagoAcumClp: number;
  deptoAmortAcumUf: number;
};

export function initialDemoRunState(narrative: DemoNarrative): DemoRunState {
  return {
    cards: new Map(
      narrative.cards.map((c) => [c.last4, { prevFacturadoClp: 0, installments: [] }])
    ),
    fondoValueClp: 0,
    fondoDepositsClp: 0,
    stocksValueClp: 0,
    cryptoValueClp: 0,
    afpValueClp: 0,
    afcValueClp: 0,
    savingsValueClp: 0,
    checkingBalanceClp: 0,
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
  const leftover = net - billsTotal - pagosTotal - eventChecking;
  const sweepRoll = rng();
  const sweepFactor = sweepRoll < 0.3 ? 0 : sweepRoll > 0.85 ? 1.7 : 0.6 + rng() * 0.8;
  const sweepClp = Math.max(
    0,
    Math.round((leftover * ch.savingsRate * sweepFactor) / 50_000) * 50_000
  );
  let stocksSweepClp = 0;
  if (narrative.stocks && month >= narrative.stocks.from && sweepClp > 0) {
    stocksSweepClp =
      Math.round((sweepClp * narrative.stocks.sweepShare) / 50_000) * 50_000;
  }
  const fondoSweepClp = sweepClp - stocksSweepClp;

  // Buys accumulate per asset and post as ONE checking transfer each — the asset side
  // writes one Depósito per asset too, so the internal-transfer matcher pairs them 1:1
  // on amount+day (two checking legs against one merged deposit never match).
  const tradeFlows = { stocksBuy: stocksSweepClp, stocksSell: 0, cryptoBuy: 0, cryptoSell: 0, fondoBuy: fondoSweepClp, fondoSell: 0 };
  for (const tr of narrative.trades) {
    if (tr.month !== month) continue;
    if (tr.action === "buy") {
      const amt = Math.round(tr.amountClp ?? 0);
      if (amt <= 0) continue;
      if (tr.asset === "crypto") tradeFlows.cryptoBuy += amt;
      else if (tr.asset === "stocks") tradeFlows.stocksBuy += amt;
      else tradeFlows.fondoBuy += amt;
    } else {
      const held =
        tr.asset === "crypto"
          ? state.cryptoValueClp
          : tr.asset === "stocks"
            ? state.stocksValueClp
            : state.fondoValueClp;
      const amt = Math.round(held * (tr.fraction ?? 0));
      if (amt <= 0) continue;
      const desc =
        tr.asset === "crypto"
          ? "ABONO VENTA EXCHANGE DEMO"
          : tr.asset === "stocks"
            ? "ABONO VENTA CORREDORA DEMO"
            : "ABONO RESCATE FONDO DEMO";
      checkingMove(amt, 18, desc);
      if (tr.asset === "crypto") tradeFlows.cryptoSell += amt;
      else if (tr.asset === "stocks") tradeFlows.stocksSell += amt;
      else tradeFlows.fondoSell += amt;
    }
  }
  if (tradeFlows.fondoBuy > 0) {
    checkingMove(-tradeFlows.fondoBuy, 26, "TRANSFERENCIA FONDO DEMO");
  }
  if (tradeFlows.stocksBuy > 0) {
    checkingMove(-tradeFlows.stocksBuy, 26, "TRANSFERENCIA CORREDORA DEMO");
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
  stocksBuy: number;
  stocksSell: number;
  cryptoBuy: number;
  cryptoSell: number;
  fondoBuy: number;
  fondoSell: number;
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

const insLine = db.prepare(
  `INSERT INTO cc_statement_lines (
     statement_id, transaction_date, merchant, amount_clp, amount_usd, installment_flag,
     nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, dedupe_key
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  if (flows.fondoBuy > 0) {
    movement(accounts.fondoId, flows.fondoBuy, dayInMonth(month, 26), "Depósito|demo");
    state.fondoDepositsClp += flows.fondoBuy;
  }
  if (flows.fondoSell > 0) {
    movement(accounts.fondoId, -flows.fondoSell, dayInMonth(month, 18), "Retiro|demo");
  }
  state.fondoValueClp = Math.max(
    0,
    state.fondoValueClp * (1 + r) + flows.fondoBuy - flows.fondoSell
  );
  if (state.fondoValueClp > 0) valuation(accounts.fondoId, monthEnd, state.fondoValueClp);

  if (accounts.stocksId != null) {
    if (flows.stocksBuy > 0) {
      movement(accounts.stocksId, flows.stocksBuy, dayInMonth(month, 26), "Depósito|demo");
    }
    if (flows.stocksSell > 0) {
      movement(accounts.stocksId, -flows.stocksSell, dayInMonth(month, 18), "Retiro|demo");
    }
    const rs = demoStocksMonthlyReturn(month, rng);
    state.stocksValueClp = Math.max(
      0,
      state.stocksValueClp * (1 + rs) + flows.stocksBuy - flows.stocksSell
    );
    if (state.stocksValueClp > 0) valuation(accounts.stocksId, monthEnd, state.stocksValueClp);
  }

  if (accounts.cryptoId != null) {
    if (flows.cryptoBuy > 0) {
      movement(accounts.cryptoId, flows.cryptoBuy, dayInMonth(month, 17), "Depósito|demo");
    }
    if (flows.cryptoSell > 0) {
      movement(accounts.cryptoId, -flows.cryptoSell, dayInMonth(month, 18), "Retiro|demo");
    }
    const rc = demoCryptoMonthlyReturn(month, rng);
    state.cryptoValueClp = Math.max(
      0,
      state.cryptoValueClp * (1 + rc) + flows.cryptoBuy - flows.cryptoSell
    );
    if (state.cryptoValueClp > 0) valuation(accounts.cryptoId, monthEnd, state.cryptoValueClp);
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
      // Depto ledger movements — the SAME note format import/manual payments write on the
      // real DB, so the movements loader, mortgage pages, payment scenarios, and the
      // dashboard card all run the identical code path on the demo.
      const payYmd = dayInMonth(month, 10);
      const ufDay = ufRowOnOrBefore(payYmd)?.clp_per_uf ?? null;
      if (ufDay == null || ufDay <= 0) {
        throw new Error(`demo: uf_daily missing on/before ${payYmd} (writeMarketSeries first)`);
      }
      const uf4 = (v: number) => Math.round((v / ufDay) * 1e4) / 1e4;
      const uf5 = (v: number) => Math.round((v / ufDay) * 1e5) / 1e5;
      const emitDeptoMovements = (r: DeptoDividendosPaymentRow, ymd: string) => {
        movement(accounts.propertyId!, r.amount_clp, ymd, buildDeptoDividendosMovementNote(r));
        if (r.cuota !== "pie") {
          movement(accounts.mortgageId!, Math.abs(r.amount_clp), ymd, buildDeptoMortgageMovementNote(r));
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
        // French amortization: fixed dividendo, principal share grows over time. The
        // current month's cuota only exists once its payment day has passed — the real
        // ledger never carries future-dated payments.
        const i = house.monthlyRate;
        const pmt = (house.mortgageClp * i) / (1 - Math.pow(1 + i, -house.termMonths));
        const interest = state.mortgageOutstandingClp * i;
        const amort = pmt - interest;
        state.mortgageOutstandingClp = Math.max(0, state.mortgageOutstandingClp - amort);
        state.deptoCuotaN += 1;
        const fireClp = 25_000;
        const desClp = 3_000;
        const pagoClp = Math.round(pmt + fireClp + desClp);
        state.deptoPagoAcumClp += pagoClp;
        state.deptoAmortAcumUf = Math.round((state.deptoAmortAcumUf + uf5(amort)) * 1e4) / 1e4;
        emitDeptoMovements(
          baseRow({
            cuota: String(state.deptoCuotaN),
            amount_clp: pagoClp,
            amount_uf: uf5(pagoClp),
            credito_restante_uf: uf4(state.mortgageOutstandingClp),
            valor_vivienda_uf: uf4(grossClp),
            valor_neto_uf: uf4(grossClp - state.mortgageOutstandingClp),
            valor_neto_clp: Math.round(grossClp - state.mortgageOutstandingClp),
            pagado_neto_uf: state.deptoAmortAcumUf,
            pago_acumulado_clp: state.deptoPagoAcumClp,
            min_uf: uf5(pmt),
            amortizacion_clp: Math.round(amort),
            amortizacion_uf: uf5(amort),
            interes_clp: Math.round(interest),
            interes_uf: uf5(interest),
            incendio_clp: fireClp,
            desgravamen_clp: desClp,
          }),
          payYmd
        );
      }
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
  const insUf = db.prepare(
    `INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf`
  );

  const startYmd = dayInMonth(narrative.firstMonth, 1);
  const endYmd = monthEndUtcYmd(narrative.lastMonth);

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
    d = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
  }
  // Always a rate on the final day so "today" conversions never reach past the window.
  insFx.run(endYmd, Math.round(fx * 100) / 100);

  // Era-anchored UF (~26.800 in early 2018, ~39.000 by 2026 at 0.35%/month).
  const monthsSince2018 =
    (Number(narrative.firstMonth.slice(0, 4)) - 2018) * 12 + (Number(narrative.firstMonth.slice(5, 7)) - 1);
  let uf = 26_800 * Math.pow(1.0035, Math.max(0, monthsSince2018));
  let m = narrative.firstMonth;
  for (;;) {
    insUf.run(dayInMonth(m, 1), Math.round(uf * 100) / 100);
    uf *= 1.0035;
    if (m === narrative.lastMonth) break;
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  insUf.run(monthEndUtcYmd(narrative.lastMonth), Math.round(uf * 100) / 100);
}
