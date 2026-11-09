/**
 * The people the synthetic databases are generated for: one life each, told through the documents
 * a real person receives. Every number here is hand-tuned — no personal data. Amounts are CLP
 * unless named `Usd`; "real" CLP amounts are in pesos of the person's `realBaseMonth` and are
 * indexed by the UF (≈ IPC) when spent.
 *
 * - `DEMO_PERSON`: the hosted demo (2016 → today; docs/demo-generator-plan.md).
 * - `testPerson(today)`: the Vitest database — the same engine on a short life ending today
 *   (about twenty months), so the suite stays fast.
 */

/** `YYYY-MM`. */
export type Month = string;
/** `YYYY-MM-DD`. */
export type Ymd = string;


export type ContractJob = {
  kind: "contract";
  id: string;
  employer: string;
  employerRut: string;
  /** Short name the bank prints on the salary credit. */
  bankName: string;
  from: Month;
  /** Last month worked (inclusive). */
  to: Month;
  /** Gross base salary at `from`. */
  baseClp: number;
  /** Raise applied every `raiseMonth` after the first year (fraction). */
  yearlyRaise: number;
  raiseMonth: number;
  mealClp: number;
  transportClp: number;
  /** A yearly bonus of one base salary paid in this calendar month (null: none). */
  bonusMonth: number | null;
  /** Aguinaldo paid in September and December. */
  aguinaldoClp: number;
  /** Monthly broker deposit (DCA) while this job lasts. */
  dcaClp: number;
};

export type ContractorJob = {
  kind: "contractor";
  id: string;
  employer: string;
  /** The payment platform the wire comes from. */
  platform: string;
  from: Month;
  to: Month | null;
  monthlyUsd: number;
  transferFeeUsd: number;
  /** Monthly broker deposit (DCA, in dollars) while this job lasts. */
  dcaUsd: number;
};

export type Internship = {
  id: string;
  employer: string;
  employerRut: string;
  months: Month[];
  grossClp: number;
};

const INTERNSHIPS: Internship[] = [
  { id: "intern1", employer: "LABORATORIO DATOS SPA", employerRut: "76.123.456-7", months: ["2017-01", "2017-02"], grossClp: 550_000 },
  { id: "intern2", employer: "CODIGO SUR LTDA", employerRut: "77.234.567-8", months: ["2018-01", "2018-02"], grossClp: 650_000 },
];

const CONTRACT_JOBS: ContractJob[] = [
  {
    kind: "contract",
    id: "job1",
    employer: "Consultora Andes SpA",
    employerRut: "76.345.678-9",
    bankName: "CONSULTORA ANDES SPA",
    from: "2018-04",
    to: "2020-06",
    baseClp: 1_150_000,
    yearlyRaise: 0.06,
    raiseMonth: 4,
    mealClp: 50_000,
    transportClp: 40_000,
    bonusMonth: null,
    aguinaldoClp: 60_000,
    dcaClp: 100_000,
  },
  {
    kind: "contract",
    id: "job2",
    employer: "Fintech Austral SpA",
    employerRut: "76.456.789-0",
    bankName: "FINTECH AUSTRAL SPA",
    from: "2020-08",
    to: "2022-09",
    baseClp: 2_550_000,
    yearlyRaise: 0.07,
    raiseMonth: 8,
    mealClp: 60_000,
    transportClp: 40_000,
    bonusMonth: 3,
    aguinaldoClp: 80_000,
    dcaClp: 250_000,
  },
];

const CONTRACTOR_JOBS: ContractorJob[] = [
  { kind: "contractor", id: "job3", employer: "Northwind Labs Inc.", platform: "DEEL", from: "2022-10", to: "2024-09", monthlyUsd: 6_000, transferFeeUsd: 15, dcaUsd: 1_500 },
  { kind: "contractor", id: "job4", employer: "Bluepeak Software LLC", platform: "DEEL", from: "2024-10", to: null, monthlyUsd: 8_000, transferFeeUsd: 15, dcaUsd: 2_000 },
];

/** Dad's monthly allowance while studying (to the cuenta vista). */
const ALLOWANCE = { from: "2016-02" as Month, to: "2019-03" as Month, clp: 250_000 };

/** Where he lives: parents, a first apartment (from the second job), an expensive one, his own. */
export type Housing =
  | { kind: "parents"; from: Month; to: Month; aporteClp: number }
  | { kind: "rent"; id: string; from: Month; to: Month; rentClp: number; gcClp: number; landlord: string }
  | { kind: "own"; from: Month };

const HOUSING: Housing[] = [
  { kind: "parents", from: "2016-02", to: "2020-07", aporteClp: 80_000 },
  { kind: "rent", id: "apt1", from: "2020-08", to: "2023-01", rentClp: 550_000, gcClp: 75_000, landlord: "MARIA GONZALEZ" },
  { kind: "rent", id: "apt2", from: "2023-02", to: "2024-02", rentClp: 820_000, gcClp: 130_000, landlord: "INMOBILIARIA VISTA ALTA" },
  { kind: "own", from: "2024-03" },
];

export type House = {
  month: Month;
  valueUf: number;
  pieUf: number;
  gastosOperacionalesUf: number;
  termMonths: number;
  monthlyRate: number;
  /** Paid above the minimum dividendo every month (amortización extraordinaria), UF. */
  monthlyExtraUf: number;
  /** Partial prepayments (prepagos), paid by transfer from checking. */
  prepayments: { date: Ymd; uf: number }[];
  gcClp: number;
  contribucionesMonths: number[];
  contribucionesClp: number;
  dadGift: { date: Ymd; clp: number };
  pieDate: Ymd;
  gastosDate: Ymd;
  monthlyAppreciation: number;
  /** From this month investing pauses: the cash is the pie. */
  holdFromMonth: Month;
  /** The broker sale's dollars come home to the dollar account on this day (pesos the next). */
  saleTransferDate: Ymd;
};

/** His own apartment: dad's gift + an NVDA (and some SPY) sale pay the pie. */
const HOUSE: House = {
  month: "2024-03",
  valueUf: 5_500,
  pieUf: 1_100,
  gastosOperacionalesUf: 160,
  termMonths: 300,
  /** Monthly rate of the UF credit (≈ 4,4 %/yr). */
  monthlyRate: 0.0036,
  /** Enough above the minimum that the balance falls faster than the UF rises. */
  monthlyExtraUf: 12,
  prepayments: [
    { date: "2025-07-22", uf: 150 },
    { date: "2026-05-20", uf: 120 },
  ],
  gcClp: 150_000,
  /** Contribuciones paid in these months (real CLP). */
  contribucionesMonths: [4, 6, 9, 11],
  contribucionesClp: 70_000,
  dadGift: { date: "2024-02-26", clp: 25_000_000 },
  pieDate: "2024-03-06",
  gastosDate: "2024-03-08",
  /** Property value growth per month (UF terms). */
  monthlyAppreciation: 0.0012,
  holdFromMonth: "2023-11",
  saleTransferDate: "2024-02-19",
};

export type Car = { id: string; from: Month; to: Month | null; priceClp: number; tradeInClp: number; permisoClp: number; insuranceClp: number };

const CARS: Car[] = [
  { id: "car1", from: "2019-03", to: "2022-12", priceClp: 6_500_000, tradeInClp: 0, permisoClp: 140_000, insuranceClp: 0 },
  { id: "car2", from: "2023-01", to: null, priceClp: 17_000_000, tradeInClp: 4_200_000, permisoClp: 360_000, insuranceClp: 38_000 },
];

/** One-off purchases: trips, tech, furniture. `cuotas` > 1 bills as an installment plan. */
export type OneOff = {
  month: Month;
  day: number;
  label: string;
  category: string;
  /** CLP portion on the card (null: none). */
  clp: number | null;
  cuotas?: number;
  /** USD portion on the card's dollar side (travel abroad, online purchases). */
  usd?: number;
  card?: "main" | "second";
};

const ONE_OFFS: OneOff[] = [
  { month: "2018-06", day: 9, label: "MAC STORE PARQUE ARAUCO", category: "others", clp: 1_250_000, cuotas: 12 },
  { month: "2019-08", day: 14, label: "ENTEL TIENDA IPHONE", category: "others", clp: 900_000, cuotas: 12 },
  { month: "2019-09", day: 3, label: "LATAM AIRLINES", category: "fun", clp: 480_000, cuotas: 6 },
  { month: "2019-09", day: 20, label: "HOTEL CUSCO PLAZA", category: "fun", clp: null, usd: 520 },
  { month: "2020-08", day: 4, label: "CASA IDEAS", category: "others", clp: 1_600_000, cuotas: 6 },
  { month: "2021-01", day: 8, label: "SKY AIRLINE", category: "fun", clp: 380_000, cuotas: 3 },
  { month: "2021-01", day: 22, label: "LODGE TORRES DEL PAINE", category: "fun", clp: 820_000 },
  { month: "2022-11", day: 12, label: "MAC STORE COSTANERA", category: "others", clp: 2_400_000, cuotas: 12 },
  { month: "2023-01", day: 6, label: "IBERIA AIRLINES", category: "fun", clp: 1_650_000, cuotas: 12 },
  { month: "2023-01", day: 24, label: "BOOKING.COM MADRID", category: "fun", clp: null, usd: 2_100, card: "second" },
  { month: "2023-02", day: 2, label: "IKEA PARIS", category: "fun", clp: null, usd: 1_200, card: "second" },
  { month: "2023-02", day: 15, label: "PARIS HOGAR", category: "others", clp: 1_400_000, cuotas: 6 },
  { month: "2023-09", day: 22, label: "MAC STORE IPHONE", category: "others", clp: 1_300_000, cuotas: 12 },
  { month: "2024-03", day: 14, label: "FALABELLA HOGAR", category: "others", clp: 2_400_000, cuotas: 12 },
  { month: "2024-03", day: 18, label: "CIC COLCHONES", category: "others", clp: 900_000 },
  { month: "2024-09", day: 5, label: "LATAM AIRLINES", category: "fun", clp: 1_800_000, cuotas: 10, card: "second" },
  { month: "2024-09", day: 20, label: "JR PASS TOKYO", category: "fun", clp: null, usd: 2_600, card: "second" },
  { month: "2025-09", day: 10, label: "GOL LINHAS AEREAS", category: "fun", clp: 620_000, cuotas: 6 },
  { month: "2025-09", day: 18, label: "AIRBNB RIO DE JANEIRO", category: "fun", clp: null, usd: 900, card: "second" },
  { month: "2025-11", day: 7, label: "MAC STORE COSTANERA", category: "others", clp: 2_700_000, cuotas: 12 },
  { month: "2026-01", day: 7, label: "AMERICAN AIRLINES", category: "fun", clp: 2_000_000, cuotas: 12, card: "second" },
  { month: "2026-01", day: 21, label: "MARRIOTT NEW YORK", category: "fun", clp: null, usd: 3_400, card: "second" },
];

/** The cards: a main card with the first contract, a second one with the first dollar job. */
export type CardDef = { key: "main" | "second"; issuer: "santander" | "bci"; last4: string; displayName: string; from: Month; closeDay: number };

const CARDS: CardDef[] = [
  { key: "main", issuer: "santander", last4: "4417", displayName: "Visa Platinum 4417", from: "2018-05", closeDay: 22 },
  { key: "second", issuer: "bci", last4: "8823", displayName: "Mastercard Black 8823", from: "2022-11", closeDay: 25 },
];

/**
 * Broker plays at the Chilean broker, on top of the SPY DCA: buys in dollars, a buy in pesos of a
 * Santiago-listed (`.SN`) ticker, and sells of a fraction of what the broker holds (a `.SN` sale
 * pays pesos, any other dollars).
 */
export type Play =
  | { kind: "buy"; date: Ymd; ticker: string; usd: number }
  | { kind: "buy_clp"; date: Ymd; ticker: string; clp: number }
  | { kind: "sell"; date: Ymd; ticker: string; fraction: number };

const PLAYS: Play[] = [
  { kind: "buy", date: "2019-03-20", ticker: "AAPL", usd: 1_200 },
  { kind: "buy", date: "2019-07-15", ticker: "AMD", usd: 1_000 },
  { kind: "buy", date: "2020-04-15", ticker: "MSFT", usd: 1_500 },
  { kind: "buy", date: "2020-10-20", ticker: "ZM", usd: 1_500 },
  { kind: "buy", date: "2021-03-15", ticker: "NVDA", usd: 3_000 },
  { kind: "buy", date: "2021-04-20", ticker: "INTC", usd: 2_000 },
  { kind: "buy", date: "2023-03-15", ticker: "MSFT", usd: 3_000 },
  // The pie: NVDA at a large gain, and ZM closed at a loss the same day (the loss offsets the gain).
  { kind: "sell", date: "2024-02-15", ticker: "NVDA", fraction: 0.6 },
  { kind: "sell", date: "2024-02-15", ticker: "ZM", fraction: 1 },
  { kind: "sell", date: "2024-02-15", ticker: "SPY", fraction: 0.3 },
  { kind: "buy", date: "2025-04-09", ticker: "NVDA", usd: 4_000 },
  // The Chilean IPSA ETF (an art. 107 fund), bought in pesos and partly sold at a gain.
  { kind: "buy_clp", date: "2025-06-17", ticker: "CFIETFIPSA.SN", clp: 6_000_000 },
  { kind: "sell", date: "2026-03-10", ticker: "CFIETFIPSA.SN", fraction: 0.4 },
  { kind: "buy", date: "2026-05-12", ticker: "OILK", usd: 5_000 },
  { kind: "buy", date: "2026-05-12", ticker: "LNG", usd: 5_000 },
  { kind: "sell", date: "2026-06-23", ticker: "OILK", fraction: 1 },
];

const BROKER_TICKERS = ["SPY", "AAPL", "AMD", "MSFT", "ZM", "NVDA", "INTC", "OILK", "LNG", "SGOV", "CFIETFIPSA.SN"];

/** A stock split as the exchange states it (shares × numerator / denominator from the ex-date). */
export type StockSplit = { ticker: string; exDate: Ymd; numerator: number; denominator: number };

/** NVDA's two splits while he holds it (Yahoo's closes are already adjusted for both). */
const SPLITS: StockSplit[] = [
  { ticker: "NVDA", exDate: "2021-07-20", numerator: 4, denominator: 1 },
  { ticker: "NVDA", exDate: "2024-06-10", numerator: 10, denominator: 1 },
];

/** The three 10 % pension withdrawals of 2020–2021 (the day each was paid). */
const AFP_WITHDRAWALS: Ymd[] = ["2020-08-10", "2020-12-14", "2021-05-10"];

/** Rolling peso term deposits while saving the pie. */
export type TermDeposits = {
  from: Month;
  /** No deposit matures after this month. */
  to: Month;
  termDays: number;
  /** The first deposit (pesos); each renewal reinvests the payout plus a top-up. */
  openingClp: number;
  topUpClp: number;
};
const DAP: TermDeposits = { from: "2021-03", to: "2023-12", termDays: 90, openingClp: 5_000_000, topUpClp: 2_000_000 };

/** A second US broker (Interactive Brokers): dollars, SGOV as the reserve, new SPY buys. */
export type SecondBroker = {
  from: Month;
  /** Dollars left uninvested (they earn the sweep interest). */
  idleUsd: number;
  /** SGOV held as the dollar reserve before new money goes to SPY. */
  sgovReserveUsd: number;
};
const IBKR: SecondBroker = { from: "2024-05", idleUsd: 2_000, sgovReserveUsd: 15_000 };
export const BTC_TICKER = "BTC-USD";

/** Quarterly dividend per share (USD), by ticker; paid in Mar/Jun/Sep/Dec, 15 % withheld. */
const DIVIDEND_PER_SHARE_USD: Record<string, number> = { SPY: 1.55, AAPL: 0.23, MSFT: 0.65, INTC: 0.3, LNG: 0.45 };

/** Bitcoin: monthly DCA through the exchange plus a lump at the 2018 bottom. */
const BTC = { from: "2018-06" as Month, to: "2019-12" as Month, monthlyClp: 50_000, lump: { date: "2018-12-14" as Ymd, clp: 400_000 } };

/** Cash band on checking CLP + USD (months of trailing expenses). */
const CASH_BAND = { low: 3, target: 4.5, high: 6, trailingMonths: 6 };

/**
 * APV: 40 UTM every December; in the `monthly` window a deposit of `uf` every month instead (up to
 * the 600 UF yearly cap). The regime is the one that pays more: B when the tax it saves beats
 * regime A's state bonus (15 %, capped at 6 UTM a year) — for a deposit under the bonus cap, B
 * exactly when the marginal rate is above 15 %.
 */
export type ApvPlan = {
  from: number;
  utm: number;
  bonusRate: number;
  bonusCapUtm: number;
  depositDay: number;
  monthly: { from: Month; to: Month; uf: number } | null;
};
const APV: ApvPlan = { from: 2019, utm: 40, bonusRate: 0.15, bonusCapUtm: 6, depositDay: 18, monthly: { from: "2022-10", to: "2024-03", uf: 30 } };

export type Person = {
  /** Seeds every random stream. */
  seed: number;
  firstMonth: Month;
  /** The month whose pesos the "real" amounts (lifestyle, tickets, rents) are in. */
  realBaseMonth: Month;
  /** Prices and rates start this month (prior closes, watchlist anchors need some history). */
  marketFromMonth: (today: Ymd) => Month;
  /** Savings he starts with, deposited in cash on the first business day. */
  opening: { account: "vista" | "checking"; clp: number };
  /** The cuenta corriente opens this month (the vista's balance moves over). */
  checkingFrom: Month;
  dadName: string;
  allowance: { from: Month; to: Month; clp: number } | null;
  internships: Internship[];
  contractJobs: ContractJob[];
  contractorJobs: ContractorJob[];
  housing: Housing[];
  house: House | null;
  cars: Car[];
  oneOffs: OneOff[];
  cards: CardDef[];
  plays: Play[];
  splits: StockSplit[];
  /** Days the AFP paid a withdrawal of funds (10 % of the balance, 35 UF floor, 150 UF cap). */
  afpWithdrawals: Ymd[];
  dap: TermDeposits | null;
  /** A second US broker from `from`: the dollar DCA and lump sums go there (null: none). */
  ibkr: SecondBroker | null;
  /** Every ticker the broker can hold (SPY first: the DCA and lump sums buy it). */
  brokerTickers: string[];
  dividendPerShareUsd: Record<string, number>;
  btc: { from: Month; to: Month; monthlyClp: number; lump: { date: Ymd; clp: number } | null } | null;
  /** A Fintual-style mutual fund: a monthly deposit from checking buys its cuotas (null: none). */
  fund: { name: string; from: Month; monthlyClp: number } | null;
  cashBand: { low: number; target: number; high: number; trailingMonths: number };
  apv: ApvPlan;
  /** Where net worth should land today (USD), for the build's sanity check; null: no target. */
  netWorthTargetUsd: number | null;
  /** Days of generated ingest history (scheduler runs, run messages, bank checks) before today. */
  ingestHistoryDays: number;
};

/** The hosted demo's person: born 1995, a decade of documents from university to his own apartment. */
export const DEMO_PERSON: Person = {
  seed: 1995_04_17,
  firstMonth: "2016-02",
  realBaseMonth: "2016-01",
  marketFromMonth: (today) => {
    const m = addMonths(monthOf(today), -132);
    return m < "2016-02" ? m : "2016-02";
  },
  opening: { account: "vista", clp: 380_000 },
  checkingFrom: "2018-04",
  dadName: "JORGE DEMO",
  allowance: ALLOWANCE,
  internships: INTERNSHIPS,
  contractJobs: CONTRACT_JOBS,
  contractorJobs: CONTRACTOR_JOBS,
  housing: HOUSING,
  house: HOUSE,
  cars: CARS,
  oneOffs: ONE_OFFS,
  cards: CARDS,
  plays: PLAYS,
  splits: SPLITS,
  afpWithdrawals: AFP_WITHDRAWALS,
  dap: DAP,
  ibkr: IBKR,
  brokerTickers: BROKER_TICKERS,
  dividendPerShareUsd: DIVIDEND_PER_SHARE_USD,
  btc: BTC,
  fund: null,
  cashBand: CASH_BAND,
  apv: APV,
  netWorthTargetUsd: 400_000,
  ingestHistoryDays: 45,
};

/**
 * The Vitest person: the same engine on about twenty months ending today — a contrato job with
 * liquidaciones, then a contractor job paid in dollars; a rented apartment; two cards with cuotas
 * and a dollar side; the broker (SPY plus one play); AFP, AFC and an APV deposit. Dates are relative
 * to today, so the database always ends in the current month.
 */
export function testPerson(today: Ymd): Person {
  const cur = monthOf(today);
  const back = (k: number) => addMonths(cur, -k);
  const first = back(19);
  return {
    seed: 4242,
    firstMonth: first,
    realBaseMonth: first,
    marketFromMonth: () => back(22),
    opening: { account: "checking", clp: 2_500_000 },
    checkingFrom: first,
    dadName: "PADRE PRUEBA",
    allowance: null,
    internships: [],
    contractJobs: [
      {
        kind: "contract",
        id: "testjob1",
        employer: "Empresa Prueba SpA",
        employerRut: "76.000.111-2",
        bankName: "EMPRESA PRUEBA SPA",
        from: first,
        to: back(8),
        baseClp: 1_900_000,
        yearlyRaise: 0.05,
        raiseMonth: Number(first.slice(5, 7)),
        mealClp: 50_000,
        transportClp: 40_000,
        bonusMonth: null,
        aguinaldoClp: 60_000,
        dcaClp: 150_000,
      },
    ],
    contractorJobs: [
      { kind: "contractor", id: "testjob2", employer: "Remote Test Inc.", platform: "DEEL", from: back(7), to: null, monthlyUsd: 5_000, transferFeeUsd: 15, dcaUsd: 1_000 },
    ],
    housing: [{ kind: "rent", id: "testapt", from: first, to: "9999-12", rentClp: 600_000, gcClp: 90_000, landlord: "ARRENDADOR PRUEBA" }],
    house: null,
    cars: [],
    oneOffs: [
      { month: back(14), day: 9, label: "MAC STORE PRUEBA", category: "others", clp: 1_200_000, cuotas: 6 },
      { month: back(5), day: 6, label: "AEROLINEA PRUEBA", category: "fun", clp: 700_000, cuotas: 3, card: "second" },
      { month: back(5), day: 18, label: "HOTEL PRUEBA", category: "fun", clp: null, usd: 650, card: "second" },
    ],
    cards: [
      { key: "main", issuer: "santander", last4: "4321", displayName: "Tarjeta Prueba 4321", from: first, closeDay: 22 },
      { key: "second", issuer: "bci", last4: "6605", displayName: "Tarjeta Prueba 6605", from: back(9), closeDay: 25 },
    ],
    plays: [{ kind: "buy", date: ymd(back(3), 15), ticker: "AAPL", usd: 800 }],
    splits: [],
    afpWithdrawals: [],
    dap: null,
    ibkr: null,
    brokerTickers: ["SPY", "AAPL"],
    dividendPerShareUsd: { SPY: 1.55, AAPL: 0.23 },
    btc: null,
    fund: { name: "Fondo Moderado", from: back(16), monthlyClp: 120_000 },
    cashBand: CASH_BAND,
    apv: { ...APV, monthly: null },
    netWorthTargetUsd: null,
    // A few nights only: the suite exercises the writer without paying for weeks of runs.
    ingestHistoryDays: 3,
  };
}

/* ------------------------------ calendar helpers ------------------------------ */

export function ymd(month: Month, day: number): Ymd {
  const last = daysInMonth(month);
  return `${month}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`;
}

export function daysInMonth(month: Month): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(month: Month, n: number): Month {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthsBetween(a: Month, b: Month): number {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
}

export function addDays(day: Ymd, n: number): Ymd {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function monthOf(day: Ymd): Month {
  return day.slice(0, 7);
}

export const MONTH_NAMES_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
