/**
 * The demo person's tax documents and returns, written the way a real year produces them:
 *
 * - the boletas de honorarios issued (`sii_issued_fee_receipts`, the SII's own record);
 * - each foreign dividend's gross and US withholding (a broker statement, `movement_dividend_details`):
 *   15 % at the Chilean broker (W-8BEN), none at the US broker (W-9);
 * - in March, the third parties' DJs (`sii_informed_dj`): the employer's 1887 (from the imported
 *   liquidaciones, as `payrollTaxYear` rebuilds it), the AFP's 1899 (APV régimen B, in UF), the
 *   lender's 1898 (mortgage interest, actualizada) and the bank's 1890 (the real interest of the
 *   term deposits that matured in the year);
 * - in April, first each US tax year's Form 1040 (`buildF1040Draft`): its line 37 is paid from US
 *   checking on the 15th, its 35a refunded there about three weeks after filing, and the return is
 *   stored as filed (`recordFiledF1040`) with its settlement linked (`linkF1040Settlement`);
 * - then the F22 the tax module drafts (`buildF22Draft`), whose foreign-salary credit reads that
 *   1040's tax: its 305 plus the pension contributions on fees the SII charges (code 900, which the
 *   module does not draft) is what the person pays or gets back, and the form is stored as filed once
 *   April has passed.
 *
 * The generator runs the simulation until every April settlement it booked is the tax module's
 * figure (`aprilSettlementsFromTaxModule`); see generate.ts.
 */
import { db } from "../db.js";
import { buildF22Draft, type F22Codes } from "../f22Draft.js";
import { mortgageInterestForYear } from "../f22AppEstimates.js";
import { buildF1040Draft } from "../f1040Draft.js";
import { linkF1040Settlement, recordFiledF1040 } from "../f1040Filed.js";
import { payrollTaxYear } from "../payrollTaxYear.js";
import { upsertMovementDividendDetail } from "../movementDividendDetails.js";
import { usRetirementAccountIds } from "../usRetirementAccounts.js";
import { accountsWithRole, propertyLoanPairsWithLoan } from "../accountRoles.js";
import { lenderDisplayName } from "../lenderNames.js";
import { DIVIDEND_WITHHOLDING_RATE, US_IRS_PAYMENT, US_IRS_REFUND, type Ledger } from "./simulate.js";
import type { Ymd } from "./person.js";

/** «1.234.567» — how the SII's DJ summary prints pesos. */
function chileanInteger(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** «12,34» — UF with two decimals. */
function chileanUf(n: number): string {
  const [int, dec] = (Math.round(n * 100) / 100).toFixed(2).split(".");
  return `${chileanInteger(Number(int))},${dec}`;
}

function ufOn(day: Ymd): number {
  const r = db.prepare(`SELECT clp_per_uf AS v FROM uf_daily WHERE date = ?`).get(day) as { v: number } | undefined;
  if (!r) throw new Error(`demo taxes: no UF for ${day}`);
  return r.v;
}

function writeFeeReceipts(ledger: Ledger): void {
  const ins = db.prepare(
    `INSERT INTO sii_issued_fee_receipts (number, issued_on, payer_name, gross_clp, retention_clp, retained_by, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const sorted = [...ledger.feeReceipts].sort((a, b) => a.issuedOn.localeCompare(b.issuedOn));
  sorted.forEach((r, i) => ins.run(i + 1, r.issuedOn, r.payer, r.grossClp, r.retentionClp, r.retainedBy, `demo/boleta-${i + 1}.pdf`));
}

/**
 * The broker statement's split of each dividend. At the Chilean broker gross = net ÷ (1 − 15 %),
 * withholding = gross − net; the US broker (the account holding `broker_cash` `ibkr|usd`) pays it
 * whole to a US person. A Roth IRA's dividend is no document: the custodian issues no 1099-DIV for
 * growth inside the IRA, and no return declares it (`usRetirementAccountIds`).
 */
function writeDividendDetails(): void {
  const usBroker = new Set(accountsWithRole("broker_cash", "ibkr|usd"));
  const roth = new Set(usRetirementAccountIds("roth_ira"));
  const rows = db
    .prepare(
      `SELECT id, amount, occurred_on, from_account_id, to_account_id FROM movements WHERE flow_kind = 'dividend_payout' AND currency = 'usd' ORDER BY occurred_on, id`
    )
    .all() as { id: number; amount: number; occurred_on: string; from_account_id: number | null; to_account_id: number | null }[];
  for (const r of rows) {
    if (r.from_account_id != null && roth.has(r.from_account_id)) continue;
    const atUsBroker = r.to_account_id != null && usBroker.has(r.to_account_id);
    const rate = atUsBroker ? 0 : DIVIDEND_WITHHOLDING_RATE;
    const gross = Math.round((r.amount / (1 - rate)) * 100) / 100;
    const withholding = Math.round((gross - r.amount) * 100) / 100;
    upsertMovementDividendDetail({
      movement_id: r.id,
      gross_amount: gross,
      withholding_amount: withholding,
      currency: "usd",
      withholding_rate_pct: rate * 100,
      withholding_jurisdiction: atUsBroker ? null : "US",
      tax_residency_country: atUsBroker ? "USA" : "CHL",
      pay_date: r.occurred_on,
      source: "ibkr_statement",
      source_ref: `demo ${atUsBroker ? "US" : "Chilean"} broker statement ${r.occurred_on.slice(0, 7)}`,
    });
  }
}

/**
 * The real interest of the term deposits that matured in `incomeYear` (art. 41 bis): the interest
 * less the UF's move on the principal over each deposit, split as DJ 1890 reports it.
 */
export function termDepositRealInterest(ledger: Ledger, incomeYear: number): { positive: number; negative: number; deposits: number } {
  let positive = 0;
  let negative = 0;
  let deposits = 0;
  for (const t of ledger.termDeposits) {
    if (!t.paid || !t.maturity.startsWith(`${incomeYear}-`)) continue;
    const real = t.payout - t.principal - t.principal * (ufOn(t.maturity) / ufOn(t.open) - 1);
    if (real >= 0) positive += real;
    else negative -= real;
    deposits += 1;
  }
  return { positive: Math.round(positive), negative: Math.round(negative), deposits };
}

/** The income years whose April settlement the simulation reached (the month loop got to April). */
function settledIncomeYears(ledger: Ledger): number[] {
  return [...ledger.aprilSettlements.keys()].sort((a, b) => a - b);
}

/** Every income year with any taxable activity the module could see, through last year. */
function incomeYearsToDraft(ledger: Ledger, today: Ymd): number[] {
  const first = Number(ledger.person.firstMonth.slice(0, 4));
  const last = Number(today.slice(0, 4)) - 1;
  const out: number[] = [];
  for (let y = Math.max(first, 2017); y <= last; y++) {
    // The settlement is in April of the next year: only years whose April the simulation reached.
    if (`${y + 1}-04` <= today.slice(0, 7)) out.push(y);
  }
  return out;
}

/** The third parties' DJs about an income year, filed in March of the next. */
function writeInformedDjs(ledger: Ledger, today: Ymd): void {
  const ins = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, ?, ?, ?, ?)`);
  for (const y of incomeYearsToDraft(ledger, today)) {
    const taxYear = y + 1;
    if (`${taxYear}-03-31` > today) continue;
    const salary = payrollTaxYear(y);
    if (salary.months > 0) {
      if (salary.incompleteMonths.length > 0) {
        throw new Error(`demo taxes: ${y} has payslips without totals (${salary.incompleteMonths.join(", ")})`);
      }
      const file = `demo/DJ_1887_${taxYear}.xlsx`;
      ins.run(taxYear, 1887, "A: Renta Total Neta Pagada (Art.42 N°1, Ley de la Renta)", chileanInteger(salary.taxablePayClp), file);
      ins.run(taxYear, 1887, "B: Impuesto Unico Retenido", chileanInteger(salary.withheldTaxClp), file);
    }
    const apv = ledger.apvBDeposits.filter((d) => d.date.startsWith(`${y}-`));
    if (apv.length > 0) {
      const uf = apv.reduce((s, d) => s + d.clp / ufOn(d.date), 0);
      ins.run(taxYear, 1899, "I: Ahorro previsional voluntario / Régimen B / Monto (UF)", chileanUf(uf), `demo/DJ_1899_${taxYear}.xlsx`);
    }
    const dap = termDepositRealInterest(ledger, y);
    if (dap.deposits > 0) {
      const file = `demo/DJ_1890_${taxYear}.xlsx`;
      ins.run(taxYear, 1890, "B: Intereses Reales / Positivo", chileanInteger(dap.positive), file);
      ins.run(taxYear, 1890, "C: Intereses Reales / Negativo", chileanInteger(dap.negative), file);
    }
    // Each lender files its own DJ 1898; the summary prints one column per lender, headed by the
    // lender's name (the loan's lender role, `lenderNames.ts`), never the app's loan account.
    const lenders = propertyLoanPairsWithLoan()
      .map((p) => ({ loan: p.loanAccountId, interest: mortgageInterestForYear(y, p.loanAccountId) }))
      .filter((x) => x.interest > 0);
    lenders.forEach((x, i) => {
      ins.run(
        taxYear,
        1898,
        `${String.fromCharCode(65 + i)}: ${lenderDisplayName(x.loan)} / Monto Actualizado de los Intereses Pagados ($) en Dividendo`,
        chileanInteger(x.interest),
        `demo/DJ_1898_${taxYear}.xlsx`
      );
    });
  }
}

/** Everything a year's documents state, before its April. */
export function writeDemoTaxDocuments(ledger: Ledger, today: Ymd): void {
  db.transaction(() => {
    writeFeeReceipts(ledger);
    writeDividendDetails();
    writeInformedDjs(ledger, today);
  })();
}

/** The contributions on fees the SII charged inside a year's settlement (code 900). */
function contributionsCharged(ledger: Ledger, incomeYear: number): number {
  return ledger.aprilSettlements.get(incomeYear)?.contributionsClp ?? 0;
}

/**
 * What the tax module says each income year settles in April: its 305 (0 when it computes no tax)
 * plus the contributions charged. Years the module sees nothing in and the simulation did not
 * settle are left out.
 */
export function aprilSettlementsFromTaxModule(ledger: Ledger, today: Ymd): Map<number, number> {
  const out = new Map<number, number>();
  for (const y of incomeYearsToDraft(ledger, today)) {
    const d = buildF22Draft(y + 1, today);
    const r305 = d.taxComputed ? (d.draft[305] ?? 0) : 0;
    const total = r305 + contributionsCharged(ledger, y);
    if (total !== 0 || ledger.aprilSettlements.has(y)) out.set(y, total);
  }
  return out;
}

/** The US tax years whose April the simulation reached (it filed their 1040). */
function usTaxYearsToFile(ledger: Ledger, today: Ymd): number[] {
  return [...ledger.usAprilSettlements.entries()]
    .filter(([, s]) => s.filedOn <= today)
    .map(([y]) => y)
    .sort((a, b) => a - b);
}

/** What the 1040 module says each US tax year settles: line 37 − line 35a, dollars. */
export function usAprilSettlementsFromTaxModule(ledger: Ledger, today: Ymd): Map<number, number> {
  const out = new Map<number, number>();
  for (const y of usTaxYearsToFile(ledger, today)) {
    const lines = buildF1040Draft(y, today).lines;
    out.set(y, (lines["37"] ?? 0) - (lines["35a"] ?? 0));
  }
  return out;
}

/** The US tax years whose booked 1040 settlement differs from the module's. */
export function usSettlementDifferences(
  ledger: Ledger,
  module: ReadonlyMap<number, number>
): { year: number; booked: number; module: number }[] {
  const years = new Set([...usTaxYearsToFile(ledger, ledger.today), ...module.keys()]);
  return [...years]
    .sort((a, b) => a - b)
    .map((year) => ({ year, booked: ledger.usAprilSettlements.get(year)?.usd ?? 0, module: module.get(year) ?? 0 }))
    .filter((x) => x.booked !== x.module);
}

/**
 * The 1040s as filed, with the US checking movement that settled each (the IRS payment or refund),
 * before the F22s: the F22's foreign-salary credit reads the filed return's tax.
 */
export function writeDemoFiledUsReturns(ledger: Ledger, today: Ymd): void {
  for (const y of usTaxYearsToFile(ledger, today)) {
    const settlement = ledger.usAprilSettlements.get(y)!;
    const draft = buildF1040Draft(y, today);
    recordFiledF1040({ taxYear: y, filingStatus: draft.filingStatus, filedOn: settlement.filedOn, sourceFile: `demo/F1040_${y}.pdf`, lines: draft.lines });
    if (settlement.usd === 0 || settlement.settledOn > today) continue;
    const desc = settlement.usd > 0 ? US_IRS_PAYMENT : US_IRS_REFUND;
    const rows = db
      .prepare(`SELECT id FROM movements WHERE currency = 'usd' AND account_id IS NOT NULL AND note LIKE ? AND occurred_on = ? AND amount = ?`)
      .all(`%|${desc}|%`, settlement.settledOn, Math.abs(settlement.usd)) as { id: number }[];
    if (rows.length !== 1) throw new Error(`demo taxes: 1040 ${y} settlement of US$${settlement.usd} matches ${rows.length} movements`);
    linkF1040Settlement({ taxYear: y, movementId: rows[0]!.id, description: desc });
  }
}

/** The years whose booked settlement differs from the module's, with both figures. */
export function settlementDifferences(
  ledger: Ledger,
  module: ReadonlyMap<number, number>
): { year: number; booked: number; module: number }[] {
  const years = new Set([...settledIncomeYears(ledger), ...module.keys()]);
  return [...years]
    .sort((a, b) => a - b)
    .map((year) => ({ year, booked: ledger.aprilSettlements.get(year)?.clp ?? 0, module: module.get(year) ?? 0 }))
    .filter((x) => x.booked !== x.module);
}

/**
 * The returns as filed: every year whose April has passed, the module's draft with the
 * contributions charged (900) and the resulting 305.
 */
export function writeDemoFiledReturns(ledger: Ledger, today: Ymd): void {
  const ins = db.prepare(`INSERT INTO sii_f22_filed (tax_year, code, amount, source_file) VALUES (?, ?, ?, ?)`);
  const drafts: { taxYear: number; codes: F22Codes }[] = [];
  for (const y of incomeYearsToDraft(ledger, today)) {
    const taxYear = y + 1;
    if (`${taxYear}-04-30` > today) continue;
    const d = buildF22Draft(taxYear, today);
    if (!d.taxComputed) continue;
    const contributions = contributionsCharged(ledger, y);
    const codes: F22Codes = { ...d.draft };
    if (contributions > 0) codes[900] = contributions;
    codes[305] = (d.draft[305] ?? 0) + contributions;
    drafts.push({ taxYear, codes });
  }
  // Drafted first, written after: a filed year changes how the next year's draft reads.
  db.transaction(() => {
    for (const { taxYear, codes } of drafts) {
      for (const [code, amount] of Object.entries(codes)) {
        if (amount === 0 && ![304, 305].includes(Number(code))) continue;
        ins.run(taxYear, Number(code), Math.round(amount), `demo/F22_AT${taxYear}.pdf`);
      }
      linkSettlement(taxYear, Math.round(codes[305] ?? 0));
    }
  })();
}

/**
 * The bank movement that settled a filed return: the Tesorería's refund (May / June) or the
 * April payment, for exactly the settlement (`f22_settlements`, as the report-first linker
 * writes it for real returns). A settlement the simulation did not pay yet links nothing.
 */
function linkSettlement(taxYear: number, result305: number): void {
  if (result305 === 0) return;
  const refund = result305 < 0;
  const wording = refund ? "DEVOLUCION IMPUESTO TGR" : "PAGO F22 TGR";
  // A refund is a credit (+), a payment a debit (−): both are −305 in the ledger's sign.
  const signed = -result305;
  const rows = db
    .prepare(
      `SELECT id, account_id, occurred_on, amount, note FROM movements
        WHERE account_id IS NOT NULL AND note LIKE ? AND amount = ? AND occurred_on BETWEEN ? AND ?`
    )
    .all(`%${wording}%`, signed, `${taxYear}-04-01`, `${taxYear}-06-30`) as {
    id: number;
    account_id: number;
    occurred_on: string;
    amount: number;
    note: string;
  }[];
  if (rows.length === 0) return;
  if (rows.length > 1) throw new Error(`demo taxes: AT${taxYear} settlement of ${result305} matches ${rows.length} movements`);
  const m = rows[0]!;
  db.prepare(
    `INSERT INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(taxYear, refund ? "refund" : "payment", m.account_id, m.id, m.occurred_on, Math.abs(m.amount), wording);
}
