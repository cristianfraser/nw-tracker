/**
 * The life ledger: the person's money, day by day, from the first month through today. Pure apart
 * from reading prices (`MarketReader`): it decides what happened and records it in the shapes the
 * documents are rendered from (`render.ts`) and the writers apply (`apply.ts`). It keeps every
 * balance itself and fails when one would go negative — a demo that overdraws is a story bug.
 */
import { igcTax } from "../../f22Draft.js";
import { isChileBusinessDay, nextChileBusinessDayYmd, priorChileBusinessDayYmd } from "../../marketHolidays.js";
import type { MarketReader } from "./market.js";
import {
  addDays,
  addMonths,
  ALLOWANCE,
  APV,
  BTC,
  boletaRetentionRate,
  CARDS,
  CARS,
  CASH_BAND,
  CONTRACT_JOBS,
  CONTRACTOR_JOBS,
  DAD_NAME,
  daysInMonth,
  DCA,
  DIVIDEND_PER_SHARE_USD,
  HOUSE,
  HOUSING,
  INTERNSHIPS,
  monthOf,
  monthsBetween,
  ONE_OFFS,
  PLAYS,
  V2_FIRST_MONTH,
  V2_REAL_BASE_MONTH,
  V2_SEED,
  ymd,
  type CardDef,
  type ContractJob,
  type ContractorJob,
  type Month,
  type Ymd,
} from "./person.js";
import { stream, type Rng } from "./rng.js";

/* ----------------------------------- shapes ------------------------------------- */

export type CashAcct = "vista" | "checking" | "checkingUsd" | "brokerClp" | "brokerUsd" | "exchangeClp";
export type Acct =
  | CashAcct
  | "btc"
  | "apvA"
  | "apvB"
  | "afpModelo"
  | "afpUno"
  | "afc"
  | "property"
  | `stock:${string}`
  | `card:${CardDef["key"]}`;

/** A line a bank cartola prints (vista and the peso checking account). */
export type BankRow = { account: "vista" | "checking"; date: Ymd; description: string; amount: number };

/** A ledger row written directly (transfers between own accounts, the broker's own records, funds). */
export type DirectMovement =
  | {
      type: "single";
      account: Acct;
      date: Ymd;
      amount: number;
      currency: "clp" | "usd";
      note: string;
      units?: number;
      flowKind?: string;
      cryptoKind?: "buy" | "sell";
      contributionPeriods?: Month[];
    }
  | {
      type: "transfer";
      from: Acct;
      to: Acct;
      date: Ymd;
      /** The from-leg: CLP when the transfer has one (a dollar sale names its dollars first). */
      amount: number;
      currency: "clp" | "usd";
      counterUsd?: number;
      /** A dollar sale (USD from-leg): the pesos the to-leg received. */
      counterClp?: number;
      units?: number;
      /** Units the to-leg receives when it differs (an AFP fund switch). */
      counterUnits?: number;
      flowKind: string | null;
      note: string;
    };

export type CardLine = {
  card: CardDef["key"];
  date: Ymd;
  merchant: string;
  category: string;
  currency: "clp" | "usd";
  amount: number;
  cuotas?: number;
};

export type InstallmentPlan = {
  id: string;
  card: CardDef["key"];
  purchaseDate: Ymd;
  merchant: string;
  category: string;
  totalClp: number;
  cuotas: number;
  cuotaClp: number;
  /** Close (statement date) of the cycle that bills cuota 1. */
  firstClose: Ymd;
};

export type CardStatement = {
  card: CardDef["key"];
  currency: "clp" | "usd";
  close: Ymd;
  periodFrom: Ymd;
  payBy: Ymd;
  nextClose: Ymd;
  /** One-shot lines (purchases, credits) dated inside the cycle. */
  lines: CardLine[];
  /** Cuotas billed this cycle. */
  cuotas: { plan: InstallmentPlan; n: number }[];
  /** The previous facturado and what paid it (printed in the header / as a line). */
  saldoAnterior: number;
  paidPrevious: number;
  paidPreviousDate: Ymd | null;
  /** A dollar payment made by buying dollars from the peso account (the card prints ABONO DE DIVISAS). */
  paidPreviousViaDivisas: boolean;
  facturado: number;
};

export type ContractPayslip = {
  job: ContractJob;
  month: Month;
  kind: "salary" | "severance";
  payDate: Ymd;
  pensionFund: "modelo" | "uno" | null;
  lines: { side: "haber" | "descuento"; section: "imponible" | "no_imponible" | "legal" | "other" | null; label: string; amount: number }[];
  /** Taxable pay (uncapped) and the capped contribution base. */
  taxablePay: number;
  taxableBase: number;
  pension: number;
  health: number;
  afc: number;
  tax: number;
  net: number;
  uf: number;
  utm: number;
};

export type ContractorPayslip = { job: ContractorJob; month: Month; wireDate: Ymd; grossUsd: number; feeUsd: number; fx: number };

export type MortgageCuota = { n: number; date: Ymd; clp: number; ufDay: number; pmtUf: number; interestUf: number; amortUf: number; balanceAfterUf: number };

export type Ledger = {
  today: Ymd;
  bank: BankRow[];
  direct: DirectMovement[];
  statements: CardStatement[];
  /** Card lines dated after the last close (the open cycle the feed lists). */
  openCycle: { card: CardDef["key"]; lines: CardLine[]; payment: { clp: number; usd: number; date: Ymd; usdViaDivisas: boolean } | null }[];
  plans: InstallmentPlan[];
  payslips: ContractPayslip[];
  contractorPayslips: ContractorPayslip[];
  mortgage: { cuotas: MortgageCuota[]; pieClp: number; principalUf: number; pieDate: Ymd } | null;
  /** AFC book account: contributions (the writer grows and marks it). */
  afcContributions: { date: Ymd; clp: number; month: Month }[];
  /** Month-end summary, for the build report and the invariants. */
  months: { month: Month; expensesClp: number; cashClp: number; band: [number, number] }[];
  /** Names the category rules need (description / merchant → category slug). */
  categoryByCheckingDescription: Map<string, string>;
  categoryByMerchant: Map<string, string>;
};

/* --------------------------------- constants ------------------------------------ */

const BRANCH = "Oficina Central";
export const MORTGAGE_MERCHANT = "MUTUARIA ANDES HIPOTECARIO";
const MORTGAGE_INCENDIO_CLP = 18_000;
const MORTGAGE_DESGRAVAMEN_CLP = 4_500;
export const APV_FUND_SERIES_KEY = "demo_apv_fondo";

/** Discretionary spend shares by category at the base lifestyle. */
const CATEGORY_WEIGHTS: Record<string, number> = {
  supermarket: 0.27,
  food: 0.19,
  fun: 0.13,
  transportation: 0.07,
  clothes: 0.08,
  others: 0.11,
  hobbies: 0.06,
  healthcare: 0.06,
  subscriptions: 0.03,
};

/** Merchants per category with a typical ticket (real CLP). */
const MERCHANTS: Record<string, { name: string; ticket: number }[]> = {
  supermarket: [
    { name: "LIDER EXPRESS", ticket: 16_000 },
    { name: "JUMBO", ticket: 42_000 },
    { name: "UNIMARC", ticket: 14_000 },
    { name: "TOTTUS", ticket: 24_000 },
    { name: "SANTA ISABEL", ticket: 11_000 },
  ],
  food: [
    { name: "STARBUCKS", ticket: 4_200 },
    { name: "RAPPI", ticket: 13_500 },
    { name: "UBER EATS", ticket: 14_000 },
    { name: "JUAN MAESTRO", ticket: 7_500 },
    { name: "PEDIDOSYA", ticket: 12_500 },
    { name: "RESTAURANT EL ALJIBE", ticket: 32_000 },
    { name: "SUSHI KYOTO", ticket: 19_000 },
  ],
  fun: [
    { name: "CINEMARK", ticket: 7_500 },
    { name: "BAR EL CLAN", ticket: 18_000 },
    { name: "PUNTOTICKET", ticket: 34_000 },
    { name: "TICKETMASTER", ticket: 45_000 },
    { name: "BOWLING CENTER", ticket: 12_000 },
  ],
  transportation: [
    { name: "UBER TRIP", ticket: 5_200 },
    { name: "CABIFY", ticket: 5_800 },
    { name: "METRO CARGA BIP", ticket: 8_000 },
  ],
  clothes: [
    { name: "FALABELLA", ticket: 29_000 },
    { name: "H&M", ticket: 22_000 },
    { name: "ZARA", ticket: 34_000 },
    { name: "NIKE STORE", ticket: 46_000 },
  ],
  others: [
    { name: "SODIMAC", ticket: 21_000 },
    { name: "MERCADOLIBRE", ticket: 18_000 },
    { name: "LIBRERIA ANTARTICA", ticket: 15_000 },
    { name: "PELUQUERIA URBANA", ticket: 11_000 },
    { name: "PARIS", ticket: 25_000 },
  ],
  hobbies: [
    { name: "DECATHLON", ticket: 28_000 },
    { name: "MUSICLAND", ticket: 35_000 },
    { name: "STEAM PURCHASE", ticket: 12_000 },
  ],
  healthcare: [
    { name: "CRUZ VERDE", ticket: 11_000 },
    { name: "SALCOBRAND", ticket: 9_500 },
    { name: "CLINICA SANTA MARIA", ticket: 42_000 },
    { name: "CENTRO DENTAL SONRISA", ticket: 38_000 },
  ],
  subscriptions: [{ name: "AUDIBLE", ticket: 9_000 }],
};

/** Fixed monthly card charges (real CLP) and their windows. */
const CARD_SUBSCRIPTIONS: { merchant: string; category: string; clp: number; from: Month; to?: Month; card?: CardDef["key"] }[] = [
  { merchant: "SPOTIFY", category: "subscriptions", clp: 5_000, from: "2018-05" },
  { merchant: "NETFLIX.COM", category: "subscriptions", clp: 6_500, from: "2018-05" },
  { merchant: "ENTEL PLAN MOVIL", category: "bills", clp: 14_000, from: "2018-05" },
  { merchant: "SMARTFIT", category: "hobbies", clp: 16_000, from: "2018-07" },
  { merchant: "DISNEY PLUS", category: "subscriptions", clp: 5_500, from: "2021-01", card: "second" },
];
const USD_SUBSCRIPTIONS: { merchant: string; usd: number; from: Month; to?: Month; card: CardDef["key"] }[] = [
  { merchant: "APPLE.COM/BILL", usd: 0.99, from: "2018-05", to: "2020-12", card: "main" },
  { merchant: "APPLE.COM/BILL", usd: 2.99, from: "2021-01", card: "main" },
  { merchant: "GITHUB, INC.", usd: 4, from: "2018-08", card: "main" },
  { merchant: "NOTION LABS", usd: 8, from: "2022-11", card: "second" },
  { merchant: "OPENAI *CHATGPT SUBSCR", usd: 20, from: "2023-03", card: "second" },
];

/* ---------------------------------- helpers ------------------------------------- */

function round(n: number): number {
  return Math.round(n);
}
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function firstBusinessDayOnOrAfter(d: Ymd): Ymd {
  return isChileBusinessDay(d) ? d : nextChileBusinessDayYmd(d)!;
}
function businessDayOnOrBefore(d: Ymd): Ymd {
  return isChileBusinessDay(d) ? d : priorChileBusinessDayYmd(d)!;
}
function lastBusinessDay(month: Month): Ymd {
  return businessDayOnOrBefore(ymd(month, daysInMonth(month)));
}

function contractJobFor(month: Month): ContractJob | null {
  return CONTRACT_JOBS.find((j) => month >= j.from && month <= j.to) ?? null;
}
function contractorJobFor(month: Month): ContractorJob | null {
  return CONTRACTOR_JOBS.find((j) => month >= j.from && (j.to == null || month <= j.to)) ?? null;
}
function housingFor(month: Month) {
  const h = [...HOUSING].reverse().find((x) => month >= x.from);
  if (!h) throw new Error(`demo v2: no housing for ${month}`);
  return h;
}
function carFor(month: Month) {
  return CARS.find((c) => month >= c.from && (c.to == null || month <= c.to)) ?? null;
}
function activeCards(month: Month): CardDef[] {
  return CARDS.filter((c) => month >= c.from);
}

/** Close date of `card` in `month`. */
export function cardClose(card: CardDef, month: Month): Ymd {
  return ymd(month, card.closeDay);
}
/** Santander pay-by: the 10th of the month after the close, moved back to a business day. */
export function cardPayBy(close: Ymd): Ymd {
  return businessDayOnOrBefore(ymd(addMonths(monthOf(close), 1), 10));
}

/** IUSC on a month's taxable amount (the monthly brackets: the annual table's factors in UTM). */
function iusc(taxable: number, utm: number, year: number): number {
  return Math.round(igcTax(taxable, utm, Math.max(2018, year + 1)));
}

function capUf(year: number): { pension: number; afc: number } {
  const t: Record<number, number> = { 2016: 74.3, 2017: 75.7, 2018: 78.3, 2019: 79.2, 2020: 80.2, 2021: 81.6, 2022: 81.6, 2023: 81.6, 2024: 84.3, 2025: 87.8, 2026: 89.9 };
  const p = t[year] ?? 89.9;
  return { pension: p, afc: Math.round(p * 1.5 * 10) / 10 };
}

/** AFP worker rate (10 % + commission) per AFP and month. */
export function afpWorkerRate(afp: "modelo" | "uno", month: Month): number {
  if (afp === "modelo") return month >= "2021-10" ? 10.58 : 10.77;
  if (month >= "2025-10") return 10.46;
  if (month >= "2023-10") return 10.49;
  return 10.69;
}

/** When the AFP switch credits UNO (Modelo until then). */
export const AFP_SWITCH_MONTH: Month = "2020-02";

/* ------------------------------------ book -------------------------------------- */

class Book {
  bal: Record<CashAcct, number> = { vista: 0, checking: 0, checkingUsd: 0, brokerClp: 0, brokerUsd: 0, exchangeClp: 0 };
  units = new Map<string, number>();
  bank: BankRow[] = [];
  direct: DirectMovement[] = [];

  /** Daily deltas of every cash account, so balances are checked in calendar order. */
  private daily: Record<CashAcct, Map<Ymd, number>> = {
    vista: new Map(),
    checking: new Map(),
    checkingUsd: new Map(),
    brokerClp: new Map(),
    brokerUsd: new Map(),
    exchangeClp: new Map(),
  };

  private add(acct: CashAcct, amount: number, day: Ymd) {
    const usd = acct === "checkingUsd" || acct === "brokerUsd";
    this.bal[acct] = usd ? cents(this.bal[acct] + amount) : this.bal[acct] + amount;
    const m = this.daily[acct];
    m.set(day, (m.get(day) ?? 0) + amount);
    if (amount < 0) {
      const low = this.lowestFrom(acct, day);
      if (low < (usd ? -0.005 : -0.5)) throw new Error(`demo v2: ${acct} would go negative on or after ${day} (${low}; this row ${amount})`);
    }
  }
  /** The lowest end-of-day balance of a cash account from `day` on (calendar order). */
  lowestFrom(acct: CashAcct, day: Ymd): number {
    const days = [...this.daily[acct].keys()].sort();
    let bal = 0;
    let low = Infinity;
    let seen = false;
    for (const d of days) {
      // The balance carried into `day` counts even when `day` has no row of its own.
      if (!seen && d > day) {
        seen = true;
        low = Math.min(low, bal);
      }
      bal += this.daily[acct].get(d)!;
      if (d >= day) {
        seen = true;
        low = Math.min(low, bal);
      }
    }
    return Math.min(low, bal);
  }
  /** A cartola row with no counterpart in the ledger (salary, rent, a bill…). */
  bankRow(account: "vista" | "checking", date: Ymd, description: string, amount: number) {
    amount = round(amount);
    if (amount === 0) return;
    this.add(account, amount, date);
    this.bank.push({ account, date, description, amount });
  }
  /** A transfer between own accounts; the bank side (if any) prints `bankDescription`. */
  transfer(
    t: { from: Acct; to: Acct; date: Ymd; clp?: number; usd?: number; units?: number; flowKind?: string | null; note: string },
    bank?: { account: "vista" | "checking"; description: string; side: "from" | "to" }
  ) {
    const clp = t.clp != null ? round(t.clp) : undefined;
    const usd = t.usd != null ? cents(t.usd) : undefined;
    const cashLeg = (a: Acct, sign: 1 | -1) => {
      if (!isCash(a)) return;
      const isUsd = a === "checkingUsd" || a === "brokerUsd";
      const v = isUsd ? usd : clp;
      if (v == null) throw new Error(`demo v2: transfer ${t.note} needs a ${isUsd ? "USD" : "CLP"} leg for ${a}`);
      this.add(a, sign * v, t.date);
    };
    cashLeg(t.from, -1);
    cashLeg(t.to, 1);
    // Selling dollars (a USD account sends, a peso account receives): the dollars are the from-leg.
    const usdSale = clp != null && usd != null && (t.from === "checkingUsd" || t.from === "brokerUsd");
    this.direct.push({
      type: "transfer",
      from: t.from,
      to: t.to,
      date: t.date,
      amount: usdSale ? usd! : clp != null ? clp : usd!,
      currency: usdSale ? "usd" : clp != null ? "clp" : "usd",
      counterUsd: !usdSale && clp != null && usd != null ? usd : undefined,
      counterClp: usdSale ? clp : undefined,
      units: t.units,
      flowKind: t.flowKind ?? null,
      note: t.note,
    });
    if (bank) {
      const signed = bank.side === "from" ? -clp! : clp!;
      // The bank prints it; the importer finds this transfer and keeps it (superseded_by_transfer).
      this.bank.push({ account: bank.account, date: t.date, description: bank.description, amount: signed });
    }
  }
  single(m: Extract<DirectMovement, { type: "single" }>) {
    if (isCash(m.account)) this.add(m.account as CashAcct, m.amount, m.date);
    this.direct.push(m);
  }
  unitsOf(key: string) {
    return this.units.get(key) ?? 0;
  }
  addUnits(key: string, u: number, decimals: number) {
    const f = 10 ** decimals;
    this.units.set(key, Math.round((this.unitsOf(key) + u) * f) / f);
  }
}

function hasCheckingOn(day: Ymd): boolean {
  return day >= "2018-04-01";
}

function isCash(a: Acct): a is CashAcct {
  return ["vista", "checking", "checkingUsd", "brokerClp", "brokerUsd", "exchangeClp"].includes(a);
}

/* -------------------------------- simulation ------------------------------------ */

type CardCycleState = {
  /** Purchases dated in [periodFrom, close) of each future close, by close date. */
  pendingByClose: Map<Ymd, CardLine[]>;
  prevFacturado: { clp: number; usd: number };
  paid: { clp: { amount: number; date: Ymd } | null; usd: { amount: number; date: Ymd; viaDivisas: boolean } | null };
};

export function simulate(market: MarketReader, today: Ymd): Ledger {
  const book = new Book();
  const lastMonth = monthOf(today);
  const plans: InstallmentPlan[] = [];
  const statements: CardStatement[] = [];
  const payslips: ContractPayslip[] = [];
  const contractorPayslips: ContractorPayslip[] = [];
  const afcContributions: Ledger["afcContributions"] = [];
  const months: Ledger["months"] = [];
  const catByDesc = new Map<string, string>();
  const catByMerchant = new Map<string, string>();
  const cards = new Map<CardDef["key"], CardCycleState>();
  const pendingF29: { day: Ymd; clp: number }[] = [];
  /** Arrivals dated in a later month than the one that decided them, run at that month's start. */
  const deferred: { day: Ymd; run: () => void }[] = [];
  const defer = (day: Ymd, run: () => void) => {
    if (day <= today) deferred.push({ day, run });
  };
  for (const c of CARDS) cards.set(c.key, { pendingByClose: new Map(), prevFacturado: { clp: 0, usd: 0 }, paid: { clp: null, usd: null } });

  const ufBase = market.uf(`${V2_REAL_BASE_MONTH}-01`);
  /** Real (early-2016) CLP → nominal CLP on `day`. */
  const nominal = (real: number, day: Ymd) => real * (market.uf(day) / ufBase);

  const expenseByMonth = new Map<Month, number>();
  const addExpense = (day: Ymd, clp: number) => {
    const m = monthOf(day);
    expenseByMonth.set(m, (expenseByMonth.get(m) ?? 0) + clp);
  };

  const bankBill = (account: "vista" | "checking", day: Ymd, desc: string, category: string, clp: number) => {
    if (day > today) return;
    catByDesc.set(desc, category);
    book.bankRow(account, day, desc, -clp);
    addExpense(day, clp);
  };

  const cardOf = (key: CardDef["key"]) => CARDS.find((c) => c.key === key)!;
  /** The close whose cycle a purchase on `day` belongs to (a purchase on the close day bills next). */
  const closeForPurchase = (card: CardDef, day: Ymd): Ymd => {
    const m = monthOf(day);
    const c = cardClose(card, m);
    return day < c ? c : cardClose(card, addMonths(m, 1));
  };
  const cardPurchase = (line: CardLine) => {
    if (line.date > today) return;
    const card = cardOf(line.card);
    if (monthOf(line.date) < card.from) throw new Error(`demo v2: ${line.merchant} on card ${card.key} before it opens`);
    // The mortgage's card line is split by the app itself (carrying cost vs amortización).
    if (line.merchant !== MORTGAGE_MERCHANT) catByMerchant.set(line.merchant, line.category);
    const st = cards.get(line.card)!;
    const close = closeForPurchase(card, line.date);
    const list = st.pendingByClose.get(close) ?? [];
    list.push(line);
    st.pendingByClose.set(close, list);
    addExpense(line.date, line.currency === "usd" ? line.amount * market.fx(line.date) : line.amount);
  };
  const cardPlan = (card: CardDef["key"], day: Ymd, merchant: string, category: string, totalClp: number, cuotas: number) => {
    if (day > today) return;
    const cuotaClp = round(totalClp / cuotas / 10) * 10;
    const plan: InstallmentPlan = {
      id: `${card}|${day}|${merchant}`,
      card,
      purchaseDate: day,
      merchant,
      category,
      totalClp: cuotaClp * cuotas,
      cuotas,
      cuotaClp,
      firstClose: closeForPurchase(cardOf(card), day),
    };
    catByMerchant.set(merchant, category);
    plans.push(plan);
    addExpense(day, plan.totalClp);
  };

  /* ------------------------- lifestyle (the ratchet) ------------------------- */
  let lifestyleReal = 175_000;
  let smoothedIncomeReal = ALLOWANCE.clp;
  const targetFor = (incomeReal: number) => 175_000 * Math.pow(Math.max(incomeReal, 150_000) / ALLOWANCE.clp, 0.52);

  /* ------------------------- taxes and contributions ------------------------- */
  type YearTax = { contractTaxable: number; iuscWithheld: number; honorariosGross: number; honorariosRetention: number; apvB: number; independent: boolean };
  const taxYears = new Map<number, YearTax>();
  const yearTax = (y: number) => {
    let t = taxYears.get(y);
    if (!t) {
      t = { contractTaxable: 0, iuscWithheld: 0, honorariosGross: 0, honorariosRetention: 0, apvB: 0, independent: false };
      taxYears.set(y, t);
    }
    return t;
  };
  /** Independent contributions (AFP, SIS, accidentes, Sanna, salud) on the honorarios of a year. */
  const independentContributions = (y: number) => {
    const t = yearTax(y);
    if (!t.independent || t.honorariosGross <= 0) return { base: 0, total: 0, pension: 0, healthAndAfp: 0 };
    const capClp = capUf(y).pension * 12 * market.uf(`${y}-12-31`);
    const base = Math.min(0.8 * t.honorariosGross, capClp);
    const pension = round(base * 0.1);
    const afpTotal = round((base * afpWorkerRate("uno", `${y}-12`)) / 100);
    const health = round(base * 0.07);
    const other = round(base * (0.0149 + 0.0093 + 0.0003));
    return { base, total: afpTotal + health + other, pension, healthAndAfp: afpTotal + health };
  };
  const annualTax = (y: number) => {
    const t = yearTax(y);
    const uta = 12 * market.utm(`${y}-12`);
    const presumed = Math.min(0.3 * t.honorariosGross, 15 * uta);
    const contrib = independentContributions(y);
    const base = t.contractTaxable + t.honorariosGross - presumed - contrib.healthAndAfp - t.apvB;
    const igc = igcTax(base, uta, y + 1);
    const credits = t.iuscWithheld + Math.max(0, t.honorariosRetention - contrib.total);
    return { base, igc, uta, result: round(igc - credits), marginal: marginalRate(base / uta) };
  };
  const marginalRate = (utas: number) => (utas <= 13.5 ? 0 : utas <= 30 ? 0.04 : utas <= 50 ? 0.08 : utas <= 70 ? 0.135 : utas <= 90 ? 0.23 : 0.304);

  /* ---------------------------------- AFP ----------------------------------- */
  const afpModeloSeries = "afp_modelo_cuota_a";
  const afpUnoSeries = "afp_uno_cuota_a";
  let afpSwitched = false;
  const afpSwitchDays = () => {
    const third = ymd(AFP_SWITCH_MONTH, 3);
    const sale = firstBusinessDayOnOrAfter(third);
    let credit = sale;
    for (let i = 0; i < 4; i++) credit = nextChileBusinessDayYmd(credit)!;
    return { sale, credit };
  };
  const afpCredit = (day: Ymd, clp: number, periods: Month[], note: string) => {
    if (day > today || clp <= 0) return;
    const { credit } = afpSwitchDays();
    const onUno = day >= credit;
    const series = onUno ? afpUnoSeries : afpModeloSeries;
    const units = Math.round((clp / market.fundUnit(series, day)) * 1e4) / 1e4;
    book.addUnits(onUno ? "afpUno" : "afpModelo", units, 4);
    book.single({ type: "single", account: onUno ? "afpUno" : "afpModelo", date: day, amount: round(clp), currency: "clp", note, units, contributionPeriods: periods });
  };

  /* ---------------------------------- APV ------------------------------------ */
  const apvBonuses: { day: Ymd; clp: number }[] = [];

  /* ------------------------------ broker helpers ----------------------------- */
  const buyStock = (day: Ymd, ticker: string, usd: number) => {
    usd = cents(usd);
    if (usd <= 0) return;
    const px = market.close(ticker, day);
    const units = Math.round((usd / px) * 1e6) / 1e6;
    book.addUnits(`stock:${ticker}`, units, 6);
    book.transfer({ from: "brokerUsd", to: `stock:${ticker}`, date: day, usd, units, flowKind: "stock_buy", note: `Broker|compra ${ticker}` });
  };
  const sellStock = (day: Ymd, ticker: string, fraction: number): number => {
    const held = book.unitsOf(`stock:${ticker}`);
    const units = Math.round(held * fraction * 1e6) / 1e6;
    if (units <= 0) return 0;
    const usd = cents(units * market.close(ticker, day));
    book.addUnits(`stock:${ticker}`, -units, 6);
    book.transfer({ from: `stock:${ticker}`, to: "brokerUsd", date: day, usd, units, flowKind: "stock_sell", note: `Broker|venta ${ticker}` });
    return usd;
  };
  /** CLP deposited to the broker and converted to dollars the same day. */
  const depositBrokerClp = (day: Ymd, clp: number) => {
    clp = round(clp / 1000) * 1000;
    if (clp <= 0) return;
    book.transfer({ from: "checking", to: "brokerClp", date: day, clp, flowKind: null, note: "Broker|depósito" }, { account: "checking", description: "TRANSF A BROKER DEMO SPA", side: "from" });
    const usd = cents((clp / market.fx(day)) * 0.995);
    book.transfer({ from: "brokerClp", to: "brokerUsd", date: day, clp, usd, flowKind: "compra_usd_venta_clp", note: "Broker|compra de dólares" });
  };
  const depositBrokerUsd = (day: Ymd, usd: number) => {
    usd = cents(Math.floor(usd / 100) * 100);
    if (usd <= 0) return;
    book.transfer({ from: "checkingUsd", to: "brokerUsd", date: day, usd, flowKind: null, note: "Broker|depósito USD" });
  };
  const sellUsd = (day: Ymd, usd: number, from: "checkingUsd" = "checkingUsd") => {
    usd = cents(Math.floor(usd / 10) * 10);
    if (usd <= 0) return;
    const clp = round(usd * market.fx(day) * 0.992);
    book.transfer(
      { from, to: "checking", date: day, clp, usd, flowKind: "withdrawal_usd", note: "Venta de divisas" },
      { account: "checking", description: "ABONO POR VENTA DE DIVISAS", side: "to" }
    );
  };

  /* --------------------------------- mortgage -------------------------------- */
  let mortgage: Ledger["mortgage"] = null;

  /* --------------------------------- months ---------------------------------- */
  let lastAgeMonthsExpense: number[] = [];
  for (let month = V2_FIRST_MONTH; month <= lastMonth; month = addMonths(month, 1)) {
    const r = (label: string): Rng => stream(V2_SEED, `${month}|${label}`);
    const year = Number(month.slice(0, 4));
    const mo = Number(month.slice(5, 7));
    const contract = contractJobFor(month);
    const contractor = contractorJobFor(month);
    const housing = housingFor(month);
    const car = carFor(month);
    const working = contract != null || contractor != null;
    const hasChecking = month >= "2018-04";

    for (const d of deferred.filter((x) => monthOf(x.day) === month).sort((a, b) => a.day.localeCompare(b.day))) d.run();
    // The cuenta vista opens with what he had saved from summer jobs.
    if (month === V2_FIRST_MONTH) book.bankRow("vista", firstBusinessDayOnOrAfter(ymd(month, 1)), "DEPOSITO EN EFECTIVO", 380_000);
    // Opening the checking account: the vista's savings move over.
    if (month === "2018-04") {
      const day = ymd(month, 1);
      const moved = Math.floor((book.bal.vista - 60_000) / 10_000) * 10_000;
      if (moved > 0) {
        book.transfer(
          { from: "vista", to: "checking", date: day, clp: moved, flowKind: null, note: "Traspaso cuenta vista → cuenta corriente" },
          { account: "vista", description: "TRASPASO A CUENTA CORRIENTE", side: "from" }
        );
        book.bank.push({ account: "checking", date: day, description: "TRASPASO DE CUENTA VISTA", amount: moved });
      }
    }

    /* ---------- income ---------- */
    let incomeNominal = 0;
    if (month >= ALLOWANCE.from && month <= ALLOWANCE.to) {
      const day = firstBusinessDayOnOrAfter(ymd(month, 1));
      if (day <= today) {
        book.bankRow("vista", day, `TRANSF. DE ${DAD_NAME}`, ALLOWANCE.clp);
        if (hasChecking) {
          const next = nextChileBusinessDayYmd(day)!;
          book.transfer(
            { from: "vista", to: "checking", date: next, clp: ALLOWANCE.clp, flowKind: null, note: "Traspaso cuenta vista → cuenta corriente" },
            { account: "vista", description: "TRASPASO A CUENTA CORRIENTE", side: "from" }
          );
          book.bank.push({ account: "checking", date: next, description: "TRASPASO DE CUENTA VISTA", amount: ALLOWANCE.clp });
        }
      }
      incomeNominal += ALLOWANCE.clp;
    }
    for (const it of INTERNSHIPS) {
      if (!it.months.includes(month)) continue;
      const net = round(it.grossClp * (1 - boletaRetentionRate(year)));
      const day = firstBusinessDayOnOrAfter(ymd(addMonths(month, 1), 5));
      defer(day, () => book.bankRow(hasCheckingOn(day) ? "checking" : "vista", day, `TRANSF. DE ${it.employer}`, net));
      const t = yearTax(year);
      t.honorariosGross += it.grossClp;
      t.honorariosRetention += it.grossClp - net;
      incomeNominal += net;
    }
    if (contract) {
      const ps = contractPayslip(contract, month, market);
      if (ps.payDate <= today) {
        book.bankRow("checking", ps.payDate, `ABONO REMUNERACIONES ${contract.bankName}`, ps.net);
        payslips.push(ps);
        const t = yearTax(year);
        t.contractTaxable += ps.taxablePay - ps.pension - ps.health - ps.afc;
        t.iuscWithheld += ps.tax;
        // AFP and AFC are credited when the employer pays Previred (~10th of next month).
        const credit = firstBusinessDayOnOrAfter(ymd(addMonths(month, 1), 10));
        afpCredit(credit, round(ps.taxableBase * 0.1), [month], `Cotización obligatoria ${month}`);
        if (credit <= today) afcContributions.push({ date: credit, clp: round(ps.taxableBase * 0.022), month });
      }
      incomeNominal += ps.net;
      if (month === contract.to) {
        // Finiquito: vacaciones proporcionales, paid with the last month.
        const fin = finiquitoPayslip(contract, month, market);
        if (fin.payDate <= today) {
          book.bankRow("checking", fin.payDate, `PAGO FINIQUITO ${contract.bankName}`, fin.net);
          payslips.push(fin);
        }
      }
    }
    if (contractor) {
      // The platform pays the month's invoice on its last business day.
      const wire = lastBusinessDay(month);
      const feeUsd = contractor.transferFeeUsd;
      const netUsd = contractor.monthlyUsd - feeUsd;
      if (wire <= today) {
        const fx = market.fx(wire);
        book.single({ type: "single", account: "checkingUsd", date: wire, amount: netUsd, currency: "usd", note: `Rec Or de Pago ${contractor.platform} ${contractor.employer}`, flowKind: "compra_usd" });
        contractorPayslips.push({ job: contractor, month, wireDate: wire, grossUsd: contractor.monthlyUsd, feeUsd, fx });
        const grossClp = round(contractor.monthlyUsd * fx);
        const ret = round(grossClp * boletaRetentionRate(Number(wire.slice(0, 4))));
        const ty = yearTax(Number(wire.slice(0, 4)));
        ty.honorariosGross += grossClp;
        ty.honorariosRetention += ret;
        ty.independent = true;
        // The retention goes to the SII with the next F29 (by the 12th).
        const f29 = businessDayOnOrBefore(ymd(addMonths(monthOf(wire), 1), 12));
        if (f29 <= today) pendingF29.push({ day: f29, clp: ret });
      }
      incomeNominal += contractor.monthlyUsd * market.fx(ymd(month, 15)) * 0.83;
    }
    // F29 payments due this month.
    for (const p of pendingF29.filter((x) => monthOf(x.day) === month)) {
      ensureClp(p.day, p.clp);
      bankBill("checking", p.day, "PAGO IMPUESTOS F29 SII", "taxes", p.clp);
    }

    // Operación renta: April pays or May refunds the previous year.
    if (mo === 4 && taxYears.has(year - 1)) {
      const t = annualTax(year - 1);
      const indep = independentContributions(year - 1);
      if (t.result > 0) {
        const day = businessDayOnOrBefore(ymd(month, 28));
        if (day <= today) {
          ensureClp(day, t.result);
          bankBill("checking", day, "PAGO F22 TGR", "taxes", t.result);
        }
      } else if (t.result < 0) {
        const day = firstBusinessDayOnOrAfter(ymd(addMonths(month, 1), 14));
        if (day <= today) book.bankRow(hasChecking ? "checking" : "vista", day, "DEVOLUCION IMPUESTO TGR", -t.result);
        if (hasChecking) catByDesc.set("DEVOLUCION IMPUESTO TGR", "taxes");
      }
      if (indep.pension > 0) {
        const periods = Array.from({ length: 12 }, (_, i) => `${year - 1}-${String(i + 1).padStart(2, "0")}`);
        afpCredit(firstBusinessDayOnOrAfter(ymd(addMonths(month, 3), 20)), indep.pension, periods, `Cotización trabajador independiente ${year - 1}`);
      }
    }

    /* ---------- lifestyle ---------- */
    const incomeReal = incomeNominal / (market.uf(ymd(month, 15)) / ufBase);
    smoothedIncomeReal = smoothedIncomeReal * 0.85 + incomeReal * 0.15;
    const target = targetFor(smoothedIncomeReal);
    lifestyleReal = Math.max(lifestyleReal, lifestyleReal + 0.045 * (target - lifestyleReal));

    /* ---------- housing ---------- */
    if (housing.kind === "parents") {
      if (month >= "2018-04") bankBill("checking", ymd(month, 5), "TRANSF APORTE GASTOS CASA", "others", round(nominal(housing.aporteClp, ymd(month, 5)) / 1000) * 1000);
    } else if (housing.kind === "rent") {
      const leaseYears = Math.floor(monthsBetween(housing.from, month) / 12);
      const anniversary = addMonths(housing.from, leaseYears * 12);
      const rent = round((housing.rentClp * market.uf(ymd(anniversary, 1))) / market.uf(ymd(housing.from, 1)) / 1000) * 1000;
      const day = ymd(month, 5);
      if (month === housing.from) bankBill("checking", ymd(month, 2), `TRANSF GARANTIA ARRIENDO ${housing.landlord}`, "bills", housing.rentClp);
      bankBill("checking", day, `TRANSF ARRIENDO ${housing.landlord}`, "bills", rent);
      bankBill("checking", ymd(month, 10), "PAGO GASTOS COMUNES EDIFICIO", "bills", round(nominal(housing.gcClp, day) * r("gc").jitter(1, 0.08)));
      if (month === housing.to) {
        const back = ymd(addMonths(month, 1), 12);
        if (back <= today) {
          book.bankRow("checking", back, `DEVOLUCION GARANTIA ${housing.landlord}`, housing.rentClp);
          catByDesc.set(`DEVOLUCION GARANTIA ${housing.landlord}`, "bills");
        }
      }
    } else {
      bankBill("checking", ymd(month, 10), "PAGO GASTOS COMUNES EDIFICIO", "bills", round(nominal(HOUSE.gcClp, ymd(month, 10)) * r("gc").jitter(1, 0.08)));
      if (HOUSE.contribucionesMonths.includes(mo)) bankBill("checking", ymd(month, 20), "TGR CONTRIBUCIONES", "bills", round(nominal(HOUSE.contribucionesClp, ymd(month, 20))));
    }
    if (housing.kind !== "parents") {
      const winter = mo >= 6 && mo <= 8;
      bankBill("checking", ymd(month, 14), "PAGO EN LINEA ENEL", "bills", round(nominal(24_000 * (winter ? 1.3 : 1), ymd(month, 14)) * r("enel").jitter(1, 0.15)));
      bankBill("checking", ymd(month, 16), "PAGO EN LINEA METROGAS", "bills", round(nominal(14_000 * (winter ? 2.2 : 1), ymd(month, 16)) * r("gas").jitter(1, 0.2)));
      bankBill("checking", ymd(month, 17), "PAGO EN LINEA AGUAS ANDINAS", "bills", round(nominal(9_000, ymd(month, 17)) * r("agua").jitter(1, 0.15)));
      bankBill("checking", ymd(month, 18), "PAGO EN LINEA VTR", "bills", round(nominal(21_000, ymd(month, 18))));
    }

    /* ---------- the house ---------- */
    if (month === monthOf(HOUSE.dadGift.date) && HOUSE.dadGift.date <= today) {
      book.bankRow("checking", HOUSE.dadGift.date, `TRANSF. DE ${DAD_NAME}`, HOUSE.dadGift.clp);
    }
    if (month === HOUSE.month && HOUSE.pieDate <= today) {
      const ufPie = market.uf(HOUSE.pieDate);
      const pieClp = round(HOUSE.pieUf * ufPie);
      ensureClp(HOUSE.pieDate, pieClp);
      catByDesc.set("TRANSF A INMOBILIARIA LOS ALAMOS", "deposits");
      book.bankRow("checking", HOUSE.pieDate, "TRANSF A INMOBILIARIA LOS ALAMOS", -pieClp);
      const gastos = round(HOUSE.gastosOperacionalesUf * market.uf(HOUSE.gastosDate));
      ensureClp(HOUSE.gastosDate, gastos);
      bankBill("checking", HOUSE.gastosDate, "TRANSF NOTARIA Y CBR GASTOS OPERACIONALES", "others", gastos);
      mortgage = { cuotas: [], pieClp, principalUf: HOUSE.valueUf - HOUSE.pieUf, pieDate: HOUSE.pieDate };
    }
    if (mortgage && month > HOUSE.month) {
      const day = ymd(month, 10);
      if (day <= today) {
        const n = mortgage.cuotas.length + 1;
        const s = mortgageCuotaUf(mortgage.principalUf, n);
        const ufDay = market.uf(day);
        const clp = round(s.pmtUf * ufDay) + MORTGAGE_INCENDIO_CLP + MORTGAGE_DESGRAVAMEN_CLP;
        mortgage.cuotas.push({ n, date: day, clp, ufDay, ...s });
        cardPurchase({ card: "main", date: day, merchant: MORTGAGE_MERCHANT, category: "bills", currency: "clp", amount: clp });
      }
    }

    /* ---------- cars ---------- */
    for (const c of CARS) {
      if (month !== c.from) continue;
      const day = ymd(month, 15);
      const cash = c.priceClp - c.tradeInClp - (c.id === "car1" ? 2_500_000 : 0);
      ensureClp(day, cash);
      bankBill("checking", day, c.id === "car1" ? "TRANSF A AUTOMOTORA LOS ANDES" : "TRANSF A AUTOMOTORA KAUFMANN", "transportation", cash);
      if (c.id === "car1") cardPlan("main", ymd(month, 16), "AUTOMOTORA LOS ANDES", "transportation", 2_500_000, 12);
    }
    if (car) {
      if (mo === 3) {
        bankBill("checking", ymd(month, 25), "PERMISO CIRCULACION MUNI PROVIDENCIA", "transportation", round(car.permisoClp * (market.uf(ymd(month, 25)) / market.uf(ymd(car.from, 1)))));
        cardPurchase({ card: "main", date: ymd(month, 24), merchant: "SOAP SEGUROS FALABELLA", category: "transportation", currency: "clp", amount: round(nominal(7_500, ymd(month, 24))) });
      }
      const rr = r("car");
      for (let i = 0; i < 3; i++) {
        const day = ymd(month, 4 + i * 9 + rr.int(0, 3));
        cardPurchase({ card: "main", date: day, merchant: rr.pick(["COPEC", "SHELL", "ARAMCO"]), category: "transportation", currency: "clp", amount: round(nominal(26_000, day) * rr.jitter(1, 0.25) / 10) * 10 });
      }
      cardPurchase({ card: "main", date: ymd(month, 7), merchant: "AUTOPISTA CENTRAL TAG", category: "transportation", currency: "clp", amount: round(nominal(17_000, ymd(month, 7)) * rr.jitter(1, 0.3)) });
      if (mo === 6 || mo === 12) cardPurchase({ card: "main", date: ymd(month, 19), merchant: "SERVICIO AUTOMOTRIZ PROVIDENCIA", category: "transportation", currency: "clp", amount: round(nominal(140_000, ymd(month, 19)) * rr.jitter(1, 0.3)) });
      if (car.insuranceClp > 0) cardPurchase({ card: "second", date: ymd(month, 3), merchant: "HDI SEGUROS AUTO", category: "transportation", currency: "clp", amount: round(car.insuranceClp * (market.uf(ymd(month, 3)) / market.uf(ymd(car.from, 1)))) });
    }

    /* ---------- discretionary spend ---------- */
    {
      const rr = r("spend");
      const cardsNow = activeCards(month);
      const monthMult = rr.chance(0.12) ? rr.range(1.4, 1.8) : rr.chance(0.2) ? rr.range(0.7, 0.85) : rr.range(0.9, 1.12);
      for (const [cat, w] of Object.entries(CATEGORY_WEIGHTS)) {
        let season = 1;
        if (mo === 12 && (cat === "others" || cat === "clothes")) season = 2.1;
        if (mo === 12 && cat === "food") season = 1.3;
        if (mo === 9 && (cat === "fun" || cat === "food")) season = 1.35;
        if (mo === 2 && cat === "fun") season = 1.25;
        const budgetReal = lifestyleReal * w * season * monthMult * rr.jitter(1, 0.18);
        const pool = MERCHANTS[cat]!;
        const scale = Math.pow(lifestyleReal / 175_000, 0.25);
        const meanTicket = (pool.reduce((a, m) => a + m.ticket, 0) / pool.length) * scale;
        // As many purchases as the budget buys at the average ticket (never overshooting by design).
        const count = Math.floor(budgetReal / meanTicket + rr.next());
        for (let k = 0; k < count; k++) {
          const m = rr.pick(pool);
          const ticketReal = m.ticket * scale * rr.jitter(1, 0.45);
          const day = ymd(month, rr.int(1, daysInMonth(month)));
          const amount = Math.max(1_000, round(nominal(ticketReal, day) / 10) * 10);
          if (cardsNow.length === 0) {
            // No card yet: debit from the cuenta vista (the cuenta corriente once it exists).
            bankBill(hasChecking ? "checking" : "vista", day, `COMPRA NAC ${m.name}`, cat, amount);
          } else {
            const onSecond = cardsNow.length > 1 && rr.chance(0.35);
            cardPurchase({ card: onSecond ? "second" : "main", date: day, merchant: m.name, category: cat, currency: "clp", amount });
          }
        }
      }
      for (const s of CARD_SUBSCRIPTIONS) {
        if (month < s.from || (s.to && month > s.to)) continue;
        const card = s.card && cardsNow.some((c) => c.key === s.card) ? s.card : "main";
        if (!cardsNow.some((c) => c.key === card)) continue;
        const day = ymd(month, 3 + (s.merchant.length % 20));
        cardPurchase({ card, date: day, merchant: s.merchant, category: s.category, currency: "clp", amount: round(nominal(s.clp, day) / 10) * 10 });
      }
      for (const s of USD_SUBSCRIPTIONS) {
        if (month < s.from || (s.to && month > s.to)) continue;
        if (!cardsNow.some((c) => c.key === s.card)) continue;
        cardPurchase({ card: s.card, date: ymd(month, 2 + (s.merchant.length % 24)), merchant: s.merchant, category: "subscriptions", currency: "usd", amount: s.usd });
      }
      if (cardsNow.length > 0 && month >= "2019-01" && rr.chance(0.45)) {
        const day = ymd(month, rr.int(2, 27));
        cardPurchase({ card: cardsNow.length > 1 ? "second" : "main", date: day, merchant: "AMAZON.COM", category: "others", currency: "usd", amount: cents(rr.range(25, 140) * Math.pow(lifestyleReal / 300_000, 0.4)) });
      }
      if (month < "2018-05" && month >= "2016-03") bankBill("vista", ymd(month, 4), "COMPRA NAC SPOTIFY", "subscriptions", round(nominal(4_000, ymd(month, 4))));
    }
    for (const o of ONE_OFFS) {
      if (o.month !== month) continue;
      const day = ymd(month, o.day);
      const key = o.card && activeCards(month).some((c) => c.key === o.card) ? o.card : "main";
      if (o.clp != null) {
        if (o.cuotas && o.cuotas > 1) cardPlan(key, day, o.label, o.category, o.clp, o.cuotas);
        else cardPurchase({ card: key, date: day, merchant: o.label, category: o.category, currency: "clp", amount: o.clp });
      }
      if (o.usd) cardPurchase({ card: key, date: addDays(day, 1), merchant: o.label, category: o.category, currency: "usd", amount: o.usd });
    }

    /* ---------- card closes and payments ---------- */
    for (const card of activeCards(month)) {
      const st = cards.get(card.key)!;
      const close = cardClose(card, month);
      // Pay last month's statement first (its pay-by falls in this month, before this close).
      const prev = statements.filter((s) => s.card === card.key && monthOf(s.close) === addMonths(month, -1));
      for (const s of prev) {
        if (s.facturado <= 0) continue;
        const payDay = businessDayOnOrBefore(addDays(s.payBy, -2));
        if (payDay > today) continue;
        if (s.currency === "clp") {
          ensureClp(payDay, s.facturado);
          book.bankRow("checking", payDay, `PAGO TARJETA CREDITO ${card.last4}`, -s.facturado);
          st.paid.clp = { amount: s.facturado, date: payDay };
        } else if (book.lowestFrom("checkingUsd", payDay) >= s.facturado + 1) {
          // A dollar account pays the dollar debt directly.
          book.transfer({ from: "checkingUsd", to: `card:${card.key}`, date: payDay, usd: s.facturado, flowKind: "pago_tarjeta", note: `Pago tarjeta ${card.last4} USD` });
          st.paid.usd = { amount: s.facturado, date: payDay, viaDivisas: false };
        } else {
          // Dollars bought for the purpose: «Compra de divisas» out of the peso account.
          const clp = round(s.facturado * market.fx(payDay) * 1.018);
          ensureClp(payDay, clp);
          book.bankRow("checking", payDay, "EGRESO POR COMPRA DE DIVISAS", -clp);
          st.paid.usd = { amount: s.facturado, date: payDay, viaDivisas: true };
        }
      }
      if (close > today) continue;
      const periodFrom = cardClose(card, addMonths(month, -1));
      const lines = st.pendingByClose.get(close) ?? [];
      st.pendingByClose.delete(close);
      const cuotas = plans
        .filter((p) => p.card === card.key && p.firstClose <= close)
        .map((p) => ({ plan: p, n: monthsBetween(monthOf(p.firstClose), month) + 1 }))
        .filter((x) => x.n >= 1 && x.n <= x.plan.cuotas);
      for (const currency of ["clp", "usd"] as const) {
        const ls = lines.filter((l) => l.currency === currency);
        const cs = currency === "clp" ? cuotas : [];
        const facturado =
          currency === "clp"
            ? ls.reduce((a, l) => a + l.amount, 0) + cs.reduce((a, c) => a + c.plan.cuotaClp, 0)
            : cents(ls.reduce((a, l) => a + l.amount, 0));
        if (ls.length === 0 && cs.length === 0 && st.prevFacturado[currency] === 0) continue;
        const paid = st.paid[currency];
        statements.push({
          card: card.key,
          currency,
          close,
          periodFrom,
          payBy: cardPayBy(close),
          nextClose: cardClose(card, addMonths(month, 1)),
          lines: ls,
          cuotas: cs,
          saldoAnterior: st.prevFacturado[currency],
          paidPrevious: paid?.amount ?? 0,
          paidPreviousDate: paid?.date ?? null,
          paidPreviousViaDivisas: paid != null && "viaDivisas" in paid ? paid.viaDivisas : false,
          facturado,
        });
        st.prevFacturado[currency] = facturado;
        st.paid[currency] = null;
      }
    }

    /* ---------- contractor dollars → pesos ---------- */
    if (book.bal.checkingUsd > 0) {
      // Keep about two months of peso outflows in pesos.
      const avg = trailingExpense();
      const want = Math.max(0, avg * 2 - book.bal.checking);
      const day = firstBusinessDayOnOrAfter(ymd(month, 4));
      if (want > 0 && day <= today) sellUsd(day, Math.min(book.lowestFrom("checkingUsd", day), want / market.fx(day)));
    }

    /* ---------- APV (December) ---------- */
    if (mo === 12 && year >= APV.from && working) {
      const day = firstBusinessDayOnOrAfter(ymd(month, APV.depositDay));
      if (day <= today) {
        const clp = round(APV.utm * market.utm(month));
        const projected = annualTax(year);
        const regime: "apvA" | "apvB" = projected.marginal > APV.bonusRate ? "apvB" : "apvA";
        ensureClp(day, clp);
        const units = Math.round((clp / market.fundUnit(APV_FUND_SERIES_KEY, day)) * 1e4) / 1e4;
        book.addUnits(regime, units, 4);
        book.transfer(
          { from: "checking", to: regime, date: day, clp, units, flowKind: null, note: `APV ${regime === "apvA" ? "régimen A" : "régimen B"} ${year}` },
          { account: "checking", description: "TRANSF A AGF ANDES APV", side: "from" }
        );
        if (regime === "apvB") yearTax(year).apvB += clp;
        else {
          const bonus = round(Math.min(clp * APV.bonusRate, APV.bonusCapUtm * market.utm(month)));
          apvBonuses.push({ day: firstBusinessDayOnOrAfter(ymd(`${year + 1}-08`, 20)), clp: bonus });
        }
      }
    }
    for (const b of apvBonuses.filter((x) => monthOf(x.day) === month && x.day <= today)) {
      const units = Math.round((b.clp / market.fundUnit(APV_FUND_SERIES_KEY, b.day)) * 1e4) / 1e4;
      book.addUnits("apvA", units, 4);
      book.single({ type: "single", account: "apvA", date: b.day, amount: b.clp, currency: "clp", note: "Bonificación fiscal APV", units, flowKind: "aporte_estatal_clp" });
    }

    /* ---------- AFP fund switch ---------- */
    if (month === AFP_SWITCH_MONTH && !afpSwitched) {
      const { sale, credit } = afpSwitchDays();
      const held = book.unitsOf("afpModelo");
      if (held > 0) {
        const pesos = round(held * market.fundUnit(afpModeloSeries, sale));
        const unoUnits = Math.round((pesos / market.fundUnit(afpUnoSeries, credit)) * 1e4) / 1e4;
        book.direct.push({ type: "transfer", from: "afpModelo", to: "afpUno", date: credit, amount: pesos, currency: "clp", units: held, counterUnits: unoUnits, flowKind: "afp_fund_switch", note: "Traspaso AFP Modelo → UNO" });
        book.addUnits("afpModelo", -held, 4);
        book.addUnits("afpUno", unoUnits, 4);
      }
      afpSwitched = true;
    }

    /* ---------- investing ---------- */
    // Investing runs on payday (the last business day), after the salary lands.
    const brokerDay = lastBusinessDay(month);
    const expenses = expenseByMonth.get(month) ?? 0;
    lastAgeMonthsExpense = [...lastAgeMonthsExpense, expenses].slice(-CASH_BAND.trailingMonths);
    const avgExpense = trailingExpense();
    // Known cash outflows of the next six months (a car paid in cash, the December APV) stay put.
    const reserved = upcomingCashNeeds(month);
    if (brokerDay <= today) {
      const holdForHouse = month >= "2023-11" && month <= HOUSE.month;
      // Dividends (quarterly, net of the 15 % US withholding).
      if (mo % 3 === 0) {
        for (const [ticker, dps] of Object.entries(DIVIDEND_PER_SHARE_USD)) {
          const held = book.unitsOf(`stock:${ticker}`);
          const perShare = ticker === "INTC" && month >= "2024-09" ? 0 : ticker === "INTC" && month >= "2023-03" ? 0.125 : dps;
          const net = cents(held * perShare * 0.85);
          if (net < 0.01) continue;
          // Paid on the 8th: before any play of the month (the book applies events in code order).
          const day = firstBusinessDayOnOrAfter(ymd(month, 8));
          book.transfer({ from: `stock:${ticker}`, to: "brokerUsd", date: day, usd: net, flowKind: "dividend_payout", note: `Dividendo ${ticker}` });
        }
      }
      // Plays this month: deposit what the broker lacks, then trade.
      const playsNow = PLAYS.filter((p) => monthOf(p.date) === month && p.date <= today).map((p) => {
        if (p.kind !== "buy") return p;
        const usdOk = usdFree(p.date) + brokerFree(p.date) >= p.usd;
        const clpNeed = (p.usd - brokerFree(p.date) - usdFree(p.date)) * market.fx(p.date) * 1.02;
        // Not enough pesos yet on the play's day: it waits for payday.
        if (!usdOk && book.lowestFrom("checking", p.date) < clpNeed + 100_000) return { ...p, date: lastBusinessDay(month) };
        return { ...p };
      });
      for (const p of playsNow) {
        if (p.kind === "sell") {
          sellStock(p.date, p.ticker, p.fraction);
          continue;
        }
        // A play is never bigger than what the accounts can spare that day.
        // Plays come out of savings above a 2,5-month cushion (the band's reserves are for the sweep).
        const floorClp = Math.max(400_000, 2.5 * avgExpense);
        const spareUsd =
          brokerFree(p.date) + usdFree(p.date) + Math.max(0, book.lowestFrom("checking", p.date) - floorClp) / (market.fx(p.date) * 1.02);
        if (spareUsd < p.usd) {
          // Short on cash: trim SPY at the broker (up to half the position) for the rest.
          const spyUsd = book.unitsOf("stock:SPY") * market.close("SPY", p.date);
          const fromSpy = Math.min(p.usd - Math.max(0, spareUsd), spyUsd * 0.5);
          if (fromSpy > 50) sellStock(p.date, "SPY", fromSpy / spyUsd);
          const reach = Math.max(0, spareUsd) + Math.max(0, fromSpy);
          if (reach < 200) continue;
          if (reach < p.usd) p.usd = Math.floor(reach / 50) * 50;
        }
        const lack = p.usd - brokerFree(p.date);
        if (lack > 0) {
          const usdPart = Math.min(Math.floor(usdFree(p.date) / 100) * 100, Math.ceil(lack / 100) * 100);
          if (usdPart > 0) depositBrokerUsd(p.date, usdPart);
          const rest = p.usd - brokerFree(p.date);
          if (rest > 0) depositBrokerClp(p.date, (rest + 5) * market.fx(p.date) * 1.01);
        }
        buyStock(p.date, p.ticker, p.usd);
      }
      // The house: the sale's dollars come home to pay the pie.
      if (month === "2024-02") {
        const day = "2024-02-19";
        const usd = Math.floor(brokerFree(day) - 50);
        book.transfer({ from: "brokerUsd", to: "checkingUsd", date: day, usd, flowKind: null, note: "Broker|retiro a cuenta USD" });
        sellUsd(addDays(day, 1), usdFree(addDays(day, 1)) - 500);
      }
      // DCA + Bitcoin.
      const cashNow = totalCashClp(brokerDay);
      const allowDca = cashNow > CASH_BAND.low * avgExpense + reserved && !holdForHouse;
      if (allowDca) {
        if (contract?.id === "job1") depositBrokerClp(brokerDay, DCA.job1Clp);
        if (contract?.id === "job2") depositBrokerClp(brokerDay, DCA.job2Clp);
        if (contractor?.id === "job3") depositBrokerUsd(brokerDay, Math.min(DCA.job3Usd, usdFree(brokerDay)));
        if (contractor?.id === "job4") depositBrokerUsd(brokerDay, Math.min(DCA.job4Usd, usdFree(brokerDay)));
      }
      if (month >= BTC.from && month <= BTC.to && hasChecking) {
        const lump = monthOf(BTC.lump.date) === month ? BTC.lump.clp : 0;
        const clp = BTC.monthlyClp + lump;
        const day = businessDayOnOrBefore(ymd(month, 17));
        if (day <= today) {
          ensureClp(day, clp);
          book.transfer({ from: "checking", to: "exchangeClp", date: day, clp, flowKind: null, note: "Exchange|depósito" }, { account: "checking", description: "TRANSF A CRYPTO EXCHANGE SPA", side: "from" });
          const btcUnits = Math.round((clp / (market.close("BTC-USD", day) * market.fx(day))) * 0.995 * 1e8) / 1e8;
          book.addUnits("btc", btcUnits, 8);
          book.single({ type: "single", account: "exchangeClp", date: day, amount: -clp, currency: "clp", note: "Exchange|compra BTC" });
          book.single({ type: "single", account: "btc", date: day, amount: clp, currency: "clp", note: "Exchange|compra BTC", units: btcUnits, cryptoKind: "buy" });
        }
      }
      // Sweep: cash above the band's top goes to the broker.
      const cashAfter = totalCashClp(brokerDay);
      if (!holdForHouse && working && cashAfter > CASH_BAND.high * avgExpense + reserved) {
        const excess = cashAfter - CASH_BAND.target * avgExpense - reserved;
        if (usdFree(brokerDay) * market.fx(brokerDay) > excess * 0.5 && contractor) {
          depositBrokerUsd(brokerDay, Math.min(usdFree(brokerDay), excess / market.fx(brokerDay)));
        } else {
          const clpRoom = book.bal.checking - avgExpense * 1.5 - reserved;
          if (clpRoom > 200_000) depositBrokerClp(brokerDay, Math.min(clpRoom, excess));
        }
      }
      // Lump sum: broker cash above US$ 2.500 buys SPY.
      if (brokerFree(brokerDay) > 2_500 && !holdForHouse) buyStock(brokerDay, "SPY", Math.floor(brokerFree(brokerDay) - 100));
      else if (brokerFree(brokerDay) >= 20 && !holdForHouse) buyStock(brokerDay, "SPY", Math.floor(brokerFree(brokerDay) * 100) / 100 - 5);
    }
    if (process.env.DEMO_V2_TRACE) {
      console.log(
        `${month} exp=${Math.round(expenses / 1000)}k life=${Math.round(lifestyleReal / 1000)}k vista=${Math.round(book.bal.vista / 1000)}k chk=${Math.round(book.bal.checking / 1000)}k usd=${Math.round(book.bal.checkingUsd)} bClp=${Math.round(book.bal.brokerClp)} bUsd=${Math.round(book.bal.brokerUsd)}`
      );
    }
    months.push({ month, expensesClp: round(expenses), cashClp: round(totalCashClp(ymd(month, daysInMonth(month)) <= today ? ymd(month, daysInMonth(month)) : today)), band: [round(CASH_BAND.low * avgExpense), round(CASH_BAND.high * avgExpense)] });
  }

  /* ---------- the open cycle (lines after the last close) ---------- */
  const openCycle: Ledger["openCycle"] = [];
  for (const card of activeCards(lastMonth)) {
    const st = cards.get(card.key)!;
    const lines = [...st.pendingByClose.values()].flat().filter((l) => l.date <= today);
    const paidClp = st.paid.clp;
    const paidUsd = st.paid.usd;
    const payment =
      paidClp || paidUsd
        ? { clp: paidClp?.amount ?? 0, usd: paidUsd?.amount ?? 0, date: (paidClp ?? paidUsd)!.date, usdViaDivisas: paidUsd?.viaDivisas ?? false }
        : null;
    openCycle.push({ card: card.key, lines, payment });
  }

  return {
    today,
    bank: book.bank,
    direct: book.direct,
    statements,
    openCycle,
    plans,
    payslips,
    contractorPayslips,
    mortgage,
    afcContributions,
    months,
    categoryByCheckingDescription: catByDesc,
    categoryByMerchant: catByMerchant,
  };

  /* ------------------------------ closures ------------------------------ */
  function usdFree(day: Ymd): number {
    return Math.max(0, book.lowestFrom("checkingUsd", day));
  }
  function brokerFree(day: Ymd): number {
    return Math.max(0, book.lowestFrom("brokerUsd", day));
  }
  function upcomingCashNeeds(month: Month, includePlays = true): number {
    let need = 0;
    for (let k = 1; k <= 6; k++) {
      const m = addMonths(month, k);
      for (const c of CARS) if (c.from === m) need += c.priceClp - c.tradeInClp - (c.id === "car1" ? 2_500_000 : 0);
      if (m.endsWith("-12") && Number(m.slice(0, 4)) >= APV.from) need += APV.utm * market.utm(month);
      if (includePlays && k <= 3) for (const p of PLAYS) if (p.kind === "buy" && monthOf(p.date) === m) need += p.usd * market.fx(ymd(month, 1));
      // Moving in: the deposit (garantía) and the first rent.
      for (const h of HOUSING) if (h.kind === "rent" && h.from === m) need += 2.2 * h.rentClp;
      // A month without income (between jobs) is lived on savings.
      if (m >= "2018-04" && !contractJobFor(m) && !contractorJobFor(m)) need += 1.5 * trailingExpense();
    }
    return need;
  }
  function trailingExpense(): number {
    const xs = lastAgeMonthsExpense.length ? lastAgeMonthsExpense : [0];
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }
  function totalCashClp(day: Ymd): number {
    return book.bal.vista + book.bal.checking + book.bal.checkingUsd * market.fx(day);
  }
  /** Before a peso outflow: sell dollars when the peso account would not cover it. */
  function ensureClp(day: Ymd, clp: number) {
    if (day > today) return;
    const avail = book.lowestFrom("checking", day);
    if (avail >= clp + 50_000) return;
    const usdAvail = book.lowestFrom("checkingUsd", day);
    if (usdAvail <= 0) return;
    const need = (clp + 300_000 - avail) / (market.fx(day) * 0.99);
    sellUsd(day, Math.min(usdAvail, Math.ceil(need / 10) * 10));
  }
}
/* ------------------------------- payroll math ------------------------------------ */

function baseFor(job: ContractJob, month: Month): number {
  // A raise every `raiseMonth` once the first year is done.
  let raises = 0;
  for (let m = addMonths(job.from, 1); m <= month; m = addMonths(m, 1)) {
    if (Number(m.slice(5, 7)) === job.raiseMonth && monthsBetween(job.from, m) >= 12) raises += 1;
  }
  return Math.round((job.baseClp * Math.pow(1 + job.yearlyRaise, raises)) / 1000) * 1000;
}

/** Ingreso mínimo mensual by year (for the gratificación cap: 4,75 IMM / 12). */
function imm(year: number): number {
  const t: Record<number, number> = { 2018: 276_000, 2019: 301_000, 2020: 320_500, 2021: 337_000, 2022: 400_000, 2023: 460_000, 2024: 500_000, 2025: 529_000, 2026: 539_000 };
  return t[year] ?? 539_000;
}

export function contractPayslip(job: ContractJob, month: Month, market: MarketReader): ContractPayslip {
  const year = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  const base = baseFor(job, month);
  const grat = Math.min(Math.round(base * 0.25), Math.round((4.75 * imm(year)) / 12));
  const aguinaldo = mo === 9 || mo === 12 ? job.aguinaldoClp : 0;
  const bonus = job.bonusMonth != null && mo === job.bonusMonth && monthsBetween(job.from, month) >= 6 ? base : 0;
  const taxablePay = base + grat + aguinaldo + bonus;
  const ufDay = market.uf(ymd(month, daysInMonth(month)));
  const utm = market.utm(month);
  const caps = capUf(year);
  const taxableBase = Math.min(taxablePay, Math.round(caps.pension * ufDay));
  const afcBase = Math.min(taxablePay, Math.round(caps.afc * ufDay));
  const fund: "modelo" | "uno" = month >= AFP_SWITCH_MONTH ? "uno" : "modelo";
  const pension = Math.round((taxableBase * afpWorkerRate(fund, month)) / 100);
  const health = Math.round(taxableBase * 0.07);
  const afc = Math.round(afcBase * 0.006);
  const tax = iusc(taxablePay - pension - health - afc, utm, year);
  const lines: ContractPayslip["lines"] = [
    { side: "haber", section: "imponible", label: "Sueldo base", amount: base },
    { side: "haber", section: "imponible", label: "Gratificación legal", amount: grat },
  ];
  if (aguinaldo) lines.push({ side: "haber", section: "imponible", label: "Aguinaldo", amount: aguinaldo });
  if (bonus) lines.push({ side: "haber", section: "imponible", label: "Bono", amount: bonus });
  lines.push(
    { side: "haber", section: "no_imponible", label: "Colación", amount: job.mealClp },
    { side: "haber", section: "no_imponible", label: "Movilización", amount: job.transportClp },
    { side: "descuento", section: "legal", label: "AFP", amount: pension },
    { side: "descuento", section: "legal", label: "Cotización salud", amount: health },
    { side: "descuento", section: "legal", label: "Seguro de cesantía", amount: afc },
    { side: "descuento", section: "legal", label: "Impuesto único", amount: tax }
  );
  const net = taxablePay + job.mealClp + job.transportClp - pension - health - afc - tax;
  return {
    job,
    month,
    kind: "salary",
    payDate: lastBusinessDay(month),
    pensionFund: fund,
    lines,
    taxablePay,
    taxableBase,
    pension,
    health,
    afc,
    tax,
    net,
    uf: ufDay,
    utm,
  };
}

function finiquitoPayslip(job: ContractJob, month: Month, market: MarketReader): ContractPayslip {
  const base = baseFor(job, month);
  const vacation = Math.round((base / 30) * 9);
  return {
    job,
    month,
    kind: "severance",
    payDate: lastBusinessDay(month),
    pensionFund: null,
    lines: [{ side: "haber", section: "no_imponible", label: "Indemnización por vacaciones proporcionales", amount: vacation }],
    taxablePay: 0,
    taxableBase: 0,
    pension: 0,
    health: 0,
    afc: 0,
    tax: 0,
    net: vacation,
    uf: market.uf(ymd(month, daysInMonth(month))),
    utm: market.utm(month),
  };
}

/* ------------------------------- mortgage math ----------------------------------- */

/** French schedule in UF (the dividendo is a fixed UF amount). */
export function mortgageCuotaUf(principalUf: number, n: number) {
  const i = HOUSE.monthlyRate;
  const pmtUf = (principalUf * i) / (1 - Math.pow(1 + i, -HOUSE.termMonths));
  const g = Math.pow(1 + i, n - 1);
  const before = principalUf * g - (pmtUf * (g - 1)) / i;
  const interestUf = before * i;
  const amortUf = pmtUf - interestUf;
  return { pmtUf, interestUf, amortUf, balanceAfterUf: before - amortUf };
}
export { MORTGAGE_INCENDIO_CLP, MORTGAGE_DESGRAVAMEN_CLP, BRANCH };
