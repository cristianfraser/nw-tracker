/**
 * Month writers for the synthetic demo DB. Everything is written through the same tables
 * the real imports use (movements, valuations, cc_statements + cc_statement_lines), so
 * balances, billing months, gastos categories and charts are consistent by construction.
 *
 * Conventions:
 * - Checking balance = movements cumsum (no valuations rows needed) — same as real
 *   cuenta corriente accounts.
 * - CC statements use `import:web-paste|demo|…` sources: web-paste statements are exempt
 *   from the on-disk-PDF invariants (assertAllCcStatementPdfsResolvable skips them).
 * - Fund/AFP/property values are book `valuations` at month-end: cumulative deposits
 *   growing along a seeded return path (2020-03 crash + recovery baked in so the
 *   pandemic chapter shows in the chart). Swap for real `equity_daily`/`fund_unit_daily`
 *   backfills later if the demo should track real market series.
 */
import { db } from "../db.js";
import {
  getCcExpenseCategoryBySlug,
  normalizeCcExpenseMerchantKey,
} from "../ccExpenseCategories.js";
import { monthEndUtcYmd } from "../calendarMonth.js";
import {
  DEFAULT_DEMO_NARRATIVE,
  chapterForMonth,
  type DemoChapter,
  type DemoMonth,
} from "./demoNarrative.js";

export type DemoAccounts = {
  checkingId: number;
  ccMasterId: number;
  fondoId: number;
  afpId: number;
  propertyId: number | null;
};

/* ------------------------------- merchant pools ---------------------------------- */

type DemoMerchant = { name: string; category: "supermarket" | "fun" | "delivery" | "bills" | "home" | "transport" };

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
];

function pickMerchant(rng: () => number, weights: DemoChapter["categoryWeights"]): DemoMerchant {
  const pool = MERCHANTS.map((m) => ({ m, w: weights?.[m.category] ?? 1 }));
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

function movement(accountId: number, amountClp: number, ymd: string, note: string, flowKind: string | null = null): void {
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
  return 0.005 + (rng() * 2 - 1) * 0.02;
}

/* --------------------------------- month state ----------------------------------- */

export type DemoRunState = {
  /** Facturado of the previous CC billing month — paid from checking this month. */
  prevFacturadoClp: number;
  /** Active installment plans: remaining cuotas billed monthly on the card. */
  installments: { merchant: string; cuotaClp: number; remaining: number; total: number; startedOn: string }[];
  fondoValueClp: number;
  fondoDepositsClp: number;
  afpValueClp: number;
  monthsWorked: number;
  propertyCreated: boolean;
};

export function initialDemoRunState(): DemoRunState {
  return {
    prevFacturadoClp: 0,
    installments: [],
    fondoValueClp: 0,
    fondoDepositsClp: 0,
    afpValueClp: 0,
    monthsWorked: 0,
    propertyCreated: false,
  };
}

/* --------------------------------- writers --------------------------------------- */

function salaryForMonth(ch: DemoChapter, monthsSinceChapterStart: number): number {
  const years = monthsSinceChapterStart / 12;
  return ch.salaryClp * Math.pow(1 + ch.salaryAnnualGrowth, years);
}

/** Salary in, fixed costs + CC payment + events out, sweep to fondo. Returns the sweep. */
export function writeCheckingMonth(
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  rng: () => number
): { sweepClp: number; afpContribClp: number } {
  const ch = chapterForMonth(DEFAULT_DEMO_NARRATIVE, month);
  const chapterStartIdx = DEFAULT_DEMO_NARRATIVE.chapters.findIndex((c) => c.id === ch.id);
  const monthsIn = Math.max(
    0,
    (Number(month.slice(0, 4)) - Number(ch.from.slice(0, 4))) * 12 +
      (Number(month.slice(5, 7)) - Number(ch.from.slice(5, 7)))
  );
  void chapterStartIdx;

  const gross = jitter(rng, salaryForMonth(ch, monthsIn), 0.02);
  const afpContribClp = Math.round(gross * 0.12);
  const net = Math.round(gross - afpContribClp);

  movement(accounts.checkingId, net, dayInMonth(month, 25), "ABONO REMUNERACIONES EMPRESA DEMO SPA");

  movement(
    accounts.checkingId,
    -Math.round(jitter(rng, ch.fixedExpensesClp, 0.05)),
    dayInMonth(month, 5),
    ch.id === "own_house" ? "PAGO GASTOS CASA / CONTRIBUCIONES" : "PAGO ARRIENDO / GASTOS COMUNES"
  );

  if (state.prevFacturadoClp > 0) {
    movement(
      accounts.checkingId,
      -state.prevFacturadoClp,
      dayInMonth(month, 8),
      "PAGO TARJETA DE CREDITO DEMO BANK"
    );
  }

  // Checking-side one-off events (e.g. pie de la casa).
  for (const ev of DEFAULT_DEMO_NARRATIVE.events) {
    if (ev.month !== month || !ev.viaChecking) continue;
    movement(accounts.checkingId, -ev.amountClp, dayInMonth(month, 15), ev.label.toUpperCase());
  }

  // Sweep whatever the chapter's savings rate says into the fondo (single-leg pair:
  // cargo on checking + deposit on the fondo — same shape the real imports produce,
  // which is what the deposits reconciliation machinery matches on).
  const eventChecking = DEFAULT_DEMO_NARRATIVE.events
    .filter((ev) => ev.month === month && ev.viaChecking)
    .reduce((s, ev) => s + ev.amountClp, 0);
  const leftover = net - ch.fixedExpensesClp - state.prevFacturadoClp - eventChecking;
  const sweepClp = Math.max(0, Math.round(leftover * ch.savingsRate / 50_000) * 50_000);
  if (sweepClp > 0) {
    movement(accounts.checkingId, -sweepClp, dayInMonth(month, 26), "TRANSFERENCIA FONDO DEMO");
  }
  return { sweepClp, afpContribClp };
}

const insStatement = db.prepare(
  `INSERT INTO cc_statements (
     account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
     card_last4, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
   ) VALUES (?, 'santander', ?, ?, ?, ?, ?, '4321', 'compact', 'clp', ?, ?, ?, ?, ?)`
);

const insLine = db.prepare(
  `INSERT INTO cc_statement_lines (
     statement_id, transaction_date, merchant, amount_clp, installment_flag,
     nro_cuota_current, nro_cuota_total, valor_cuota_mensual_clp, dedupe_key
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * One closed billing month (21 prev → 20 this), lines drawn from the merchant pool +
 * active installment cuotas + new event purchases in cuotas. Returns this month's
 * facturado (paid from checking next month).
 */
export function writeCreditCardMonth(
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  rng: () => number
): void {
  const ch = chapterForMonth(DEFAULT_DEMO_NARRATIVE, month);
  const periodTo = dayInMonth(month, 20);
  const prevMonthEnd = monthEndUtcYmd(
    `${month.slice(0, 4)}-${month.slice(5, 7)}` === "01"
      ? month
      : `${month.slice(0, 7)}`
  );
  void prevMonthEnd;
  const [y, m] = month.split("-").map(Number);
  const prevMonth = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
  const periodFrom = dayInMonth(prevMonth, 21);
  const statementDate = periodTo;
  const payBy = dayInMonth(month, 8);

  const lines: {
    date: string;
    merchant: string;
    amount: number;
    installment?: { current: number; total: number; cuota: number };
  }[] = [];

  // Discretionary spend: 6–14 purchases summing ~ccSpendMeanClp.
  const target = jitter(rng, ch.ccSpendMeanClp, 0.25);
  const nPurchases = 6 + Math.floor(rng() * 9);
  let spent = 0;
  for (let i = 0; i < nPurchases && spent < target; i++) {
    const merchant = pickMerchant(rng, ch.categoryWeights);
    const amount = Math.max(3_000, Math.round(jitter(rng, target / nPurchases, 0.6) / 10) * 10);
    const day = 21 + Math.floor(rng() * 28);
    const date = day <= 31 && day > 20 ? dayInMonth(prevMonth, Math.min(day, 28)) : dayInMonth(month, day - 28);
    lines.push({ date, merchant: merchant.name, amount });
    spent += amount;
  }

  // New events billed on the card this month (with or without cuotas).
  for (const ev of DEFAULT_DEMO_NARRATIVE.events) {
    if (ev.month !== month || ev.viaChecking) continue;
    if (ev.cuotas && ev.cuotas > 1) {
      const cuota = Math.round(ev.amountClp / ev.cuotas / 10) * 10;
      state.installments.push({
        merchant: ev.label.toUpperCase(),
        cuotaClp: cuota,
        remaining: ev.cuotas,
        total: ev.cuotas,
        startedOn: dayInMonth(month, 10),
      });
    } else {
      lines.push({ date: dayInMonth(month, 10), merchant: ev.label.toUpperCase(), amount: ev.amountClp });
    }
  }

  // Bill one cuota for every active installment plan.
  for (const plan of state.installments) {
    if (plan.remaining <= 0) continue;
    const current = plan.total - plan.remaining + 1;
    lines.push({
      date: plan.startedOn,
      merchant: plan.merchant,
      amount: plan.cuotaClp,
      installment: { current, total: plan.total, cuota: plan.cuotaClp },
    });
    plan.remaining -= 1;
  }
  state.installments = state.installments.filter((p) => p.remaining > 0);

  // PAGO of the previous facturado lands inside this cycle.
  const pago = state.prevFacturadoClp;
  const compras = lines.reduce((s, l) => s + l.amount, 0);
  const facturado = compras;

  const stmt = insStatement.run(
    accounts.ccMasterId,
    `import:web-paste|demo|${month}`,
    ddmmyyyy(statementDate),
    ddmmyyyy(periodFrom),
    ddmmyyyy(periodTo),
    ddmmyyyy(payBy),
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
      l.installment ? 1 : 0,
      l.installment?.current ?? null,
      l.installment?.total ?? null,
      l.installment?.cuota ?? null,
      `demo|${month}|${i++}|${l.merchant}`
    );
  }
  if (pago > 0) {
    insLine.run(statementId, ddmmyyyy(dayInMonth(month, 8)), "PAGO", -pago, 0, null, null, null, `demo|${month}|pago`);
  }

  state.prevFacturadoClp = Math.round(facturado);
}

/** Fondo + AFP month-end valuations along the seeded return path; property once bought. */
export function writeInvestmentMonth(
  accounts: DemoAccounts,
  month: DemoMonth,
  state: DemoRunState,
  sweepClp: number,
  afpContribClp: number,
  rng: () => number
): void {
  const monthEnd = monthEndUtcYmd(month);
  const r = demoMonthlyReturn(month, rng);

  if (sweepClp > 0) {
    movement(accounts.fondoId, sweepClp, dayInMonth(month, 26), "Depósito|demo");
    state.fondoDepositsClp += sweepClp;
  }
  state.fondoValueClp = Math.max(0, state.fondoValueClp * (1 + r) + sweepClp);
  if (state.fondoValueClp > 0) valuation(accounts.fondoId, monthEnd, state.fondoValueClp);

  movement(accounts.afpId, afpContribClp, dayInMonth(month, 25), "Cotización obligatoria|demo");
  state.afpValueClp = Math.max(0, state.afpValueClp * (1 + r * 0.7) + afpContribClp);
  valuation(accounts.afpId, monthEnd, state.afpValueClp);

  if (accounts.propertyId != null && month >= "2024-08") {
    const monthsOwned =
      (Number(month.slice(0, 4)) - 2024) * 12 + (Number(month.slice(5, 7)) - 8);
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
};

/** Merchant → category rules so the demo gastos charts show category stacks out of the box. */
export function seedDemoMerchantCategoryRules(ccMasterId: number): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)`
  );
  let n = 0;
  for (const m of MERCHANTS) {
    const slug = MERCHANT_CATEGORY_SLUGS[m.category];
    const cat = getCcExpenseCategoryBySlug(slug);
    if (!cat) throw new Error(`demo: cc_expense_categories missing slug ${slug} (reference migrations not applied?)`);
    n += ins.run(ccMasterId, normalizeCcExpenseMerchantKey(m.name), cat.id).changes;
  }
  return n;
}
