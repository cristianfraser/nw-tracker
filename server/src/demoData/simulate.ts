/**
 * The life ledger: the person's money, day by day, from the first month through today. Pure apart
 * from reading prices (`MarketReader`): it decides what happened and records it in the shapes the
 * documents are rendered from (`render.ts`) and the writers apply (`apply.ts`). It keeps every
 * balance itself and fails when one would go negative — a demo that overdraws is a story bug.
 */
import {
  AFC_ACCOUNT_RATE_PCT,
  AFC_RATES_PCT,
  afpWorkerRatePct,
  boletaRetentionRate,
  APV_ANNUAL_CAP_UF,
  igcTax,
  INDEPENDENT_OTHER_RATES,
  INDEPENDENT_TAXABLE_SHARE,
  iuscTax,
  LEGAL_HEALTH_RATE,
  MANDATORY_PENSION_RATE,
  monthlyGratificationClp,
  pensionCapUf,
  PRESUMED_EXPENSES_CAP_UTA,
  PRESUMED_EXPENSES_RATE,
  unemploymentCapUf,
} from "../legalParameters.js";
import { dfl2ContribucionesHalvedThroughYear } from "../legalParameters.js";
import { legalHealthClp } from "../payslipLineKinds.js";
import { MORTGAGE_CUOTA_DAY } from "../mortgageCuotaDay.js";
import { afpDisplaySeriesKey } from "../afpUnoSeries.js";
import { ccIssuerBySlug } from "../ccIssuers.js";
import { derivedPayByIso } from "../ccInstallmentPayBy.js";
import { equityQuoteCurrency } from "../equityQuote.js";
import { isChileBusinessDay, isNyseTradingDay, nextChileBusinessDayYmd, priorChileBusinessDayYmd } from "../marketHolidays.js";
import type { MarketReader } from "./market.js";
import {
  addDays,
  addMonths,
  daysInMonth,
  monthOf,
  monthsBetween,
  ymd,
  type CardDef,
  type ContractJob,
  type ContractorJob,
  type House,
  type Month,
  type Person,
  type UsW2Job,
  type Ymd,
} from "./person.js";
import { stream, type Rng } from "./rng.js";
import { newUsPayrollYtd, usPayDates, usPayStub, usW2sFromStubs, type UsPayStub, type UsW2 } from "./usPayroll.js";

/* ----------------------------------- shapes ------------------------------------- */

export type CashAcct = "vista" | "checking" | "checkingUsd" | "usChecking" | "brokerClp" | "brokerUsd" | "ibkrUsd" | "exchangeClp";
/** The cash accounts that hold dollars. */
const USD_CASH: ReadonlySet<CashAcct> = new Set(["checkingUsd", "usChecking", "brokerUsd", "ibkrUsd"]);
/** The broker cash accounts a dollar stock trades against. */
export type UsdBrokerCash = "brokerUsd" | "ibkrUsd";
export type Acct =
  | CashAcct
  | "dap"
  | "btc"
  | "apvA"
  | "apvB"
  | "afpModelo"
  | "afpUno"
  | "afc"
  /** A house's property account and its loan (`House.key`). */
  | `property:${string}`
  | `loan:${string}`
  | "fund"
  /** The US retirement accounts: a 401(k) and an HSA in a target-date fund's units, a Roth IRA in SPY. */
  | "k401"
  | "hsa"
  | "rothIra"
  | `stock:${string}`
  | `card:${CardDef["key"]}`;

/** A line a bank cartola prints (vista and the peso checking account). */
export type BankRow = { account: "vista" | "checking"; date: Ymd; description: string; amount: number };
/** A line the US bank's monthly statement prints (dollars, signed). */
export type UsBankRow = { date: Ymd; description: string; amount: number };

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
      /** The exchange's own record of a crypto trade (`crypto_trade_details`): the quoted price per coin in pesos and its commission. */
      exchangeTrade?: { priceClp: number; feeClp: number };
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
  /** The issuer's own charge (a yearly fee): the statement bills it apart from the purchases. */
  fee?: true;
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

export type MortgageCuota = {
  /** Cuota number, or null for a prepago. */
  n: number | null;
  /** «prepago N» for a prepago. */
  label: string;
  date: Ymd;
  clp: number;
  ufDay: number;
  /** The minimum dividendo (0 on a prepago). */
  pmtUf: number;
  interestUf: number;
  amortUf: number;
  /** Paid above the minimum (the whole prepago). */
  extUf: number;
  balanceAfterUf: number;
};

export type Mortgage = { house: House; cuotas: MortgageCuota[]; pieClp: number; principalUf: number; pieDate: Ymd };
/** A rent credited to checking: the bank prints `description` on `date` for `clp`. */
export type RentCredit = { house: string; date: Ymd; clp: number; description: string };
/** A place's bill paid from checking; a DFL-2 property's contribuciones say whether they were halved. */
export type PlaceBill = { house: string; kind: "gastos_comunes" | "contribuciones"; date: Ymd; clp: number; description: string; halved?: boolean };

export type Ledger = {
  person: Person;
  today: Ymd;
  bank: BankRow[];
  direct: DirectMovement[];
  statements: CardStatement[];
  /** Card lines dated after the last close (the open cycle the feed lists). */
  openCycle: { card: CardDef["key"]; lines: CardLine[]; payment: { clp: number; usd: number; date: Ymd; usdViaDivisas: boolean } | null }[];
  plans: InstallmentPlan[];
  payslips: ContractPayslip[];
  contractorPayslips: ContractorPayslip[];
  /** The US W-2 job's pay stubs, and each year's W-2 from them. */
  usPayslips: UsPayStub[];
  usW2s: UsW2[];
  /** The US checking account's statement lines, and its balance today (statement rows and transfers). */
  usBank: UsBankRow[];
  usCheckingBalanceUsd: number;
  /** Each house's mortgage, in purchase order. */
  mortgages: Mortgage[];
  /** The rents the agency forwarded to checking (the income overrides name the place). */
  rents: RentCredit[];
  /** The places' bills paid from checking (the real-estate page's bill rows). */
  placeBills: PlaceBill[];
  /** AFC book account: contributions (the writer grows and marks it). */
  afcContributions: { date: Ymd; clp: number; month: Month }[];
  /** Month-end summary, for the build report and the invariants. */
  months: { month: Month; expensesClp: number; cashClp: number; band: [number, number] }[];
  /** Names the category rules need (description / merchant → category slug). */
  categoryByCheckingDescription: Map<string, string>;
  categoryByMerchant: Map<string, string>;
  /** The US statement descriptions' categories. */
  categoryByUsDescription: Map<string, string>;
  /** The boletas de honorarios issued (internships: the payer withholds; contractor: the issuer pays in F29). */
  feeReceipts: FeeReceipt[];
  /** APV régimen B deposits (the AFP's DJ 1899). */
  apvBDeposits: { date: Ymd; clp: number }[];
  /** The term deposits, in order (the bank's DJ 1890 reports their real interest). */
  termDeposits: TermDeposit[];
  /**
   * Each income year's April settlement (positive paid, negative refunded) and the pension
   * contributions on fees the SII charged inside it (code 900).
   */
  aprilSettlements: Map<number, { clp: number; contributionsClp: number }>;
};

/** A peso term deposit (DAP): opened from checking, paid back to it with the interest at maturity. */
export type TermDeposit = { open: Ymd; maturity: Ymd; principal: number; payout: number; paid: boolean };

export type FeeReceipt = { issuedOn: Ymd; payer: string; grossClp: number; retentionClp: number; retainedBy: "payer" | "issuer" };

export type SimulateOptions = {
  /**
   * The April settlement of each income year (code 305 plus the contributions charged), as the tax
   * module computed it on a previous pass; a year not listed takes the simulator's own estimate.
   */
  aprilSettlements?: ReadonlyMap<number, number>;
};

/* --------------------------------- constants ------------------------------------ */

const BRANCH = "Oficina Central";
export const APV_FUND_SERIES_KEY = "demo_apv_fondo";
/**
 * The US retirement accounts' fund: a 2060 target-date fund (≈ 90 % equities), valued daily in
 * dollars (the 401(k) and the HSA hold its units).
 */
export const US_RETIREMENT_FUND_SERIES_KEY = "demo_us_target_2060";

/** US discretionary spend shares by category (the debit card, Austin). */
const US_CATEGORY_WEIGHTS: Record<string, number> = {
  supermarket: 0.3,
  food: 0.24,
  transportation: 0.12,
  fun: 0.1,
  clothes: 0.07,
  others: 0.12,
  healthcare: 0.05,
};
/** US merchants with a typical ticket (dollars at the move). */
const US_MERCHANTS: Record<string, { name: string; ticket: number }[]> = {
  supermarket: [
    { name: "HEB AUSTIN TX", ticket: 62 },
    { name: "WHOLE FOODS MARKET AUSTIN", ticket: 48 },
    { name: "TRADER JOE'S AUSTIN TX", ticket: 41 },
    { name: "COSTCO WHSE AUSTIN", ticket: 135 },
  ],
  food: [
    { name: "STARBUCKS AUSTIN TX", ticket: 7 },
    { name: "TORCHYS TACOS AUSTIN", ticket: 18 },
    { name: "UBER EATS", ticket: 31 },
    { name: "FRANKLIN BARBECUE AUSTIN", ticket: 46 },
    { name: "CHUYS AUSTIN TX", ticket: 38 },
  ],
  transportation: [
    { name: "SHELL OIL AUSTIN TX", ticket: 44 },
    { name: "EXXONMOBIL AUSTIN TX", ticket: 41 },
    { name: "TXTAG TOLLS", ticket: 16 },
    { name: "UBER TRIP", ticket: 19 },
  ],
  fun: [
    { name: "ALAMO DRAFTHOUSE", ticket: 26 },
    { name: "ACL LIVE MOODY THEATER", ticket: 74 },
    { name: "BARTON SPRINGS POOL", ticket: 9 },
  ],
  clothes: [
    { name: "TARGET AUSTIN TX", ticket: 39 },
    { name: "UNIQLO AUSTIN", ticket: 55 },
    { name: "REI AUSTIN", ticket: 88 },
  ],
  others: [
    { name: "AMAZON.COM", ticket: 36 },
    { name: "HOME DEPOT AUSTIN", ticket: 52 },
    { name: "GREAT CLIPS AUSTIN", ticket: 24 },
  ],
  healthcare: [
    { name: "CVS PHARMACY AUSTIN", ticket: 21 },
    { name: "WALGREENS AUSTIN TX", ticket: 18 },
  ],
};

/** The US card's yearly fee as its statement prints it (a section-3 charge: the card's cost). */
export const US_CARD_ANNUAL_FEE = "ANNUAL MEMBERSHIP FEE";

/** The mutual fund's valor cuota series (a person with `fund`). */
export const MUTUAL_FUND_SERIES_KEY = "demo_fondo";

/** The 15 % US tax the Chilean broker withholds from dividends (W-8BEN, no treaty). */
export const DIVIDEND_WITHHOLDING_RATE = 0.15;

/**
 * The story's short-term dollar rate (≈ the T-bill yield), from each year on until the next entry:
 * SGOV's distributions and the US broker's interest.
 */
const USD_YIELD_PCT_FROM_YEAR: readonly [number, number][] = [
  [2024, 5.2],
  [2025, 4.3],
  [2026, 3.8],
];
/** The US broker pays the benchmark rate less this on idle dollars. */
const IBKR_SWEEP_SPREAD_PCT = 0.5;
function usdYieldPct(year: number): number {
  const hit = [...USD_YIELD_PCT_FROM_YEAR].reverse().find(([from]) => year >= from);
  if (!hit) throw new Error(`demo: no dollar short rate for ${year}`);
  return hit[1];
}

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
const CARD_SUBSCRIPTIONS: { merchant: string; category: string; clp: number; from: Month; to?: Month; card?: CardDef["key"]; keptAbroad?: true }[] = [
  { merchant: "SPOTIFY", category: "subscriptions", clp: 5_000, from: "2018-05" },
  { merchant: "NETFLIX.COM", category: "subscriptions", clp: 6_500, from: "2018-05" },
  { merchant: "ENTEL PLAN MOVIL", category: "bills", clp: 14_000, from: "2018-05", keptAbroad: true },
  { merchant: "SMARTFIT", category: "hobbies", clp: 16_000, from: "2018-07" },
  { merchant: "DISNEY PLUS", category: "subscriptions", clp: 5_500, from: "2021-01", card: "second", keptAbroad: true },
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

/** Close date of `card` in `month`. */
export function cardClose(card: CardDef, month: Month): Ymd {
  return ymd(month, card.closeDay);
}
/** The issuer's pay-by for a close: the app's derived rule (`CC_ISSUERS`), which the statements print. */
export function cardPayBy(card: CardDef, close: Ymd): Ymd {
  const issuer = ccIssuerBySlug(card.issuer);
  if (!issuer) throw new Error(`demo: unknown card issuer ${card.issuer}`);
  const payBy = derivedPayByIso(close, issuer.derived_pay_by);
  if (!payBy) throw new Error(`demo: no pay-by for the close ${close}`);
  return payBy;
}


/** The 10 % pension withdrawals: at least this many UF (all of a smaller balance), at most the cap. */
const AFP_WITHDRAWAL_FLOOR_UF = 35;
const AFP_WITHDRAWAL_CAP_UF = 150;

/**
 * The story's 30-day peso term-deposit rate (%), from each month on: low in 2021, high with the
 * 2022 policy rate, easing in 2023.
 */
const DAP_RATE_PCT_30D_FROM: readonly [Month, number][] = [
  ["2021-01", 0.12],
  ["2021-08", 0.3],
  ["2021-11", 0.55],
  ["2022-03", 0.8],
  ["2022-08", 0.95],
  ["2023-06", 0.85],
  ["2023-09", 0.7],
];
function dapRate30dPct(day: Ymd): number {
  const hit = [...DAP_RATE_PCT_30D_FROM].reverse().find(([from]) => monthOf(day) >= from);
  if (!hit) throw new Error(`demo: no term-deposit rate for ${day}`);
  return hit[1];
}

/** When the AFP switch credits UNO (Modelo until then). */
export const AFP_SWITCH_MONTH: Month = "2020-02";

/* ------------------------------------ book -------------------------------------- */

class Book {
  bal: Record<CashAcct, number> = { vista: 0, checking: 0, checkingUsd: 0, usChecking: 0, brokerClp: 0, brokerUsd: 0, ibkrUsd: 0, exchangeClp: 0 };
  units = new Map<string, number>();
  bank: BankRow[] = [];
  usBank: UsBankRow[] = [];
  direct: DirectMovement[] = [];

  /** Daily deltas of every cash account, so balances are checked in calendar order. */
  private daily: Record<CashAcct, Map<Ymd, number>> = {
    vista: new Map(),
    checking: new Map(),
    checkingUsd: new Map(),
    usChecking: new Map(),
    brokerClp: new Map(),
    brokerUsd: new Map(),
    ibkrUsd: new Map(),
    exchangeClp: new Map(),
  };

  private add(acct: CashAcct, amount: number, day: Ymd) {
    const usd = USD_CASH.has(acct);
    this.bal[acct] = usd ? cents(this.bal[acct] + amount) : this.bal[acct] + amount;
    const m = this.daily[acct];
    m.set(day, (m.get(day) ?? 0) + amount);
    if (amount < 0) {
      const low = this.lowestFrom(acct, day);
      if (low < (usd ? -0.005 : -0.5)) throw new Error(`demo: ${acct} would go negative on or after ${day} (${low}; this row ${amount})`);
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
  /** A line of the US bank's statement with no counterpart in the ledger (salary, rent, a purchase). */
  usBankRow(date: Ymd, description: string, usd: number) {
    usd = cents(usd);
    if (usd === 0) return;
    this.add("usChecking", usd, date);
    this.usBank.push({ date, description, amount: usd });
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
      const isUsd = USD_CASH.has(a);
      const v = isUsd ? usd : clp;
      if (v == null) throw new Error(`demo: transfer ${t.note} needs a ${isUsd ? "USD" : "CLP"} leg for ${a}`);
      this.add(a, sign * v, t.date);
    };
    cashLeg(t.from, -1);
    cashLeg(t.to, 1);
    // Selling dollars (a USD account sends, a peso account receives): the dollars are the from-leg.
    const usdSale = clp != null && usd != null && isCash(t.from) && USD_CASH.has(t.from);
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

function isCash(a: Acct): a is CashAcct {
  return ["vista", "checking", "checkingUsd", "usChecking", "brokerClp", "brokerUsd", "ibkrUsd", "exchangeClp"].includes(a);
}

/* -------------------------------- simulation ------------------------------------ */

type CardCycleState = {
  /** Purchases dated in [periodFrom, close) of each future close, by close date. */
  pendingByClose: Map<Ymd, CardLine[]>;
  prevFacturado: { clp: number; usd: number };
  paid: { clp: { amount: number; date: Ymd } | null; usd: { amount: number; date: Ymd; viaDivisas: boolean } | null };
};

export function simulate(person: Person, market: MarketReader, today: Ymd, options: SimulateOptions = {}): Ledger {
  const settlementOverrides = options.aprilSettlements ?? new Map<number, number>();
  const {
    seed: SEED,
    firstMonth: FIRST_MONTH,
    realBaseMonth: REAL_BASE_MONTH,
    dadName: DAD_NAME,
    allowance: ALLOWANCE,
    internships: INTERNSHIPS,
    contractJobs: CONTRACT_JOBS,
    contractorJobs: CONTRACTOR_JOBS,
    housing: HOUSING,
    houses: HOUSES,
    cars: CARS,
    oneOffs: ONE_OFFS,
    cards: CARDS,
    plays: PLAYS,
    dividendPerShareUsd: DIVIDEND_PER_SHARE_USD,
    btc: BTC,
    cashBand: CASH_BAND,
    apv: APV,
    dap: DAP,
  } = person;
  const contractJobFor = (month: Month): ContractJob | null => CONTRACT_JOBS.find((j) => month >= j.from && month <= j.to) ?? null;
  const contractorJobFor = (month: Month): ContractorJob | null =>
    CONTRACTOR_JOBS.find((j) => month >= j.from && (j.to == null || month <= j.to)) ?? null;
  const usJobFor = (month: Month): UsW2Job | null => person.usJobs.find((j) => month >= j.from && (j.to == null || month <= j.to)) ?? null;
  const US = person.us;
  /** Living in the US: the Chilean lifestyle has stopped. */
  const abroad = (month: Month) => US != null && month >= US.moveMonth;
  const housingFor = (month: Month) => {
    const h = [...HOUSING].reverse().find((x) => month >= x.from);
    if (!h) throw new Error(`demo: no housing for ${month}`);
    return h;
  };
  const carFor = (month: Month) => CARS.find((c) => month >= c.from && (c.to == null || month <= c.to)) ?? null;
  /** The Chilean cards open in `month` (the US card is the US chapter's: `usCard`). */
  const activeCards = (month: Month): CardDef[] => CARDS.filter((c) => month >= c.from && c.issuer !== "lonestar");
  const usCard = CARDS.find((c) => c.issuer === "lonestar") ?? null;
  const usCardOpen = (month: Month) => usCard != null && month >= usCard.from;
  const lenderMerchants = new Set(HOUSES.map((h) => h.lender.merchant));
  const housesOwned = (month: Month) => HOUSES.filter((h) => month >= h.month);
  const hasCheckingOn = (day: Ymd) => monthOf(day) >= person.checkingFrom;
  const book = new Book();
  const lastMonth = monthOf(today);
  const plans: InstallmentPlan[] = [];
  const statements: CardStatement[] = [];
  const payslips: ContractPayslip[] = [];
  const contractorPayslips: ContractorPayslip[] = [];
  const afcContributions: Ledger["afcContributions"] = [];
  const feeReceipts: FeeReceipt[] = [];
  const apvBDeposits: Ledger["apvBDeposits"] = [];
  const aprilSettlements: Ledger["aprilSettlements"] = new Map();
  const months: Ledger["months"] = [];
  const usPayslips: UsPayStub[] = [];
  const catByUsDesc = new Map<string, string>();
  const usExpenseByMonth = new Map<Month, number>();
  const usPayDatesByJob = new Map(person.usJobs.map((j) => [j.id, usPayDates(j, today)]));
  const usYtdByJob = new Map(person.usJobs.map((j) => [j.id, newUsPayrollYtd()]));
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

  const ufBase = market.uf(`${REAL_BASE_MONTH}-01`);
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
  /**
   * The close whose cycle a purchase on `day` belongs to: a purchase on the close day bills next,
   * except at an issuer whose next cycle starts the day after the close (the US card).
   */
  const closeForPurchase = (card: CardDef, day: Ymd): Ymd => {
    const m = monthOf(day);
    const c = cardClose(card, m);
    const closeDayBillsThis = card.issuer === "lonestar";
    return day < c || (closeDayBillsThis && day === c) ? c : cardClose(card, addMonths(m, 1));
  };
  const cardPurchase = (line: CardLine) => {
    if (line.date > today) return;
    const card = cardOf(line.card);
    if (monthOf(line.date) < card.from) throw new Error(`demo: ${line.merchant} on card ${card.key} before it opens`);
    // A mortgage's card line is split by the app itself (carrying cost vs amortización).
    if (!lenderMerchants.has(line.merchant)) catByMerchant.set(line.merchant, line.category);
    const st = cards.get(line.card)!;
    const close = closeForPurchase(card, line.date);
    const list = st.pendingByClose.get(close) ?? [];
    list.push(line);
    st.pendingByClose.set(close, list);
    // The US card's spending is the US chapter's (its band, its wire), never the Chilean months'.
    if (card.issuer === "lonestar") {
      if (line.currency !== "usd") throw new Error(`demo: ${line.merchant} in pesos on the US card`);
      const m = monthOf(line.date);
      usExpenseByMonth.set(m, cents((usExpenseByMonth.get(m) ?? 0) + line.amount));
    } else addExpense(line.date, line.currency === "usd" ? line.amount * market.fx(line.date) : line.amount);
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
  // The lifestyle scale: 175k real pesos a month at a student's 250k income, concave in income.
  const LIFESTYLE_BASE_INCOME = 250_000;
  let smoothedIncomeReal = ALLOWANCE?.clp ?? LIFESTYLE_BASE_INCOME;
  const targetFor = (incomeReal: number) => 175_000 * Math.pow(Math.max(incomeReal, 150_000) / LIFESTYLE_BASE_INCOME, 0.52);
  let lifestyleReal = ALLOWANCE ? 175_000 : targetFor(firstMonthIncomeReal());

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
  const independentContributions = (y: number, t: YearTax = yearTax(y)) => {
    if (!t.independent || t.honorariosGross <= 0) return { base: 0, total: 0, pension: 0, healthAndAfp: 0 };
    const capClp = pensionCapUf(y) * 12 * market.uf(`${y}-12-31`);
    const base = Math.min(INDEPENDENT_TAXABLE_SHARE * t.honorariosGross, capClp);
    const pension = round(base * MANDATORY_PENSION_RATE);
    const afpTotal = round((base * afpWorkerRatePct("uno", `${y}-12`)) / 100);
    const health = round(base * LEGAL_HEALTH_RATE);
    const other = round(base * (INDEPENDENT_OTHER_RATES.sis + INDEPENDENT_OTHER_RATES.workAccidents + INDEPENDENT_OTHER_RATES.sanna));
    return { base, total: afpTotal + health + other, pension, healthAndAfp: afpTotal + health };
  };
  const annualTax = (y: number, t: YearTax = yearTax(y)) => {
    const uta = 12 * market.utm(`${y}-12`);
    const presumed = Math.min(PRESUMED_EXPENSES_RATE * t.honorariosGross, PRESUMED_EXPENSES_CAP_UTA * uta);
    const contrib = independentContributions(y, t);
    const base = t.contractTaxable + t.honorariosGross - presumed - contrib.healthAndAfp - t.apvB;
    const igc = igcTax(base, uta, y + 1);
    const credits = t.iuscWithheld + Math.max(0, t.honorariosRetention - contrib.total);
    return { base, igc, uta, result: round(igc - credits) };
  };
  /** A whole year's taxable income as the jobs will pay it (for a decision taken before December). */
  const projectedYearTax = (y: number): YearTax => {
    const t: YearTax = { contractTaxable: 0, iuscWithheld: 0, honorariosGross: 0, honorariosRetention: 0, apvB: 0, independent: false };
    for (let m: Month = `${y}-01`; m <= `${y}-12`; m = addMonths(m, 1)) {
      const c = contractJobFor(m);
      if (c) {
        const ps = contractPayslip(c, m, market);
        t.contractTaxable += ps.taxablePay - ps.pension - ps.health - ps.afc;
      }
      const k = contractorJobFor(m);
      if (k) {
        t.honorariosGross += round(k.monthlyUsd * market.fx(lastBusinessDay(m)));
        t.independent = true;
      }
    }
    t.apvB = yearTax(y).apvB;
    return t;
  };
  /**
   * The APV regime that pays more for `depositClp` in year `y`: B when the tax it saves (the IGC on
   * the base with and without it) beats A's bonus (15 %, at most `bonusCapUtm` UTM a year less what
   * the year's A deposits already earned).
   */
  const apvRegimeFor = (y: number, t: YearTax, depositClp: number, utmClp: number): "apvA" | "apvB" => {
    const { base, uta } = annualTax(y, t);
    const savedByB = igcTax(base, uta, y + 1) - igcTax(Math.max(0, base - depositClp), uta, y + 1);
    const bonusLeft = Math.max(0, APV.bonusCapUtm * utmClp - (apvBonusByYear.get(y) ?? 0));
    const bonusA = Math.min(depositClp * APV.bonusRate, bonusLeft);
    return savedByB > bonusA ? "apvB" : "apvA";
  };

  /* ---------------------------------- AFP ----------------------------------- */
  const afpModeloSeries = afpDisplaySeriesKey("modelo", "A");
  const afpUnoSeries = afpDisplaySeriesKey("uno", "A");
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
  /** The state bonus each year's régimen A deposits earned (capped per year). */
  const apvBonusByYear = new Map<number, number>();
  /** UF deposited in APV each year (the 600 UF cap of régimen B). */
  const apvUfByYear = new Map<number, number>();
  /** The regime of the year's monthly deposits, decided at the first one. */
  const apvMonthlyRegime = new Map<number, "apvA" | "apvB">();
  const apvMonthlyIn = (m: Month) => APV.monthly != null && m >= APV.monthly.from && m <= APV.monthly.to;
  /** One APV deposit from checking into régimen A or B. */
  const apvDeposit = (day: Ymd, clp: number, regime: "apvA" | "apvB", year: number, note: string) => {
    // A dollar earner sells dollars for it, keeping two months of spending in pesos after it.
    ensureClp(day, clp + (contractorJobFor(monthOf(day)) ? 2 * trailingExpense() : 0));
    const units = Math.round((clp / market.fundUnit(APV_FUND_SERIES_KEY, day)) * 1e4) / 1e4;
    book.addUnits(regime, units, 4);
    book.transfer(
      { from: "checking", to: regime, date: day, clp, units, flowKind: null, note },
      { account: "checking", description: "TRANSF A AGF ANDES APV", side: "from" }
    );
    apvUfByYear.set(year, (apvUfByYear.get(year) ?? 0) + clp / market.uf(day));
    if (regime === "apvB") {
      yearTax(year).apvB += clp;
      apvBDeposits.push({ date: day, clp });
    } else {
      const utmClp = market.utm(monthOf(day));
      const bonus = round(Math.min(clp * APV.bonusRate, Math.max(0, APV.bonusCapUtm * utmClp - (apvBonusByYear.get(year) ?? 0))));
      if (bonus > 0) {
        apvBonusByYear.set(year, (apvBonusByYear.get(year) ?? 0) + bonus);
        apvBonuses.push({ day: firstBusinessDayOnOrAfter(ymd(`${year + 1}-08`, 20)), clp: bonus });
      }
    }
  };

  /* ------------------------------ broker helpers ----------------------------- */
  /** Shares of a ticker held at each broker's cash account (one stock account holds every broker's shares). */
  const heldAt = new Map<string, number>();
  const heldUnits = (ticker: string, cash: CashAcct) => heldAt.get(`${ticker}|${cash}`) ?? 0;
  const addHeld = (ticker: string, cash: CashAcct, units: number) => {
    heldAt.set(`${ticker}|${cash}`, Math.round((heldUnits(ticker, cash) + units) * 1e6) / 1e6);
    book.addUnits(`stock:${ticker}`, units, 6);
  };
  /** The price a share held on `day` traded at: the split-adjusted close × the splits after `day`. */
  const heldClose = (ticker: string, day: Ymd) =>
    person.splits.filter((x) => x.ticker === ticker && x.exDate > day).reduce((f, x) => f * (x.numerator / x.denominator), market.close(ticker, day));
  const brokerLabel = (cash: CashAcct) => (cash === "ibkrUsd" ? "IBKR" : "Broker");
  const buyStock = (day: Ymd, ticker: string, usd: number, cash: UsdBrokerCash = "brokerUsd") => {
    usd = cents(usd);
    if (usd <= 0) return;
    const units = Math.round((usd / heldClose(ticker, day)) * 1e6) / 1e6;
    addHeld(ticker, cash, units);
    book.transfer({ from: cash, to: `stock:${ticker}`, date: day, usd, units, flowKind: "stock_buy", note: `${brokerLabel(cash)}|compra ${ticker}` });
  };
  const sellStock = (day: Ymd, ticker: string, fraction: number, cash: UsdBrokerCash = "brokerUsd"): number => {
    const units = Math.round(heldUnits(ticker, cash) * fraction * 1e6) / 1e6;
    if (units <= 0) return 0;
    const usd = cents(units * heldClose(ticker, day));
    addHeld(ticker, cash, -units);
    book.transfer({ from: `stock:${ticker}`, to: cash, date: day, usd, units, flowKind: "stock_sell", note: `${brokerLabel(cash)}|venta ${ticker}` });
    return usd;
  };
  /** A peso-quoted (Santiago) ticker: pesos from checking to the broker's peso cash, then the buy. */
  const buyStockClp = (day: Ymd, ticker: string, clp: number) => {
    clp = round(clp / 1000) * 1000;
    ensureClp(day, clp + 100_000);
    book.transfer({ from: "checking", to: "brokerClp", date: day, clp, flowKind: null, note: "Broker|depósito" }, { account: "checking", description: "TRANSF A BROKER DEMO SPA", side: "from" });
    const units = Math.round((clp / heldClose(ticker, day)) * 1e4) / 1e4;
    addHeld(ticker, "brokerClp", units);
    book.transfer({ from: "brokerClp", to: `stock:${ticker}`, date: day, clp, units, flowKind: "stock_buy", note: `Broker|compra ${ticker}` });
  };
  /** A peso-quoted sale: the pesos land at the broker and come home to checking the next business day. */
  const sellStockClp = (day: Ymd, ticker: string, fraction: number) => {
    const units = Math.round(heldUnits(ticker, "brokerClp") * fraction * 1e4) / 1e4;
    if (units <= 0) return;
    const clp = round(units * heldClose(ticker, day));
    addHeld(ticker, "brokerClp", -units);
    book.transfer({ from: `stock:${ticker}`, to: "brokerClp", date: day, clp, units, flowKind: "stock_sell", note: `Broker|venta ${ticker}` });
    const home = nextChileBusinessDayYmd(day)!;
    if (home <= today) {
      book.transfer({ from: "brokerClp", to: "checking", date: home, clp, flowKind: null, note: "Broker|retiro" }, { account: "checking", description: "TRANSF. DE BROKER DEMO SPA", side: "to" });
    }
  };
  const isClpTicker = (ticker: string) => equityQuoteCurrency(ticker) === "clp";
  /** CLP deposited to the broker and converted to dollars the same day. */
  const depositBrokerClp = (day: Ymd, clp: number) => {
    clp = round(clp / 1000) * 1000;
    if (clp <= 0) return;
    book.transfer({ from: "checking", to: "brokerClp", date: day, clp, flowKind: null, note: "Broker|depósito" }, { account: "checking", description: "TRANSF A BROKER DEMO SPA", side: "from" });
    const usd = cents((clp / market.fx(day)) * 0.995);
    book.transfer({ from: "brokerClp", to: "brokerUsd", date: day, clp, usd, flowKind: "compra_usd_venta_clp", note: "Broker|compra de dólares" });
  };
  const depositBrokerUsd = (day: Ymd, usd: number, cash: UsdBrokerCash = "brokerUsd") => {
    usd = cents(Math.floor(usd / 100) * 100);
    if (usd <= 0) return;
    book.transfer({ from: "checkingUsd", to: cash, date: day, usd, flowKind: null, note: `${brokerLabel(cash)}|depósito USD` });
  };
  /** Where new dollars are invested this month: the second broker once it opens. */
  const ibkrOpen = (m: Month) => person.ibkr != null && m >= person.ibkr.from;
  const dollarBroker = (m: Month): UsdBrokerCash => (ibkrOpen(m) ? "ibkrUsd" : "brokerUsd");
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
  const mortgages = new Map<string, Mortgage>();
  const rents: RentCredit[] = [];
  const placeBills: PlaceBill[] = [];

  /* ------------------------------ term deposits ------------------------------ */
  const termDeposits: TermDeposit[] = [];
  /**
   * The month's term-deposit events. A deposit maturing this month pays principal + interest back to
   * checking, and the same day the payout plus a top-up (at most `topUpClp`) is placed again — less
   * when checking cannot spare it, keeping two and a half months of spending and the known needs of the
   * next months (a car, a move); with no deposit running, payday opens one. Nothing is placed that
   * would mature after the window, or under a million. Amounts round down to the half million so a
   * small change elsewhere (an April settlement) does not change them. While the deposits hold the
   * savings the cash band is lower, so the broker DCA pauses: he is saving the pie.
   */
  const runTermDeposits = (month: Month) => {
    const cfg = DAP!;
    const cushion = () => Math.max(2_000_000, 2.5 * trailingExpense());
    // Pesos plus the dollars a dollar earner would sell for it, less the cushion and the known needs.
    const available = (day: Ymd) =>
      book.lowestFrom("checking", day) +
      Math.max(0, book.lowestFrom("checkingUsd", day)) * market.fx(day) * 0.99 -
      cushion() -
      upcomingCashNeeds(month);
    const halfMillions = (clp: number) => Math.floor(clp / 500_000) * 500_000;
    const place = (day: Ymd, wanted: number, note: string) => {
      const maturity = firstBusinessDayOnOrAfter(addDays(day, cfg.termDays));
      if (monthOf(maturity) > cfg.to || wanted < 1_000_000) return;
      ensureClp(day, wanted + cushion());
      const principal = halfMillions(Math.min(wanted, book.lowestFrom("checking", day) - cushion()));
      if (principal < 1_000_000) return;
      const days = (Date.parse(maturity) - Date.parse(day)) / 86_400_000;
      const payout = round(principal * (1 + (dapRate30dPct(day) / 100) * (days / 30)));
      book.transfer(
        { from: "checking", to: "dap", date: day, clp: principal, flowKind: null, note },
        { account: "checking", description: "INVERSION DEPOSITO A PLAZO", side: "from" }
      );
      termDeposits.push({ open: day, maturity, principal, payout, paid: false });
    };
    const cur = termDeposits.at(-1);
    if (cur && !cur.paid) {
      if (monthOf(cur.maturity) !== month || cur.maturity > today) return;
      const day = cur.maturity;
      book.transfer(
        { from: "dap", to: "checking", date: day, clp: cur.payout, flowKind: null, note: "Vencimiento depósito a plazo" },
        { account: "checking", description: "VENCIMIENTO DEPOSITO A PLAZO", side: "to" }
      );
      cur.paid = true;
      place(day, halfMillions(Math.min(cur.payout + cfg.topUpClp, available(day))), "Renovación depósito a plazo");
      return;
    }
    if (month < cfg.from || month > cfg.to) return;
    const day = lastBusinessDay(month);
    if (day > today) return;
    place(day, halfMillions(Math.min(cfg.openingClp, available(day))), "Depósito a plazo");
  };

  /* --------------------------------- months ---------------------------------- */
  let lastAgeMonthsExpense: number[] = [];
  for (let month = FIRST_MONTH; month <= lastMonth; month = addMonths(month, 1)) {
    const r = (label: string): Rng => stream(SEED, `${month}|${label}`);
    const year = Number(month.slice(0, 4));
    const mo = Number(month.slice(5, 7));
    const contract = contractJobFor(month);
    const contractor = contractorJobFor(month);
    const housing = housingFor(month);
    const car = carFor(month);
    const usJob = usJobFor(month);
    const working = contract != null || contractor != null || usJob != null;
    const hasChecking = month >= person.checkingFrom;

    for (const d of deferred.filter((x) => monthOf(x.day) === month).sort((a, b) => a.day.localeCompare(b.day))) d.run();
    // A split multiplies every broker's shares from its ex-date (the stored closes are already
    // adjusted; `heldClose` prices the shares as traded).
    for (const sp of person.splits) {
      if (monthOf(sp.exDate) !== month || sp.exDate > today) continue;
      const ratio = sp.numerator / sp.denominator;
      for (const [key, units] of [...heldAt]) {
        if (!key.startsWith(`${sp.ticker}|`) || units === 0) continue;
        heldAt.set(key, Math.round(units * ratio * 1e6) / 1e6);
      }
      book.addUnits(`stock:${sp.ticker}`, book.unitsOf(`stock:${sp.ticker}`) * (ratio - 1), 6);
    }
    // The first account opens with what he had saved.
    if (month === FIRST_MONTH) book.bankRow(person.opening.account, ymd(month, 1), "DEPOSITO EN EFECTIVO", person.opening.clp);
    // Opening the checking account after the vista: the vista's savings move over.
    if (month === person.checkingFrom && month > FIRST_MONTH) {
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
    if (ALLOWANCE && month >= ALLOWANCE.from && month <= ALLOWANCE.to) {
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
      const issued = lastBusinessDay(month);
      if (issued <= today) feeReceipts.push({ issuedOn: issued, payer: it.employer, grossClp: it.grossClp, retentionClp: it.grossClp - net, retainedBy: "payer" });
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
        afpCredit(credit, round(ps.taxableBase * MANDATORY_PENSION_RATE), [month], `Cotización obligatoria ${month}`);
        if (credit <= today) afcContributions.push({ date: credit, clp: round((ps.taxableBase * AFC_ACCOUNT_RATE_PCT) / 100), month });
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
        feeReceipts.push({ issuedOn: wire, payer: contractor.employer, grossClp, retentionClp: ret, retainedBy: "issuer" });
        // The retention goes to the SII with the next F29 (by the 12th).
        const f29 = businessDayOnOrBefore(ymd(addMonths(monthOf(wire), 1), 12));
        if (f29 <= today) pendingF29.push({ day: f29, clp: ret });
      }
      incomeNominal += contractor.monthlyUsd * market.fx(ymd(month, 15)) * 0.83;
    }
    for (const p of pendingF29.filter((x) => monthOf(x.day) === month)) {
      ensureClp(p.day, p.clp);
      bankBill("checking", p.day, "PAGO IMPUESTOS F29 SII", "taxes", p.clp);
    }

    // Operación renta: April pays or May refunds the previous year.
    // The amount is the tax module's (code 305 + the contributions charged) once a previous pass
    // computed it; the simulator's own estimate only seeds the first pass.
    if (mo === 4 && (taxYears.has(year - 1) || settlementOverrides.has(year - 1))) {
      const indep = independentContributions(year - 1);
      const retention = taxYears.get(year - 1)?.honorariosRetention ?? 0;
      const contributionsClp = Math.min(indep.total, retention);
      const result = settlementOverrides.get(year - 1) ?? annualTax(year - 1).result;
      aprilSettlements.set(year - 1, { clp: result, contributionsClp });
      if (result > 0) {
        const day = businessDayOnOrBefore(ymd(month, 28));
        if (day <= today) {
          ensureClp(day, result);
          bankBill("checking", day, "PAGO F22 TGR", "taxes", result);
        }
      } else if (result < 0) {
        const day = firstBusinessDayOnOrAfter(ymd(addMonths(month, 1), 14));
        if (day <= today) book.bankRow(hasChecking ? "checking" : "vista", day, "DEVOLUCION IMPUESTO TGR", -result);
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
      if (hasChecking) bankBill("checking", ymd(month, 5), "TRANSF APORTE GASTOS CASA", "others", round(nominal(housing.aporteClp, ymd(month, 5)) / 1000) * 1000);
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
    }
    // Every property he owns: the building's gastos comunes and the contribuciones, paid by the owner
    // whether he lives there or rents it out (a DFL-2 property's contribuciones halved while it lasts).
    for (const h of housesOwned(month)) {
      const gcDay = ymd(month, h.key === HOUSES[0]?.key ? 10 : 12);
      const gc = round(nominal(h.gcClp, gcDay) * r(`gc|${h.key}`).jitter(1, 0.08));
      if (gcDay <= today) {
        bankBill("checking", gcDay, h.gcDescription, "bills", gc);
        placeBills.push({ house: h.key, kind: "gastos_comunes", date: gcDay, clp: gc, description: h.gcDescription });
      }
      if (h.contribucionesMonths.includes(mo) && month > h.month) {
        const day = ymd(month, h.key === HOUSES[0]?.key ? 20 : 21);
        const halved = h.dfl2 != null && year <= dfl2ContribucionesHalvedThroughYear(h.dfl2.builtM2, h.dfl2.receptionYear);
        const clp = round(nominal(h.contribucionesClp, day) * (halved ? 0.5 : 1));
        if (day <= today) {
          bankBill("checking", day, h.contribucionesDescription, "bills", clp);
          placeBills.push({ house: h.key, kind: "contribuciones", date: day, clp, description: h.contribucionesDescription, halved });
        }
      }
    }
    // Abroad, the Chilean home's utilities stop once it is no longer lived in (two months after the move).
    if (housing.kind !== "parents" && !(US != null && month >= addMonths(US.moveMonth, 2))) {
      const winter = mo >= 6 && mo <= 8;
      bankBill("checking", ymd(month, 14), "PAGO EN LINEA ENEL", "bills", round(nominal(24_000 * (winter ? 1.3 : 1), ymd(month, 14)) * r("enel").jitter(1, 0.15)));
      bankBill("checking", ymd(month, 16), "PAGO EN LINEA METROGAS", "bills", round(nominal(14_000 * (winter ? 2.2 : 1), ymd(month, 16)) * r("gas").jitter(1, 0.2)));
      bankBill("checking", ymd(month, 17), "PAGO EN LINEA AGUAS ANDINAS", "bills", round(nominal(9_000, ymd(month, 17)) * r("agua").jitter(1, 0.15)));
      bankBill("checking", ymd(month, 18), "PAGO EN LINEA VTR", "bills", round(nominal(21_000, ymd(month, 18))));
    }

    /* ---------- the houses ---------- */
    for (const h of HOUSES) {
      if (h.dadGift && month === monthOf(h.dadGift.date) && h.dadGift.date <= today) {
        book.bankRow("checking", h.dadGift.date, `TRANSF. DE ${DAD_NAME}`, h.dadGift.clp);
      }
      if (month === h.month && h.pieDate <= today) {
        const pieClp = round(h.pieUf * market.uf(h.pieDate));
        ensureClp(h.pieDate, pieClp);
        catByDesc.set(h.pieDescription, "deposits");
        book.bankRow("checking", h.pieDate, h.pieDescription, -pieClp);
        const gastos = round(h.gastosOperacionalesUf * market.uf(h.gastosDate));
        ensureClp(h.gastosDate, gastos);
        bankBill("checking", h.gastosDate, "TRANSF NOTARIA Y CBR GASTOS OPERACIONALES", "others", gastos);
        mortgages.set(h.key, { house: h, cuotas: [], pieClp, principalUf: h.valueUf - h.pieUf, pieDate: h.pieDate });
      }
      const mortgage = mortgages.get(h.key);
      if (mortgage && month > h.month) {
        const day = ymd(month, MORTGAGE_CUOTA_DAY);
        if (day <= today) {
          const n = mortgage.cuotas.filter((c) => c.n != null).length + 1;
          const balanceUf = mortgageBalanceUf(mortgage);
          const s = mortgageCuotaUf(h, balanceUf, h.termMonths - (n - 1));
          const extUf = Math.min(h.monthlyExtraUf, s.balanceAfterUf);
          const ufDay = market.uf(day);
          const clp = round((s.pmtUf + extUf) * ufDay) + h.lender.incendioClp + h.lender.desgravamenClp;
          mortgage.cuotas.push({ n, label: String(n), date: day, clp, ufDay, ...s, extUf, balanceAfterUf: s.balanceAfterUf - extUf });
          cardPurchase({ card: "main", date: day, merchant: h.lender.merchant, category: "bills", currency: "clp", amount: clp });
        }
        for (const pp of h.prepayments) {
          if (monthOf(pp.date) !== month || pp.date > today) continue;
          const ufDay = market.uf(pp.date);
          const balanceUf = mortgageBalanceUf(mortgage);
          const extUf = Math.min(pp.uf, balanceUf);
          const clp = round(extUf * ufDay);
          ensureClp(pp.date, clp);
          catByDesc.set(h.lender.prepagoDescription, "deposits");
          book.bankRow("checking", pp.date, h.lender.prepagoDescription, -clp);
          const k = mortgage.cuotas.filter((c) => c.n == null).length + 1;
          mortgage.cuotas.push({ n: null, label: `prepago ${k}`, date: pp.date, clp, ufDay, pmtUf: 0, interestUf: 0, amortUf: 0, extUf, balanceAfterUf: balanceUf - extUf });
        }
      }
      // Renting it out: the agency forwards the rent whole and charges its commission the same day;
      // each lease year starts at the UF of its anniversary, and every later anniversary month is a
      // vacancy (no rent, no commission).
      const rental = h.rental;
      if (rental && month >= rental.from) {
        const leaseYear = Math.floor(monthsBetween(rental.from, month) / 12);
        const vacant = leaseYear >= 1 && monthsBetween(rental.from, month) % 12 === 0;
        const day = firstBusinessDayOnOrAfter(ymd(month, rental.creditDay));
        if (!vacant && day <= today) {
          const anniversary = addMonths(rental.from, leaseYear * 12);
          const rent = round((rental.rentClp * market.uf(ymd(anniversary, 1))) / market.uf(ymd(rental.from, 1)) / 1000) * 1000;
          const description = `TRANSF. DE ${rental.agency}`;
          book.bankRow("checking", day, description, rent);
          rents.push({ house: h.key, date: day, clp: rent, description });
          bankBill("checking", day, `PAGO COMISION ADMINISTRACION ${rental.agency}`, "bills", round(rent * rental.feeRate));
        }
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
    if (!abroad(month)) {
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
      for (const s of USD_SUBSCRIPTIONS) {
        if (month < s.from || (s.to && month > s.to)) continue;
        if (!cardsNow.some((c) => c.key === s.card)) continue;
        cardPurchase({ card: s.card, date: ymd(month, 2 + (s.merchant.length % 24)), merchant: s.merchant, category: "subscriptions", currency: "usd", amount: s.usd });
      }
      if (cardsNow.length > 0 && rr.chance(0.45)) {
        const day = ymd(month, rr.int(2, 27));
        cardPurchase({ card: cardsNow.length > 1 ? "second" : "main", date: day, merchant: "AMAZON.COM", category: "others", currency: "usd", amount: cents(rr.range(25, 140) * Math.pow(lifestyleReal / 300_000, 0.4)) });
      }
      if (cardsNow.length === 0 && month > FIRST_MONTH) bankBill(hasChecking ? "checking" : "vista", ymd(month, 4), "COMPRA NAC SPOTIFY", "subscriptions", round(nominal(4_000, ymd(month, 4))));
    }
    // Peso subscriptions on the Chilean cards (abroad only the ones he keeps: his Chilean phone line,
    // the family's streaming plan — they keep each card billing every month).
    {
      const cardsNow = activeCards(month);
      for (const s of CARD_SUBSCRIPTIONS) {
        if (month < s.from || (s.to && month > s.to)) continue;
        if (abroad(month) && !s.keptAbroad) continue;
        const card = s.card && cardsNow.some((c) => c.key === s.card) ? s.card : "main";
        if (!cardsNow.some((c) => c.key === card)) continue;
        const day = ymd(month, 3 + (s.merchant.length % 20));
        cardPurchase({ card, date: day, merchant: s.merchant, category: s.category, currency: "clp", amount: round(nominal(s.clp, day) / 10) * 10 });
      }
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
      payPreviousStatements(card, month);
      closeCycle(card, month);
    }

    /* ---------- the US chapter (after the month's Chilean card payments: the wire covers them) ---------- */
    // The US card's autopay runs before the month's US spending; its close after it (the spending
    // dated before the close is on the statement).
    if (usCard && usCardOpen(month)) payPreviousStatements(usCard, month);
    if (US) runUsMonth(month, r);
    if (usCard && usCardOpen(month)) closeCycle(usCard, month);

    /* ---------- contractor dollars → pesos ---------- */
    if (book.bal.checkingUsd > 0) {
      // Keep about two months of peso outflows in pesos.
      const avg = trailingExpense();
      const want = Math.max(0, avg * 2 - book.bal.checking);
      const day = firstBusinessDayOnOrAfter(ymd(month, 4));
      if (want > 0 && day <= today) sellUsd(day, Math.min(book.lowestFrom("checkingUsd", day), want / market.fx(day)));
    }

    /* ---------- APV (monthly in the window, else December) ---------- */
    if (apvMonthlyIn(month) && working) {
      const day = firstBusinessDayOnOrAfter(ymd(month, APV.depositDay));
      const ufLeft = APV_ANNUAL_CAP_UF - (apvUfByYear.get(year) ?? 0);
      const uf = Math.min(APV.monthly!.uf, ufLeft);
      if (day <= today && uf > 0.5) {
        const clp = Math.floor((uf * market.uf(day)) / 1000) * 1000;
        let regime = apvMonthlyRegime.get(year);
        if (!regime) {
          // Decided once for the year, on the year's income and every monthly deposit it will hold.
          let planned = 0;
          for (let m: Month = month; m <= `${year}-12`; m = addMonths(m, 1)) if (apvMonthlyIn(m)) planned += APV.monthly!.uf;
          const plannedClp = Math.min(planned, ufLeft) * market.uf(day);
          regime = apvRegimeFor(year, projectedYearTax(year), plannedClp, market.utm(month));
          apvMonthlyRegime.set(year, regime);
        }
        apvDeposit(day, clp, regime, year, `APV ${regime === "apvA" ? "régimen A" : "régimen B"} ${month}`);
      }
    }
    if (mo === 12 && year >= APV.from && working && !apvMonthlyRegime.has(year)) {
      const day = firstBusinessDayOnOrAfter(ymd(month, APV.depositDay));
      if (day <= today) {
        const clp = round(APV.utm * market.utm(month));
        const regime = apvRegimeFor(year, yearTax(year), clp, market.utm(month));
        apvDeposit(day, clp, regime, year, `APV ${regime === "apvA" ? "régimen A" : "régimen B"} ${year}`);
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

    /* ---------- pension withdrawals (the 10 % laws) ---------- */
    for (const w of person.afpWithdrawals) {
      if (monthOf(w) !== month) continue;
      const day = firstBusinessDayOnOrAfter(w);
      if (day > today) continue;
      if (day < afpSwitchDays().credit) throw new Error(`demo: AFP withdrawal on ${day} before the move to UNO`);
      const held = book.unitsOf("afpUno");
      const px = market.fundUnit(afpUnoSeries, day);
      const uf = market.uf(day);
      const balance = held * px;
      // 10 % of the balance, at least 35 UF and at most 150 UF; the whole balance under 35 UF.
      const all = balance < AFP_WITHDRAWAL_FLOOR_UF * uf;
      const clp = all ? round(balance) : round(Math.min(Math.max(0.1 * balance, AFP_WITHDRAWAL_FLOOR_UF * uf), AFP_WITHDRAWAL_CAP_UF * uf));
      const units = all ? held : Math.round((clp / px) * 1e4) / 1e4;
      const k = person.afpWithdrawals.indexOf(w) + 1;
      book.addUnits("afpUno", -units, 4);
      book.transfer(
        { from: "afpUno", to: "checking", date: day, clp, units, flowKind: null, note: `Retiro de fondos AFP ${k}` },
        { account: "checking", description: "TRANSF. DE AFP UNO RETIRO DE FONDOS", side: "to" }
      );
    }

    /* ---------- term deposits ---------- */
    if (DAP) runTermDeposits(month);

    /* ---------- investing ---------- */
    // Investing runs on payday (the last business day), after the salary lands.
    const brokerDay = lastBusinessDay(month);
    const expenses = expenseByMonth.get(month) ?? 0;
    lastAgeMonthsExpense = [...lastAgeMonthsExpense, expenses].slice(-CASH_BAND.trailingMonths);
    const avgExpense = trailingExpense();
    // Known cash outflows of the next six months (a car paid in cash, the December APV) stay put.
    const reserved = upcomingCashNeeds(month);
    if (brokerDay <= today) {
      const holdForHouse = HOUSES.some((h) => month >= h.holdFromMonth && month <= h.month);
      // Dividends (quarterly): the Chilean broker withholds the 15 % US tax (W-8BEN), the US one
      // nothing (W-9).
      if (mo % 3 === 0) {
        for (const [ticker, dps] of Object.entries(DIVIDEND_PER_SHARE_USD)) {
          for (const cash of ["brokerUsd", "ibkrUsd"] as const) {
            const held = heldUnits(ticker, cash);
            const perShare = ticker === "INTC" && month >= "2024-09" ? 0 : ticker === "INTC" && month >= "2023-03" ? 0.125 : dps;
            const net = cents(held * perShare * (cash === "brokerUsd" ? 1 - DIVIDEND_WITHHOLDING_RATE : 1));
            if (net < 0.01) continue;
            // Paid on the 8th: before any play of the month (the book applies events in code order).
            const day = firstBusinessDayOnOrAfter(ymd(month, 8));
            book.transfer({ from: `stock:${ticker}`, to: cash, date: day, usd: net, flowKind: "dividend_payout", note: `Dividendo ${ticker}` });
          }
        }
      }
      // SGOV pays its T-bill interest monthly (a distribution, no withholding at the US broker).
      if (ibkrOpen(month)) {
        const held = heldUnits("SGOV", "ibkrUsd");
        const day = firstBusinessDayOnOrAfter(ymd(month, 5));
        const net = cents(held * market.close("SGOV", day) * (usdYieldPct(year) / 100 / 12));
        if (net >= 0.01) book.transfer({ from: "stock:SGOV", to: "ibkrUsd", date: day, usd: net, flowKind: "dividend_payout", note: "Dividendo SGOV" });
      }
      // The US broker pays interest on the month's idle dollars (posted on payday).
      if (ibkrOpen(month) && month > person.ibkr!.from) {
        const idle = Math.max(0, book.lowestFrom("ibkrUsd", ymd(month, 1)));
        const interest = cents((idle * (usdYieldPct(year) - IBKR_SWEEP_SPREAD_PCT)) / 100 / 12);
        if (interest >= 0.01) {
          book.single({ type: "single", account: "ibkrUsd", date: brokerDay, amount: interest, currency: "usd", note: "IBKR|intereses", flowKind: "savings_earnings" });
        }
      }
      // Plays this month: deposit what the broker lacks, then trade.
      const playsNow = PLAYS.filter((p) => monthOf(p.date) === month && p.date <= today).map((p) => {
        if (p.kind !== "buy" || abroad(month)) return { ...p };
        const usdOk = usdFree(p.date) + brokerFree(p.date) >= p.usd;
        const clpNeed = (p.usd - brokerFree(p.date) - usdFree(p.date)) * market.fx(p.date) * 1.02;
        // Not enough pesos yet on the play's day: it waits for payday.
        if (!usdOk && book.lowestFrom("checking", p.date) < clpNeed + 100_000) return { ...p, date: lastBusinessDay(month) };
        return { ...p };
      });
      for (const p of playsNow) {
        if (person.splits.some((x) => x.ticker === p.ticker && monthOf(x.exDate) === month)) {
          throw new Error(`demo: play ${p.kind} ${p.ticker} on ${p.date} falls in the month of its split`);
        }
        if (p.kind === "sell") {
          if (isClpTicker(p.ticker)) sellStockClp(p.date, p.ticker, p.fraction);
          // A dollar ticker is sold wherever he holds it (the plays move to the US broker abroad).
          else for (const cash of ["brokerUsd", "ibkrUsd"] as const) if (heldUnits(p.ticker, cash) > 0) sellStock(p.date, p.ticker, p.fraction, cash);
          continue;
        }
        if (p.kind === "buy" && abroad(month)) {
          // Living in the US he trades at the US broker: its idle dollars first, the rest from US checking.
          if (!ibkrOpen(month)) throw new Error(`demo: play ${p.ticker} on ${p.date} abroad before the US broker opens`);
          const ibkrFree = Math.max(0, book.lowestFrom("ibkrUsd", p.date));
          const usFree = Math.max(0, book.lowestFrom("usChecking", p.date) - US!.cashBand.low * usTrailingExpense());
          const reach = Math.floor((ibkrFree + usFree) / 50) * 50;
          const usd = Math.min(p.usd, reach);
          if (usd < 200) continue;
          const lack = Math.ceil((usd - ibkrFree) / 100) * 100;
          if (lack > 0) book.transfer({ from: "usChecking", to: "ibkrUsd", date: p.date, usd: lack, flowKind: null, note: "IBKR|depósito USD (ACH)" });
          buyStock(p.date, p.ticker, usd, "ibkrUsd");
          continue;
        }
        if (p.kind === "buy_clp") {
          if (!isClpTicker(p.ticker)) throw new Error(`demo: ${p.ticker} is not quoted in pesos`);
          buyStockClp(p.date, p.ticker, p.clp);
          continue;
        }
        // A play is never bigger than what the accounts can spare that day.
        // Plays come out of savings above a 2,5-month cushion (the band's reserves are for the sweep).
        const floorClp = Math.max(400_000, 2.5 * avgExpense);
        const spareUsd =
          brokerFree(p.date) + usdFree(p.date) + Math.max(0, book.lowestFrom("checking", p.date) - floorClp) / (market.fx(p.date) * 1.02);
        if (spareUsd < p.usd) {
          // Short on cash: trim SPY at the broker (up to half the position) for the rest.
          const spyUsd = heldUnits("SPY", "brokerUsd") * heldClose("SPY", p.date);
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
      // A house's pie: the broker's dollars come home (pesos the next day).
      for (const h of HOUSES) {
        const f = h.brokerFunding;
        if (month !== monthOf(f.date) || f.date > today) continue;
        const day = f.date;
        let usd: number;
        if (f.mode === "free") {
          usd = Math.floor(brokerFree(day) - 50);
        } else {
          // What checking lacks for the pie, the purchase costs, a cushion and the next months' known needs.
          const fx = market.fx(day);
          const needClp =
            h.pieUf * market.uf(h.pieDate) +
            h.gastosOperacionalesUf * market.uf(h.gastosDate) +
            Math.max(2_000_000, 2.5 * trailingExpense()) +
            upcomingCashNeeds(month) -
            Math.max(0, book.lowestFrom("checking", day));
          usd = Math.ceil(needClp / (fx * 0.99) / 100) * 100;
          if (usd <= 0) continue;
          const lack = usd - brokerFree(day);
          if (lack > 0) {
            const spy = heldUnits("SPY", "brokerUsd") * heldClose("SPY", day);
            if (spy < lack + 20) throw new Error(`demo: the ${h.key} pie needs US$${Math.round(lack)} of SPY, the broker holds US$${Math.round(spy)}`);
            sellStock(day, "SPY", (lack + 20) / spy);
          }
        }
        book.transfer({ from: "brokerUsd", to: "checkingUsd", date: day, usd, flowKind: null, note: "Broker|retiro a cuenta USD" });
        sellUsd(addDays(day, 1), usdFree(addDays(day, 1)) - (f.mode === "free" ? 500 : 0));
      }
      // DCA + Bitcoin.
      const cashNow = totalCashClp(brokerDay);
      const allowDca = cashNow > CASH_BAND.low * avgExpense + reserved && !holdForHouse;
      if (allowDca) {
        if (contract) depositBrokerClp(brokerDay, contract.dcaClp);
        if (contractor) depositBrokerUsd(brokerDay, Math.min(contractor.dcaUsd, usdFree(brokerDay)), dollarBroker(month));
      }
      if (BTC && month >= BTC.from && month <= BTC.to && hasChecking) {
        const lump = BTC.lump && monthOf(BTC.lump.date) === month ? BTC.lump.clp : 0;
        const clp = BTC.monthlyClp + lump;
        const day = businessDayOnOrBefore(ymd(month, 17));
        if (day <= today) {
          ensureClp(day, clp);
          book.transfer({ from: "checking", to: "exchangeClp", date: day, clp, flowKind: null, note: "Exchange|depósito" }, { account: "checking", description: "TRANSF A CRYPTO EXCHANGE SPA", side: "from" });
          // The exchange quotes the day's price and keeps 0,5 % of the pesos as its commission.
          const priceClp = market.close("BTC-USD", day) * market.fx(day);
          const btcUnits = Math.round((clp / priceClp) * 0.995 * 1e8) / 1e8;
          const feeClp = Math.max(0, Math.round(clp - priceClp * btcUnits));
          book.addUnits("btc", btcUnits, 8);
          book.single({ type: "single", account: "exchangeClp", date: day, amount: -clp, currency: "clp", note: "Exchange|compra BTC" });
          book.single({
            type: "single",
            account: "btc",
            date: day,
            amount: clp,
            currency: "clp",
            note: "Exchange|compra BTC",
            units: btcUnits,
            cryptoKind: "buy",
            exchangeTrade: { priceClp, feeClp },
          });
        }
      }
      // The mutual fund: a fixed monthly deposit buys cuotas at the day's value.
      if (person.fund && month >= person.fund.from && allowDca) {
        const clp = person.fund.monthlyClp;
        const units = Math.round((clp / market.fundUnit(MUTUAL_FUND_SERIES_KEY, brokerDay)) * 1e4) / 1e4;
        book.addUnits("fund", units, 4);
        book.transfer(
          { from: "checking", to: "fund", date: brokerDay, clp, units, flowKind: null, note: `${person.fund.name}|aporte` },
          { account: "checking", description: "TRANSF A FINTUAL AGF", side: "from" }
        );
      }
      // Sweep: cash above the band's top goes to the broker.
      const cashAfter = totalCashClp(brokerDay);
      if (!holdForHouse && (contract != null || contractor != null) && cashAfter > CASH_BAND.high * avgExpense + reserved) {
        const excess = cashAfter - CASH_BAND.target * avgExpense - reserved;
        if (usdFree(brokerDay) * market.fx(brokerDay) > excess * 0.5 && contractor) {
          depositBrokerUsd(brokerDay, Math.min(usdFree(brokerDay), excess / market.fx(brokerDay)), dollarBroker(month));
        } else {
          const clpRoom = book.bal.checking - avgExpense * 1.5 - reserved;
          if (clpRoom > 200_000) depositBrokerClp(brokerDay, Math.min(clpRoom, excess));
        }
      }
      // Lump sum: broker cash above US$ 2.500 buys SPY.
      if (brokerFree(brokerDay) > 2_500 && !holdForHouse) buyStock(brokerDay, "SPY", Math.floor(brokerFree(brokerDay) - 100));
      else if (brokerFree(brokerDay) >= 20 && !holdForHouse) buyStock(brokerDay, "SPY", Math.floor(brokerFree(brokerDay) * 100) / 100 - 5);
      // The US broker: dollars above the idle cushion fill the SGOV reserve (half of each month's
      // money) and buy SPY.
      if (ibkrOpen(month)) {
        const free = Math.max(0, book.lowestFrom("ibkrUsd", brokerDay));
        const invest = Math.floor(free - person.ibkr!.idleUsd);
        if (invest >= 100) {
          const reserveGap = person.ibkr!.sgovReserveUsd - heldUnits("SGOV", "ibkrUsd") * heldClose("SGOV", brokerDay);
          const toSgov = reserveGap > 0 ? Math.floor(Math.min(reserveGap, invest * 0.5)) : 0;
          if (toSgov >= 100) buyStock(brokerDay, "SGOV", toSgov, "ibkrUsd");
          if (invest - toSgov >= 100) buyStock(brokerDay, "SPY", invest - toSgov, "ibkrUsd");
        }
      }
    }
    if (process.env.DEMO_V2_TRACE) {
      console.log(
        `${month} exp=${Math.round(expenses / 1000)}k life=${Math.round(lifestyleReal / 1000)}k vista=${Math.round(book.bal.vista / 1000)}k chk=${Math.round(book.bal.checking / 1000)}k usd=${Math.round(book.bal.checkingUsd)} bClp=${Math.round(book.bal.brokerClp)} bUsd=${Math.round(book.bal.brokerUsd)} us=${Math.round(book.bal.usChecking)} ibkr=${Math.round(book.bal.ibkrUsd)}`
      );
    }
    months.push({ month, expensesClp: round(expenses), cashClp: round(totalCashClp(ymd(month, daysInMonth(month)) <= today ? ymd(month, daysInMonth(month)) : today)), band: [round(CASH_BAND.low * avgExpense), round(CASH_BAND.high * avgExpense)] });
  }

  if (DAP && `${DAP.from}-28` < today && termDeposits.length === 0) throw new Error("demo: the term-deposit window passed without a deposit");

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
    person,
    today,
    bank: book.bank,
    direct: book.direct,
    statements,
    openCycle,
    plans,
    payslips,
    contractorPayslips,
    usPayslips,
    usW2s: usW2sFromStubs(usPayslips),
    usBank: book.usBank,
    usCheckingBalanceUsd: book.bal.usChecking,
    mortgages: [...mortgages.values()],
    rents,
    placeBills,
    afcContributions,
    months,
    categoryByCheckingDescription: catByDesc,
    categoryByMerchant: catByMerchant,
    categoryByUsDescription: catByUsDesc,
    feeReceipts,
    apvBDeposits,
    termDeposits,
    aprilSettlements,
  };

  /* ------------------------------ closures ------------------------------ */
  /**
   * Pays last month's statements of `card` (their pay-by falls in this month, before this close):
   * pesos from checking; dollars from the dollar account when it holds them, else bought from the
   * peso account; the US card by autopay from US checking on its due date.
   */
  function payPreviousStatements(card: CardDef, month: Month): void {
    const st = cards.get(card.key)!;
    const prev = statements.filter((s) => s.card === card.key && monthOf(s.close) === addMonths(month, -1));
    for (const s of prev) {
      if (s.facturado <= 0) continue;
      if (card.issuer === "lonestar") {
        let payDay = s.payBy;
        while (!isNyseTradingDay(payDay)) payDay = addDays(payDay, -1);
        if (payDay > today) continue;
        book.transfer({ from: "usChecking", to: `card:${card.key}`, date: payDay, usd: s.facturado, flowKind: "pago_tarjeta", note: `Autopay ${card.displayName}` });
        st.paid.usd = { amount: s.facturado, date: payDay, viaDivisas: false };
        continue;
      }
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
  }
  /** Closes `card`'s cycle of `month`: one statement per currency it carries (the US card: dollars). */
  function closeCycle(card: CardDef, month: Month): void {
    const st = cards.get(card.key)!;
    const close = cardClose(card, month);
    if (close > today) return;
    // The US card's yearly fee, billed in the cycle of the month it opened.
    if (card.annualFeeUsd && month > card.from && Number(month.slice(5, 7)) === Number(card.from.slice(5, 7))) {
      const day = addDays(close, -1);
      catByMerchant.set(US_CARD_ANNUAL_FEE, "bills");
      const list = st.pendingByClose.get(close) ?? [];
      list.push({ card: card.key, date: day, merchant: US_CARD_ANNUAL_FEE, category: "bills", currency: "usd", amount: card.annualFeeUsd, fee: true });
      st.pendingByClose.set(close, list);
      usExpenseByMonth.set(month, cents((usExpenseByMonth.get(month) ?? 0) + card.annualFeeUsd));
    }
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
      if (card.issuer === "lonestar" && currency === "clp") {
        if (ls.length + cs.length > 0) throw new Error(`demo: peso lines on the US card ${card.last4}`);
        continue;
      }
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
        payBy: cardPayBy(card, close),
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
  /**
   * What the US card will take from US checking that the book does not hold yet: the purchases not
   * billed (inside the month's US chapter the cycle closing this month is still open, and last
   * month's statement is already paid).
   */
  function usCardOwedUsd(month: Month): number {
    if (!usCard || !usCardOpen(month)) return 0;
    return cents([...cards.get(usCard.key)!.pendingByClose.values()].flat().reduce((a, l) => a + l.amount, 0));
  }

  /**
   * One month of the US chapter. Before the move only the seed (dollars the Chilean broker sends
   * to the new US account); from the move: the biweekly pay (its stubs, the net credited to US
   * checking, the 401(k) and HSA contributions bought on the pay date), the rent, the dollar
   * lifestyle (debit), the car, the Roth IRA, a December flight home, the monthly wire to Chile
   * that keeps the Chilean accounts funded, and the US cash above its band to the US broker.
   */
  function runUsMonth(month: Month, r: (label: string) => Rng): void {
    const us = US!;
    const mo = Number(month.slice(5, 7));
    const year = Number(month.slice(0, 4));
    if (monthOf(us.seed.date) === month && us.seed.date <= today) {
      const day = us.seed.date;
      const need = us.seed.usd - brokerFree(day);
      if (need > 0) {
        const spy = heldUnits("SPY", "brokerUsd") * heldClose("SPY", day);
        if (spy < need + 50) throw new Error(`demo: the broker holds US$${Math.round(spy)} of SPY, the move needs US$${Math.round(need)}`);
        sellStock(day, "SPY", (need + 50) / spy);
      }
      book.transfer({ from: "brokerUsd", to: "usChecking", date: day, usd: us.seed.usd, flowKind: null, note: "Broker|retiro a cuenta en EE.UU." });
    }
    if (month < us.moveMonth) return;
    /** A debit; a one-off (the car, the deposit, a flight) stays out of the running average the band reads. */
    const usBill = (day: Ymd, desc: string, category: string, usd: number, oneOff = false) => {
      if (day > today) return;
      usd = cents(usd);
      if (usd <= 0) return;
      catByUsDesc.set(desc, category);
      book.usBankRow(day, desc, -usd);
      if (!oneOff) usExpenseByMonth.set(month, cents((usExpenseByMonth.get(month) ?? 0) + usd));
    };
    /** A purchase: on the US card once it is open (the debit card before), a one-off kept out of the band's average. */
    const usSpend = (day: Ymd, desc: string, category: string, usd: number, oneOff = false) => {
      if (!usCard || !usCardOpen(month)) return usBill(day, desc, category, usd, oneOff);
      if (day > today) return;
      usd = cents(usd);
      if (usd <= 0) return;
      cardPurchase({ card: usCard.key, date: day, merchant: desc, category, currency: "usd", amount: usd });
      if (oneOff) usExpenseByMonth.set(month, cents((usExpenseByMonth.get(month) ?? 0) - usd));
    };
    const usBusinessDayOnOrAfter = (d: Ymd) => {
      let x = d;
      while (!isNyseTradingDay(x)) x = addDays(x, 1);
      return x;
    };
    const grown = (usd: number, day: Ymd) => usd * Math.pow(1 + us.inflation, monthsBetween(us.moveMonth, monthOf(day)) / 12);

    /* pay */
    for (const job of person.usJobs) {
      for (const date of usPayDatesByJob.get(job.id)!) {
        if (monthOf(date.paid) !== month || date.paid > today) continue;
        const stub = usPayStub(job, date, usYtdByJob.get(job.id)!);
        usPayslips.push(stub);
        book.usBankRow(date.paid, job.bankName, stub.net);
        const fundBuy = (account: "k401" | "hsa", usd: number, note: string) => {
          if (usd <= 0) return;
          const units = Math.round((usd / market.fundUnit(US_RETIREMENT_FUND_SERIES_KEY, date.paid)) * 1e4) / 1e4;
          book.addUnits(account, units, 4);
          book.single({ type: "single", account, date: date.paid, amount: cents(usd), currency: "usd", note, units });
        };
        fundBuy("k401", stub.k401 + stub.match, `401(k) ${job.employer} — employee deferral + employer match`);
        fundBuy("hsa", stub.hsa, `HSA ${job.employer} — payroll contribution`);
      }
    }

    /* home */
    const rentYears = Math.floor(monthsBetween(us.rent.fromMonth, month) / 12);
    const rent = Math.round((us.rent.usd * Math.pow(1 + us.rent.yearlyIncrease, rentYears)) / 5) * 5;
    if (month === us.rent.fromMonth) usBill(ymd(month, 1), `${us.rent.landlord} SECURITY DEPOSIT`, "bills", us.rent.usd, true);
    usBill(ymd(month, 1), `${us.rent.landlord} ACH RENT`, "bills", rent);
    const summer = mo >= 6 && mo <= 9;
    const winter = mo === 12 || mo <= 2;
    const rr = r("us");
    usBill(ymd(month, 12), "AUSTIN ENERGY UTILITY", "bills", grown(88 * (summer ? 1.7 : 1), ymd(month, 12)) * rr.jitter(1, 0.12));
    usBill(ymd(month, 14), "TEXAS GAS SERVICE", "bills", grown(28 * (winter ? 1.9 : 1), ymd(month, 14)) * rr.jitter(1, 0.15));
    usBill(ymd(month, 16), "GOOGLE FIBER", "bills", 70);
    usBill(ymd(month, 18), "T-MOBILE AUTOPAY", "bills", 65);
    usSpend(ymd(month, 3), "LIFETIME FITNESS", "hobbies", grown(89, ymd(month, 3)));
    for (const [desc, usd, day] of [
      ["NETFLIX.COM", 15.49, 6],
      ["SPOTIFY USA", 11.99, 9],
      ["APPLE.COM/BILL", 2.99, 11],
      ["OPENAI *CHATGPT SUBSCR", 20, 13],
      ["GITHUB, INC.", 4, 15],
      ["NOTION LABS", 8, 17],
    ] as const) {
      usSpend(ymd(month, day), desc, "subscriptions", usd);
    }

    /* the car */
    if (us.car) {
      if (month === monthOf(us.car.date)) usBill(us.car.date, us.car.merchant, "transportation", us.car.usd, true);
      if (month > monthOf(us.car.date)) usSpend(ymd(month, 8), "GEICO AUTO INSURANCE", "transportation", grown(132, ymd(month, 8)));
      if (month > monthOf(us.car.date) && mo === Number(us.car.date.slice(5, 7))) usSpend(ymd(month, 20), "TX DMV REGISTRATION", "transportation", 78.25);
    }

    /* variable spending (debit card): the month's budget at the average ticket */
    const fixed = 88 + 28 + 70 + 65 + 89 + 62.47 + (us.car && month > monthOf(us.car.date) ? 132 : 0);
    const budget = grown(us.monthlyUsd - fixed, ymd(month, 15)) * (rr.chance(0.15) ? rr.range(1.3, 1.6) : rr.range(0.88, 1.12));
    for (const [cat, w] of Object.entries(US_CATEGORY_WEIGHTS)) {
      if (cat === "transportation" && !(us.car && month >= monthOf(us.car.date))) continue;
      const pool = US_MERCHANTS[cat]!;
      const mean = pool.reduce((a, m) => a + m.ticket, 0) / pool.length;
      const count = Math.floor((budget * w * (mo === 12 && (cat === "others" || cat === "clothes") ? 1.8 : 1)) / mean + rr.next());
      for (let k = 0; k < count; k++) {
        const m = rr.pick(pool);
        usSpend(ymd(month, rr.int(1, daysInMonth(month))), m.name, cat, Math.max(3, grown(m.ticket, ymd(month, 15)) * rr.jitter(1, 0.45)));
      }
    }
    if (mo === 12) usSpend(ymd(month, 5), "UNITED AIRLINES", "fun", grown(us.decemberTripUsd, ymd(month, 5)), true);

    /* the Roth IRA: the year's contribution, bought straight into SPY */
    if (us.roth && mo === us.roth.month && year >= us.roth.fromYear) {
      const day = usBusinessDayOnOrAfter(ymd(month, 10));
      if (day <= today) {
        const usd = us.roth.usd;
        const units = Math.round((usd / heldClose("SPY", day)) * 1e6) / 1e6;
        book.addUnits("rothIra", units, 6);
        book.transfer({ from: "usChecking", to: "rothIra", date: day, usd, units, flowKind: "stock_buy", note: `Roth IRA ${year} contribution|compra SPY` });
      }
    }

    /* the wire to Chile, after the month's first pay: what the Chilean accounts need until the next one */
    {
      const day = usBusinessDayOnOrAfter(ymd(month, 20));
      if (day <= today) {
        const fx = market.fx(day);
        const needClp = 2 * trailingExpense() + chileUpcomingNeeds(month);
        const haveClp = Math.max(0, book.lowestFrom("checking", day)) + Math.max(0, book.lowestFrom("checkingUsd", day)) * fx;
        const wanted = Math.ceil((needClp - haveClp) / fx / 100) * 100;
        // Chile comes first: the US reserve for known needs (the car) only holds back the broker sweep.
        const spare = book.lowestFrom("usChecking", day) - usCardOwedUsd(month) - us.cashBand.low * usTrailingExpense() - us.wireFeeUsd;
        const usd = Math.min(wanted, Math.floor(spare / 100) * 100);
        if (process.env.DEMO_V2_TRACE) console.log(`wire ${day} need=${Math.round(needClp)} have=${Math.round(haveClp)} wanted=${wanted} spare=${Math.round(spare)} usExp=${Math.round(usTrailingExpense())}`);
        if (usd >= 500) {
          book.transfer({ from: "usChecking", to: "checkingUsd", date: day, usd, flowKind: null, note: "Wire transfer to Chile (Santander USD)" });
          usBill(day, "OUTGOING WIRE FEE", "bills", us.wireFeeUsd);
          // The dollars become pesos the same day (the Chilean bills and the mortgage are in pesos).
          sellUsd(day, book.lowestFrom("checkingUsd", day));
        }
      }
    }

    /* US cash above the band goes to the US broker (payday, once it is open) */
    const day = lastBusinessDay(month);
    if (ibkrOpen(month) && day <= today) {
      const monthly = usTrailingExpense();
      const free = book.lowestFrom("usChecking", day) - usCardOwedUsd(month) - usUpcomingNeeds(month);
      if (free > us.cashBand.high * monthly) {
        const usd = Math.floor((free - us.cashBand.target * monthly) / 100) * 100;
        if (usd >= 100) book.transfer({ from: "usChecking", to: "ibkrUsd", date: day, usd, flowKind: null, note: "IBKR|depósito USD (ACH)" });
      }
    }
  }
  /** Average US spending of the months since the move (at least the rent and the lifestyle). */
  function usTrailingExpense(): number {
    const us = US!;
    const xs = [...usExpenseByMonth.values()].slice(-6);
    const floor = us.rent.usd + us.monthlyUsd;
    if (xs.length === 0) return floor;
    return Math.max(floor, xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  /** Known US outflows of the next three months (the car, the Roth contribution, the December flight). */
  function usUpcomingNeeds(month: Month): number {
    const us = US!;
    let need = 0;
    for (let k = 1; k <= 3; k++) {
      const m = addMonths(month, k);
      if (us.car && monthOf(us.car.date) === m) need += us.car.usd;
      if (us.roth && Number(m.slice(5, 7)) === us.roth.month && Number(m.slice(0, 4)) >= us.roth.fromYear) need += us.roth.usd;
      if (m.endsWith("-12")) need += us.decemberTripUsd * 1.2;
    }
    return need;
  }
  /** Known Chilean peso needs of this month and the next two (abroad: what the wire must cover). */
  function chileUpcomingNeeds(month: Month): number {
    let need = 0;
    for (let k = 0; k <= 2; k++) {
      const m = addMonths(month, k);
      const y = Number(m.slice(0, 4));
      if (m.endsWith("-12") && y >= APV.from) need += APV.utm * market.utm(month);
      for (const h of HOUSES) for (const pp of h.prepayments) if (monthOf(pp.date) === m) need += pp.uf * market.uf(ymd(month, 1)) * 1.02;
      for (const p of PLAYS) if (p.kind === "buy_clp" && monthOf(p.date) === m) need += p.clp + 200_000;
      if (m.endsWith("-04") && (taxYears.has(y - 1) || settlementOverrides.has(y - 1))) {
        need += Math.max(0, settlementOverrides.get(y - 1) ?? annualTax(y - 1).result);
      }
      // A card purchase is paid with the next month's statement (its cuotas, one a month).
      for (const o of ONE_OFFS) {
        if (addMonths(o.month, 1) !== m) continue;
        if (o.clp != null) need += o.cuotas && o.cuotas > 1 ? o.clp / o.cuotas : o.clp;
        // A dollar charge on a Chilean card is paid with dollars bought from the peso account.
        if (o.usd) need += o.usd * market.fx(ymd(month, 1)) * 1.02;
      }
    }
    return need;
  }
  /** What he earns in his first month (real pesos): the lifestyle starts there when no allowance does. */
  function firstMonthIncomeReal(): number {
    const job = contractJobFor(FIRST_MONTH);
    if (job) return contractPayslip(job, FIRST_MONTH, market).net;
    const c = contractorJobFor(FIRST_MONTH);
    if (c) return c.monthlyUsd * market.fx(ymd(FIRST_MONTH, 15)) * 0.83;
    return LIFESTYLE_BASE_INCOME;
  }
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
      if (m.endsWith("-12") && Number(m.slice(0, 4)) >= APV.from && !apvMonthlyIn(m)) need += APV.utm * market.utm(month);
      if (apvMonthlyIn(m)) need += APV.monthly!.uf * market.uf(ymd(month, 1));
      for (const h of HOUSES) for (const pp of h.prepayments) if (monthOf(pp.date) === m) need += pp.uf * market.uf(ymd(month, 1));
      if (includePlays && k <= 3) for (const p of PLAYS) if (p.kind === "buy" && monthOf(p.date) === m) need += p.usd * market.fx(ymd(month, 1));
      // Moving in: the deposit (garantía) and the first rent.
      for (const h of HOUSING) if (h.kind === "rent" && h.from === m) need += 2.2 * h.rentClp;
      // A month without income (between jobs) is lived on savings.
      if (m >= person.checkingFrom && !contractJobFor(m) && !contractorJobFor(m) && !usJobFor(m)) need += 1.5 * trailingExpense();
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

export function contractPayslip(job: ContractJob, month: Month, market: MarketReader): ContractPayslip {
  const year = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  const base = baseFor(job, month);
  const grat = monthlyGratificationClp(base, year);
  const aguinaldo = mo === 9 || mo === 12 ? job.aguinaldoClp : 0;
  const bonus = job.bonusMonth != null && mo === job.bonusMonth && monthsBetween(job.from, month) >= 6 ? base : 0;
  const taxablePay = base + grat + aguinaldo + bonus;
  const ufDay = market.uf(ymd(month, daysInMonth(month)));
  const utm = market.utm(month);
  const taxableBase = Math.min(taxablePay, Math.round(pensionCapUf(year) * ufDay));
  const afcBase = Math.min(taxablePay, Math.round(unemploymentCapUf(year) * ufDay));
  const fund: "modelo" | "uno" = month >= AFP_SWITCH_MONTH ? "uno" : "modelo";
  const pension = Math.round((taxableBase * afpWorkerRatePct(fund, month)) / 100);
  const health = legalHealthClp(taxableBase);
  const afc = Math.round((afcBase * AFC_RATES_PCT.worker) / 100);
  const tax = Math.round(iuscTax(taxablePay - pension - health - afc, utm, year));
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

/**
 * One cuota of a French schedule in UF: the minimum dividendo re-amortizes the balance
 * over the months left, as the bank does after an extra amortization or a prepago.
 */
export function mortgageCuotaUf(house: House, balanceUf: number, monthsLeft: number) {
  const i = house.monthlyRate;
  const pmtUf = (balanceUf * i) / (1 - Math.pow(1 + i, -monthsLeft));
  const interestUf = balanceUf * i;
  const amortUf = pmtUf - interestUf;
  return { pmtUf, interestUf, amortUf, balanceAfterUf: balanceUf - amortUf };
}

/** The UF balance after the last cuota or prepago. */
export function mortgageBalanceUf(m: Mortgage, through?: Ymd): number {
  let bal = m.principalUf;
  for (const c of m.cuotas) if (through == null || c.date <= through) bal = c.balanceAfterUf;
  return bal;
}
export { BRANCH };
