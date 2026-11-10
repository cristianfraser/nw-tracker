/**
 * The local Form 1040 (US federal individual return) for one calendar tax year: the composition of
 * the form's schedules, each its own pure module under `us1040/`, over the year's facts. The US law
 * it applies is read from primary sources in `docs/us-1040-readings.md` (the spec); the year's
 * figures come from `usLegalParameters.ts` (a closed year it does not list throws; the open year —
 * provisional, the stubs to date — uses its own figures when listed, else the latest year's).
 *
 * **Residency decides the return** (`taxResidency.ts`'s declared periods, `dualStatus.ts`):
 * - a full US-resident year: the ordinary return on worldwide income;
 * - a dual-status year (resident from a day inside it, resident at its end): the 1040 for the
 *   resident part (worldwide income received or realized from the day, no standard deduction),
 *   plus the nonresident statement's US-source dividends taxed at the withheld rate;
 * - a nonresident year with US pay stubs: a Form 1040-NR filer — not drafted
 *   ({@link usReturnStatusForYear});
 * - nothing declared: drafted as before the residency existed — the W-2s and the US bank accounts'
 *   interest only, as a full-year resident — and the return says so (`residency_undeclared`).
 *
 * **What goes where** (line roles in the 2024 numbering, `identities.ts`):
 *   1a  W-2 box 1 (`usW2.ts`, from the stored stubs)
 *   2b / 3a / 3b  Schedule B (`scheduleB.ts`): interest and dividends of the resident window, every
 *       payer, in dollars at each item's day (`facts.ts`, `fx.ts`)
 *   7   Schedule D (`scheduleD.ts`) over Form 8949 (`form8949.ts`): the window's disposals (FIFO,
 *       historic cost, PFICs left to Form 8621), the loss limited and carried
 *   8   Schedule 1 line 10 (`schedule1.ts`): Schedule E and Form 8621 (typed inputs until wired)
 *   12  the standard deduction, 0 on a dual-status return
 *   13  0: no QBI deduction (§199A(c)(3)(A)(i): a foreign rental is not a US trade or business)
 *   16  the Qualified Dividends and Capital Gain Tax Worksheet (`qualifiedDividendsWorksheet.ts`)
 *       with qualified dividends or a net gain, else the Tax Table / Tax Computation Worksheet; plus
 *       the dual-status statement's tax
 *   20  Schedule 3 line 1, the foreign tax credit (Form 1116; a typed input until wired)
 *   23  Schedule 2 line 21 (`schedule2.ts`): Form 8959 and Form 8960 (`form8960.ts`)
 *   25a W-2 box 2   25b 1099 withholding   25c Form 8959's withheld and every Form 1042-S
 *   31  Schedule 3: Social Security withheld above the maximum by two or more employers
 *
 * Not modelled (stated on the return): the qualified-dividend holding period; wash sales on the
 * stocks and ETFs; §988 exchange gains and losses on pesos; Form 2210; the Form 8833 positions; the
 * state return (no state withholding on the stubs: a job in a state without income tax).
 */
import { chileWallClockNow } from "../chileDate.js";
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { residencyForIncomeYear } from "../taxResidency.js";
import { computeF1040Lines, f1040YearHasLine, type F1040Inputs, type F1040Line, type F1040Lines } from "./identities.js";
import { filedF1040, filedF1040TaxYears, type FiledF1040 } from "./filed.js";
import type { PayslipLineKind, PayslipLineSide } from "../payslipLineKinds.js";
import {
  US_TAX_YEARS,
  usDividendWithholdingRateForChileanResident,
  usForm1040Tax,
  usTaxYear,
  type UsFilingStatus,
  type UsTaxYearParameters,
} from "../usLegalParameters.js";
import { usBankInterestForYear } from "../usBankAccounts.js";
import { usW2sFromStubLines, type UsW2, type UsW2Stub } from "../usW2.js";
import { dualStatusStatement, usResidencyOfYear, type DualStatusStatement, type UsResidencyOfYear } from "./dualStatus.js";
import {
  foreignAccountsReport,
  usDisposalLots,
  usDividendItems,
  usDualStatusDividendItems,
  usInterestItems,
  type ForeignAccountsReport,
  type UsDividendItem,
} from "./facts.js";
import { assertForm8949Row, form8949Rows, type Form8949Row } from "./form8949.js";
import { form8960, type Form8960 } from "./form8960.js";
import { qualifiedDividendsWorksheet, type QdcgWorksheet } from "./qualifiedDividendsWorksheet.js";
import { schedule1, type Schedule1 } from "./schedule1.js";
import { schedule2, type Schedule2 } from "./schedule2.js";
import { scheduleB, type ScheduleB, type ScheduleBInterestItem } from "./scheduleB.js";
import {
  capitalLossCarryoverOut,
  scheduleD,
  scheduleDNetCapitalGainForWorksheet,
  type CapitalLossCarryover,
  type ScheduleD,
} from "./scheduleD.js";

export type F1040Note =
  /** The stubs carry no state withholding: no state return is drafted. */
  | "no_state_return"
  /** The open year: the stubs to date, not the year's total. */
  | "open_year"
  /** The open year's law is not in the table yet: the latest listed year's figures stand in. */
  | "law_provisional"
  /** No tax residency declared: drafted as a full-year resident from the W-2s and the US bank interest only. */
  | "residency_undeclared"
  /** A dual-status return: resident part on the 1040, no standard deduction (box 12c on the 2025 form), the nonresident statement attached. */
  | "dual_status"
  /** The nonresident statement's tax is added to line 16. */
  | "dual_status_statement_tax_line_16"
  /** US tax withheld by a broker abroad (Form 1042-S) is a payment on line 25c, never a foreign tax. */
  | "withholding_1042s_line_25c"
  /** Qualified dividends: the 60-of-121-day holding period is not tested (no ex-dividend dates). */
  | "qualified_holding_period_not_tested"
  /** Wash sales (§1091) are not applied to the stocks and ETFs (they do not reach the coins). */
  | "wash_sales_not_modelled"
  /** Basis is historic cost in dollars at each purchase day: no step-up on becoming a resident. */
  | "no_step_up_on_residency"
  /** PFIC holdings (the Chilean funds and ETF, a UCITS line) are left out of Schedule D: Form 8621 owns them. */
  | "pfic_outside_schedule_d"
  /** The AFP, AFC and APV are read as Art. 18(4) treaty pensions (the APV assumed): their earnings are no income until paid. */
  | "treaty_pensions_deferred"
  /** Every peso amount converts at fx_daily of its own day (Pub. 514). */
  | "fx_daily_spot"
  /** Exchange gains and losses on pesos (§988) are not modelled. */
  | "section_988_not_modelled"
  /** The underpayment penalty (Form 2210) is not modelled. */
  | "form_2210_not_modelled"
  /** Schedule E, Form 8582, Form 8621 and Form 1116 are not composed into this draft yet (their lines read 0). */
  | "schedules_not_wired"
  /** FBAR / Form 8938: valued at month ends (a peak between two is not seen); coins at an exchange left out. */
  | "foreign_accounts_month_end";

/**
 * The figures the schedules built in another module bring (whole dollars; 0 until wired): the
 * wiring step codes against these names.
 */
export type F1040WiredInputs = {
  /** Schedule 1 line 5: Schedule E's net rental income or loss after Form 8582's passive limit. */
  scheduleENet: number;
  /** Schedule 1 line 8z: Form 8621 Part IV's mark-to-market inclusions (+) and allowed deductions (−). */
  pficMarkToMarket: number;
  /** Any other Schedule 1 line 8 income. */
  otherIncome: number;
  /** Schedule 3 line 1: Form 1116's foreign tax credit. */
  foreignTaxCredit: number;
  /** More Form 8949 rows (options, a PFIC sale's capital part), each whole dollars with h = d − e + g. */
  extraForm8949Rows: readonly Form8949Row[];
  /** Form 8960's parts that are not on the 1040's own lines: line 4a, the §1296 amounts of line 5a, other NII. */
  nii: { rentalNet: number; pficInclusions: number; other: number };
};

export const NO_WIRED_INPUTS: F1040WiredInputs = {
  scheduleENet: 0,
  pficMarkToMarket: 0,
  otherIncome: 0,
  foreignTaxCredit: 0,
  extraForm8949Rows: [],
  nii: { rentalNet: 0, pficInclusions: 0, other: 0 },
};

export type F1040Draft = {
  taxYear: number;
  provisional: boolean;
  /** Whose law the draft applied (the tax year itself, or the latest listed one for an open year). */
  lawYear: number;
  filingStatus: UsFilingStatus;
  residency: UsResidencyOfYear;
  /** The window whose worldwide income the 1040 declares (the whole year, or from the residency day). */
  residentWindow: DateWindow;
  stubs: number;
  w2s: UsW2[];
  /** Schedule B's items (dollars at each day) and its lines. */
  interest: ScheduleBInterestItem[];
  dividends: UsDividendItem[];
  scheduleB: ScheduleB;
  form8949: Form8949Row[];
  scheduleD: ScheduleD;
  capitalLossCarryoverIn: CapitalLossCarryover;
  capitalLossCarryoverOut: CapitalLossCarryover;
  /** Null when line 16 is the ordinary tax (no qualified dividends, no net gain). */
  qdcgWorksheet: QdcgWorksheet | null;
  schedule1: Schedule1;
  schedule2: Schedule2;
  form8960: Form8960;
  dualStatusStatement: DualStatusStatement | null;
  /** Form 1042-S withholding on the resident part's dividends (line 25c), whole dollars. */
  withholding1042S: number;
  /** Tax other countries withheld on dividends (a Form 1116 input), dollars. */
  foreignTaxWithheldUsd: number;
  /** Null for an undeclared residency (not drafted then). */
  foreignAccounts: ForeignAccountsReport | null;
  lines: F1040Lines;
  /** Boxes 4 and 6: withheld and reported, not part of the 1040's tax. */
  fica: { socialSecurity: number; medicare: number };
  /** Form 8959's tax on the year's Medicare wages above the threshold (dollars to the cent). */
  additionalMedicareTax: number;
  filed: FiledF1040 | null;
  notes: F1040Note[];
};

export type UsReturnStatus = { drafted: true; residency: UsResidencyOfYear } | { drafted: false; residency: UsResidencyOfYear; reason: "nonresident_alien" };

/** Whether a 1040 is drafted for `taxYear`: not for a nonresident year (a Form 1040-NR filer). */
export function usReturnStatusForYear(taxYear: number): UsReturnStatus {
  const residency = usResidencyOfYear(residencyForIncomeYear(taxYear));
  if (residency.kind === "nonresident") return { drafted: false, residency, reason: "nonresident_alien" };
  return { drafted: true, residency };
}

type StubRow = {
  id: number;
  source_pdf: string;
  pay_date: string | null;
  employer_name: string;
  employer_rut: string | null;
  w4_filing_status: UsFilingStatus | null;
};

function currentYear(todayYmd: string): number {
  return Number(todayYmd.slice(0, 4));
}

/** The first year with a US pay stub, or null without any. */
function firstUsPayYear(): number | null {
  const unpaid = db.prepare(`SELECT source_pdf FROM payroll_work_earnings WHERE jurisdiction = 'us' AND pay_date IS NULL LIMIT 1`).get() as
    | { source_pdf: string }
    | undefined;
  if (unpaid) throw new Error(`1040: US payslip ${unpaid.source_pdf} has no pay date`);
  const r = db.prepare(`SELECT MIN(pay_date) AS d FROM payroll_work_earnings WHERE jurisdiction = 'us'`).get() as { d: string | null };
  return r.d == null ? null : Number(r.d.slice(0, 4));
}

/**
 * Every tax year from the first one with a US pay stub through the current one, plus any year with
 * a filed return — newest first. Empty without US pay stubs or filed returns.
 */
export function availableUsTaxYears(todayYmd: string = chileWallClockNow().ymd): number[] {
  const years = new Set(filedF1040TaxYears());
  const first = firstUsPayYear();
  if (first != null) for (let y = first; y <= currentYear(todayYmd); y++) years.add(y);
  return [...years].sort((a, b) => b - a);
}

export function loadStubs(taxYear: number): { stubs: UsW2Stub[]; statuses: Set<UsFilingStatus>; firstPayDate: string | null } {
  const heads = db
    .prepare(
      `SELECT id, source_pdf, pay_date, employer_name, employer_rut, w4_filing_status FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date LIKE ? ORDER BY pay_date, id`
    )
    .all(`${taxYear}-%`) as StubRow[];
  const lineRows = db
    .prepare(
      `SELECT l.payslip_id, l.side, l.kind, l.amount FROM payslip_lines l
         JOIN payroll_work_earnings p ON p.id = l.payslip_id
        WHERE p.jurisdiction = 'us' AND p.pay_date LIKE ? ORDER BY l.payslip_id, l.position`
    )
    .all(`${taxYear}-%`) as { payslip_id: number; side: PayslipLineSide; kind: PayslipLineKind | null; amount: number }[];
  const linesById = new Map<number, UsW2Stub["lines"][number][]>();
  for (const l of lineRows) {
    if (l.kind == null) throw new Error(`1040: payslip ${l.payslip_id} has a line without a kind`);
    const list = linesById.get(l.payslip_id) ?? [];
    list.push({ side: l.side, kind: l.kind, amount: l.amount });
    linesById.set(l.payslip_id, list);
  }
  const statuses = new Set<UsFilingStatus>();
  const stubs = heads.map((h): UsW2Stub => {
    if (h.employer_rut == null) throw new Error(`1040: US payslip ${h.source_pdf} has no employer EIN`);
    if (h.w4_filing_status == null) throw new Error(`1040: US payslip ${h.source_pdf} has no W-4 filing status`);
    statuses.add(h.w4_filing_status);
    const lines = linesById.get(h.id);
    if (!lines) throw new Error(`1040: US payslip ${h.source_pdf} has no lines`);
    return { ref: h.source_pdf, payDate: h.pay_date!, employer: h.employer_name, ein: h.employer_rut, lines };
  });
  return { stubs, statuses, firstPayDate: heads[0]?.pay_date ?? null };
}

/** The W-4 filing status of the latest stub before the year (an open year with no stub yet). */
function latestFilingStatusBefore(taxYear: number): UsFilingStatus {
  const r = db
    .prepare(
      `SELECT w4_filing_status AS s FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date < ? ORDER BY pay_date DESC, id DESC LIMIT 1`
    )
    .get(`${taxYear}-01-01`) as { s: UsFilingStatus | null } | undefined;
  if (!r || r.s == null) throw new Error(`1040 ${taxYear}: no US pay stub to take a filing status from`);
  return r.s;
}

function lawYearFor(taxYear: number, provisional: boolean): number {
  if (US_TAX_YEARS[taxYear] || !provisional) {
    usTaxYear(taxYear); // a closed year needs its own law: throws when the table does not list it
    return taxYear;
  }
  const listed = Object.keys(US_TAX_YEARS).map(Number).filter((y) => y < taxYear);
  if (listed.length === 0) throw new Error(`1040 ${taxYear}: no US law listed before ${taxYear}`);
  return Math.max(...listed);
}

const cents = (x: number) => Math.round(x * 100) / 100;

/** What the W-2s give the return: wages, withholding, Form 8959 and Schedule 3's excess Social Security. */
type W2Figures = {
  wages: number;
  federalWithheld: number;
  additionalMedicareTax: number;
  /** Form 8959 part V: Medicare withheld beyond the regular 1,45 % (whole dollars). */
  additionalMedicareWithheld: number;
  excessSocialSecurity: number;
  fica: { socialSecurity: number; medicare: number };
};

function w2Figures(w2s: readonly UsW2[], filingStatus: UsFilingStatus, law: UsTaxYearParameters, label: string): W2Figures {
  const sum = (f: (w: UsW2) => number) => cents(w2s.reduce((s, w) => s + f(w), 0));
  const medicareWages = sum((w) => w.medicareWages);
  const medicareWithheld = sum((w) => w.medicareTax);
  const additionalMedicareTax = cents(Math.max(0, medicareWages - law.additionalMedicareThreshold[filingStatus]) * law.additionalMedicareRate);
  const additionalWithheldRaw = Math.round(medicareWithheld - medicareWages * law.medicareRate);
  const additionalMedicareWithheld = additionalWithheldRaw === 0 ? 0 : additionalWithheldRaw; // never −0
  if (additionalMedicareWithheld < 0) {
    throw new Error(`1040 ${label}: Medicare withheld (${medicareWithheld}) is below 1,45 % of the Medicare wages (${medicareWages})`);
  }
  // Schedule 3 line 11: with two or more employers, Social Security withheld above the maximum.
  const maxSocialSecurity = cents(law.socialSecurityWageBase * law.socialSecurityRate);
  for (const w of w2s) {
    if (w.socialSecurityTax > maxSocialSecurity + 0.005) {
      throw new Error(`1040 ${label}: ${w.employer} withheld ${w.socialSecurityTax} of Social Security, above the year's maximum ${maxSocialSecurity}`);
    }
  }
  const excessSocialSecurity = w2s.length > 1 ? Math.round(Math.max(0, sum((w) => w.socialSecurityTax) - maxSocialSecurity)) : 0;
  return {
    wages: Math.round(sum((w) => w.wages)),
    federalWithheld: Math.round(sum((w) => w.federalWithheld)),
    additionalMedicareTax,
    additionalMedicareWithheld,
    excessSocialSecurity,
    fica: { socialSecurity: sum((w) => w.socialSecurityTax), medicare: medicareWithheld },
  };
}

/** The prior year's capital loss carryover, from its own draft (none before the first drafted year). */
function carryoverInto(taxYear: number, todayYmd: string): CapitalLossCarryover {
  const prior = taxYear - 1;
  if (!availableUsTaxYears(todayYmd).includes(prior)) return { shortTerm: 0, longTerm: 0 };
  const status = usReturnStatusForYear(prior);
  if (!status.drafted || status.residency.kind === "undeclared") return { shortTerm: 0, longTerm: 0 };
  return buildF1040Draft(prior, todayYmd).capitalLossCarryoverOut;
}

/** Throws unless every wired figure is whole dollars and every extra 8949 row adds up. */
function assertWired(w: F1040WiredInputs): void {
  for (const [k, v] of Object.entries({ ...w, ...Object.fromEntries(Object.entries(w.nii).map(([a, b]) => [`nii.${a}`, b])) })) {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error(`1040: wired input ${k} = ${v} is not whole dollars`);
  }
  if (w.foreignTaxCredit < 0) throw new Error(`1040: a foreign tax credit of ${w.foreignTaxCredit}`);
  for (const r of w.extraForm8949Rows) assertForm8949Row(r);
}

/**
 * The year's draft. `wired`: the figures of the schedules composed elsewhere (Schedule E, Form 8582,
 * Form 8621, Form 1116); every one 0 until the wiring step passes them.
 */
export function buildF1040Draft(taxYear: number, todayYmd: string = chileWallClockNow().ymd, wired: F1040WiredInputs = NO_WIRED_INPUTS): F1040Draft {
  if (!Number.isInteger(taxYear)) throw new Error(`1040: tax year ${taxYear}`);
  const provisional = taxYear >= currentYear(todayYmd);
  if (taxYear > currentYear(todayYmd)) throw new Error(`1040 ${taxYear}: a year that has not started`);
  assertWired(wired);
  const status = usReturnStatusForYear(taxYear);
  if (!status.drafted) {
    throw new Error(`1040 ${taxYear}: a nonresident alien files Form 1040-NR, which is not drafted (no US tax residency declared for the year)`);
  }
  const residency = status.residency;
  const lawYear = lawYearFor(taxYear, provisional);
  const law = usTaxYear(lawYear);
  const { stubs, statuses } = loadStubs(taxYear);
  if (statuses.size > 1) throw new Error(`1040 ${taxYear}: the stubs carry several W-4 filing statuses (${[...statuses].join(", ")})`);
  const filingStatus = statuses.size === 1 ? [...statuses][0]! : latestFilingStatusBefore(taxYear);
  const dual = residency.kind === "dual_status";
  if (dual && filingStatus !== "single") {
    throw new Error(`1040 ${taxYear}: a dual-status return cannot be joint (Pub. 519); the stubs say ${filingStatus}`);
  }
  const w2s = usW2sFromStubLines(stubs, (y) => (y === taxYear ? lawYear : y));
  const w2 = w2Figures(w2s, filingStatus, law, `${taxYear}`);

  const yearEnd = `${taxYear}-12-31`;
  const residentWindow: DateWindow = { fromYmd: dual ? residency.from! : `${taxYear}-01-01`, throughYmd: yearEnd };
  const undeclared = residency.kind === "undeclared";
  // Income received to date for an open year; the facts loaders read the ledger, which ends today.
  const interest: ScheduleBInterestItem[] = undeclared
    ? usBankInterestForYear(taxYear).lines.map((l) => ({ payer: `#${l.accountId}`, date: l.date, movementId: l.movementId, usd: l.usd }))
    : usInterestItems(residentWindow);
  const dividends = undeclared ? [] : usDividendItems(residentWindow);
  const lastDay = provisional ? (todayYmd < yearEnd ? todayYmd : yearEnd) : yearEnd;
  const foreignAccounts = undeclared ? null : foreignAccountsReport(residentWindow, lastDay);
  const b = scheduleB({ interest, dividends, foreignAccount: foreignAccounts != null && foreignAccounts.accounts.length > 0 });

  const rows = [...(undeclared ? [] : form8949Rows(usDisposalLots(residentWindow), taxYear)), ...wired.extraForm8949Rows];
  const carryIn = undeclared ? { shortTerm: 0, longTerm: 0 } : carryoverInto(taxYear, todayYmd);
  const d = scheduleD(rows, carryIn, law.capitalLossLimit);
  const s1 = schedule1({ rentalRealEstate: wired.scheduleENet, pficMarkToMarket: wired.pficMarkToMarket, otherIncome: wired.otherIncome });

  const statement = dual
    ? dualStatusStatement(
        residency.from!,
        usDualStatusDividendItems({ fromYmd: `${taxYear}-01-01`, throughYmd: addDays(residency.from!, -1) }),
        usDividendWithholdingRateForChileanResident
      )
    : null;
  const withholding1042S = Math.round(dividends.filter((x) => x.usWithholdingForm === "1042-S").reduce((s, x) => s + x.usWithheldUsd, 0));
  const withholding1099 = Math.round(dividends.filter((x) => x.usWithholdingForm === "1099-DIV").reduce((s, x) => s + x.usWithheldUsd, 0));

  const ordinaryTax = (t: number) => usForm1040Tax(t, filingStatus, lawYear);
  const netGain = scheduleDNetCapitalGainForWorksheet(d);
  let worksheet: QdcgWorksheet | null = null;
  const taxOn = (taxable: number) => {
    let tax: number;
    if (b.qualifiedDividends > 0 || netGain > 0) {
      worksheet = qualifiedDividendsWorksheet({
        taxableIncome: taxable,
        qualifiedDividends: b.qualifiedDividends,
        netCapitalGain: netGain,
        edges: law.capitalGainBrackets[filingStatus],
        taxOn: ordinaryTax,
      });
      tax = worksheet["25"];
    } else {
      worksheet = null;
      tax = ordinaryTax(taxable);
    }
    return tax + (statement?.tax ?? 0);
  };
  const inputs = (otherTaxes23: number): F1040Inputs => ({
    wages1a: w2.wages,
    taxExemptInterest2a: 0,
    interest2b: b.line4,
    qualifiedDividends3a: b.qualifiedDividends,
    ordinaryDividends3b: b.line6,
    capitalGain7: d.form1040Line7,
    additionalIncome8: s1["10"],
    adjustments10: s1["26"],
    deduction12: dual ? 0 : law.standardDeduction[filingStatus],
    qbiDeduction13: 0,
    additionalDeductions13b: 0,
    taxOn,
    schedule2Part1_17: 0,
    childTaxCredit19: 0,
    schedule3Nonrefundable20: wired.foreignTaxCredit,
    otherTaxes23,
    withholdingW2_25a: w2.federalWithheld,
    withholding1099_25b: withholding1099,
    withholdingOther25c: w2.additionalMedicareWithheld + withholding1042S + (statement?.withheld ?? 0),
    schedule3Credits31: w2.excessSocialSecurity,
  });
  // Form 8960 reads AGI (line 11), which no tax line feeds: a first pass gives it.
  const agi = computeF1040Lines(inputs(0))["11"];
  const niit = form8960({
    taxableInterest: b.line4,
    ordinaryDividends: b.line6,
    rentalNet: wired.nii.rentalNet,
    capitalGain: d.form1040Line7,
    pficInclusions: wired.nii.pficInclusions,
    other: wired.nii.other,
    magi: agi,
    threshold: law.niitThreshold[filingStatus],
    rate: law.niitRate,
  });
  const s2 = schedule2({ additionalMedicareTax: Math.round(w2.additionalMedicareTax), netInvestmentIncomeTax: niit["17"] });
  const computed: F1040Lines = computeF1040Lines(inputs(s2["21"]));
  // A line the year's form does not print (13b before 2025) is left out (it is 0: no Schedule 1-A is drafted).
  const lines: F1040Lines = Object.fromEntries(Object.entries(computed).filter(([l]) => f1040YearHasLine(l as F1040Line, taxYear)));

  const notes: F1040Note[] = ["no_state_return"];
  if (undeclared) notes.push("residency_undeclared");
  else {
    if (dual) notes.push("dual_status", "dual_status_statement_tax_line_16");
    if (withholding1042S > 0 || (statement?.withheld ?? 0) > 0) notes.push("withholding_1042s_line_25c");
    if (b.qualifiedDividends > 0) notes.push("qualified_holding_period_not_tested");
    notes.push("no_step_up_on_residency", "wash_sales_not_modelled", "pfic_outside_schedule_d", "treaty_pensions_deferred", "fx_daily_spot", "section_988_not_modelled", "form_2210_not_modelled", "schedules_not_wired", "foreign_accounts_month_end");
  }
  if (provisional) notes.push("open_year");
  if (lawYear !== taxYear) notes.push("law_provisional");

  return {
    taxYear,
    provisional,
    lawYear,
    filingStatus,
    residency,
    residentWindow,
    stubs: stubs.length,
    w2s,
    interest,
    dividends,
    scheduleB: b,
    form8949: rows,
    scheduleD: d,
    capitalLossCarryoverIn: carryIn,
    capitalLossCarryoverOut: capitalLossCarryoverOut(d, (lines["11"] ?? 0) - (lines["14"] ?? 0)),
    qdcgWorksheet: worksheet,
    schedule1: s1,
    schedule2: s2,
    form8960: niit,
    dualStatusStatement: statement,
    withholding1042S,
    foreignTaxWithheldUsd: cents(dividends.reduce((s, x) => s + x.foreignTaxUsd, 0)),
    foreignAccounts,
    lines,
    fica: w2.fica,
    additionalMedicareTax: w2.additionalMedicareTax,
    filed: filedF1040(taxYear),
    notes,
  };
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The 1040's lines from a year's W-2s and its taxable interest alone (`interestUsd`, line 2b; 0
 * when absent), for a full-year resident under `lawYear`'s law (pure). The demo generator's own first
 * estimate of a year's settlement (`simulate.ts`, which only seeds the first pass of its April loop)
 * uses it; the draft composes the full return.
 */
export function f1040LinesFromW2s(
  w2s: readonly UsW2[],
  filingStatus: UsFilingStatus,
  lawYear: number,
  label: string,
  other: { interestUsd?: number } = {}
): { lines: ReturnType<typeof computeF1040Lines>; additionalMedicareTax: number; fica: { socialSecurity: number; medicare: number } } {
  const law = usTaxYear(lawYear);
  const w2 = w2Figures(w2s, filingStatus, law, label);
  const interestUsd = other.interestUsd ?? 0;
  if (!(interestUsd >= 0)) throw new Error(`1040 ${label}: taxable interest ${interestUsd} is not a non-negative amount`);
  const lines = computeF1040Lines({
    wages1a: w2.wages,
    taxExemptInterest2a: 0,
    interest2b: Math.round(interestUsd),
    qualifiedDividends3a: 0,
    ordinaryDividends3b: 0,
    capitalGain7: 0,
    additionalIncome8: 0,
    adjustments10: 0,
    deduction12: law.standardDeduction[filingStatus],
    qbiDeduction13: 0,
    additionalDeductions13b: 0,
    taxOn: (taxable) => usForm1040Tax(taxable, filingStatus, lawYear),
    schedule2Part1_17: 0,
    childTaxCredit19: 0,
    schedule3Nonrefundable20: 0,
    otherTaxes23: Math.round(w2.additionalMedicareTax),
    withholdingW2_25a: w2.federalWithheld,
    withholding1099_25b: 0,
    withholdingOther25c: w2.additionalMedicareWithheld,
    schedule3Credits31: w2.excessSocialSecurity,
  });
  return { lines, additionalMedicareTax: w2.additionalMedicareTax, fica: w2.fica };
}
