/**
 * Payroll deductions that are spending, as expense lines (`source: "payslip"`): health (the legal
 * 7 % and the Isapre top-up) and the employer life insurance under «Salud», the AFP's commission
 * (the printed AFP line less the mandatory 10 % of the taxable base) under «Comisiones AFP», the
 * income tax withheld under «Impuestos», and the USD contract's transfer fee under «Comisiones».
 * The mandatory pension, unemployment and APV contributions are savings (deposits into those
 * accounts) and an advance nets an earlier deposit: none is an expense. A finiquito's combined
 * «cotizaciones de seguridad social» line cannot be split, so it is left out.
 *
 * A US pay stub's federal withholding, Social Security and Medicare are «Impuestos» and its medical,
 * dental and vision premiums «Salud»; its 401(k) and HSA deferrals are savings, and RSUs delivered
 * as shares are pay, neither an expense. Its dollars are shown in pesos at its pay date's rate.
 *
 * Each line is dated to its payslip's month (the month worked, paid on its last day): `expense_month`
 * is the payslip's period, `occurred_on` the day the pay reached the account (the paired deposit, else
 * a USD wire's day, else the month's last day). The category is the deduction's, never editable.
 */
import { db } from "./db.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import type { FlowCcExpenseLineRowDraft } from "./expenseLineTypes.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import { splitPensionLine, type PayrollJurisdiction, type PayslipLineKind, type PayslipLineSide } from "./payslipLineKinds.js";
import { usPayslipClpPerUsd } from "./payrollUsdRate.js";
import { withLineMoney } from "./lineMoney.js";
import type { LineUnitValue, Money } from "nw-tracker-contracts/dto/flows";

/** `statement_line_id` of a payslip line: payslip id × this + the line's position (unique, positive). */
export const PAYSLIP_EXPENSE_LINE_ID_FACTOR = 1000;

const CATEGORY_BY_KIND: Partial<Record<PayslipLineKind, string>> = {
  health: "healthcare",
  health_additional: "healthcare",
  life_insurance: "healthcare",
  income_tax: "taxes",
  transfer_fee: "fees",
  federal_income_tax: "taxes",
  social_security_tax: "taxes",
  medicare_tax: "taxes",
  health_premium: "healthcare",
  dental_vision: "healthcare",
};

type PayslipRow = {
  id: number;
  period_month: string;
  employer_name: string;
  jurisdiction: PayrollJurisdiction;
  pay_date: string | null;
  liquido_currency: "clp" | "usd"; // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
  total_imponible_clp: number | null;
  total_haberes_clp: number | null;
  paid_on: string | null;
};

type LineRow = { payslip_id: number; position: number; side: PayslipLineSide; kind: PayslipLineKind | null; label: string; amount: number };

function monthEnd(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** A payslip's deduction line with what dates and converts it. */
type PayslipDeduction = {
  payslip: PayslipRow;
  line: LineRow & { kind: PayslipLineKind };
  /** The day the pay reached the account (the paired deposit, else a USD wire's day, else the month's last day). */
  day: string;
  /** Pesos per unit of the line's amount (1 on a peso payslip). */
  pesosPerUnit: number;
};

/** Every deduction line of every payslip, in payslip and position order. */
function loadPayslipDeductions(): PayslipDeduction[] {
  const payslips = db
    .prepare(
      `SELECT p.id, p.period_month, p.employer_name, p.jurisdiction, p.pay_date, p.liquido_currency, p.total_imponible_clp, p.total_haberes_clp,
              COALESCE(m.occurred_on, p.wire_received_on) AS paid_on
         FROM payroll_work_earnings p LEFT JOIN movements m ON m.id = p.movement_id
        ORDER BY p.period_month, p.id`
    )
    .all() as PayslipRow[];
  const linesBy = new Map<number, LineRow[]>();
  for (const l of db
    .prepare(`SELECT payslip_id, position, side, kind, label, amount FROM payslip_lines ORDER BY payslip_id, position`)
    .all() as LineRow[]) {
    const list = linesBy.get(l.payslip_id) ?? [];
    list.push(l);
    linesBy.set(l.payslip_id, list);
  }

  const out: PayslipDeduction[] = [];
  for (const p of payslips) {
    const lines = linesBy.get(p.id) ?? [];
    const day = p.paid_on ?? p.pay_date ?? monthEnd(p.period_month);
    // A dollar payslip's lines are in dollars: a US pay stub at its pay date's rate, the Chilean
    // USD contract at the rate its stored peso gross gives.
    let pesosPerUnit = 1;
    if (p.jurisdiction === "us") {
      if (p.pay_date == null) throw new Error(`payslip ${p.id}: a US payslip without its pay date`);
      pesosPerUnit = usPayslipClpPerUsd(p.pay_date, p.id);
    } else if (p.liquido_currency === "usd") { // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      const grossUsd = lines.filter((l) => l.side === "haber").reduce((s, l) => s + l.amount, 0);
      if (p.total_haberes_clp == null || !(grossUsd > 0)) throw new Error(`payslip ${p.id}: a dollar payslip without its peso gross`);
      pesosPerUnit = p.total_haberes_clp / grossUsd;
    }
    for (const l of lines) {
      if (l.side !== "descuento") continue;
      if (l.kind == null) throw new Error(`payslip ${p.id}: a line without a kind — re-run the payslip import`);
      out.push({ payslip: p, line: { ...l, kind: l.kind }, day, pesosPerUnit });
    }
  }
  return out;
}

/** The mandatory 10 % of a printed AFP line and the AFP's commission (the rest). */
function splitPayslipPensionLine(d: PayslipDeduction): { mandatory: number; commission: number } {
  if (d.payslip.total_imponible_clp == null) {
    throw new Error(`payslip ${d.payslip.id}: an AFP line without a taxable base to split it`);
  }
  return splitPensionLine(d.line.amount, d.payslip.total_imponible_clp);
}

export function loadPayslipExpenseLineDrafts(): FlowCcExpenseLineRowDraft[] {
  const out: FlowCcExpenseLineRowDraft[] = [];
  for (const d of loadPayslipDeductions()) {
    const { payslip: p, line: l, day, pesosPerUnit } = d;
    let category: string | undefined;
    let amount = l.amount;
    let label = l.label;
    if (l.kind === "pension") {
      amount = splitPayslipPensionLine(d).commission;
      category = "pension_fees";
      label = "Comisión AFP";
    } else {
      category = CATEGORY_BY_KIND[l.kind];
    }
    if (!category || amount <= 0) continue;
    const amountClp = Math.round(amount * pesosPerUnit);
    const amountUsd = p.liquido_currency === "usd" ? amount : null; // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
    const merchant = `${label} · ${p.employer_name}`;
    out.push({
      source: "payslip",
      pre_tax: true,
      statement_line_id: p.id * PAYSLIP_EXPENSE_LINE_ID_FACTOR + l.position,
      account_id: 0,
      expense_month: p.period_month,
      billing_month: p.period_month,
      purchase_month: p.period_month,
      occurred_on: day,
      purchase_on: day,
      statement_date: "",
      amount_clp: amountClp,
      amount_usd: amountUsd,
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, amountUsd, day),
      merchant,
      merchant_key: normalizeCcExpenseMerchantKey(merchant),
      category_slug: category,
      category_unique: true,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      line_role: "purchase",
      origin_card_last4: null,
      primary_card_last4: null,
    });
  }
  return out;
}

/**
 * Where a payslip's savings deduction went: an account only payroll funds (the AFP, the AFC, a
 * 401(k), an HSA: `PAYROLL_FUNDED_KINDS`, whose inflows never pass through checking) or a voluntary
 * pension account (an APV, which checking can fund too, so its deposits are ordinary ones).
 */
export type PayslipSavingsDestination = "payroll_account" | "voluntary_account";

const SAVINGS_DESTINATION_BY_KIND: Partial<Record<PayslipLineKind, PayslipSavingsDestination>> = {
  pension: "payroll_account",
  unemployment: "payroll_account",
  retirement_401k_pretax: "payroll_account",
  retirement_401k_roth: "payroll_account",
  hsa: "payroll_account",
  voluntary_pension: "voluntary_account",
};

/** A payslip deduction that is saving, with its money (`lineValueIn` reads it in any unit). */
export type PayslipSavingsLine = {
  payslip_id: number;
  position: number;
  destination: PayslipSavingsDestination;
  /** The payslip's period (the month worked). */
  expense_month: string;
  /** The day the pay reached the account. */
  occurred_on: string;
  amount?: Money;
  values?: Record<string, LineUnitValue>;
};

/**
 * Payroll deductions that are saving: the mandatory pension contribution (the printed AFP line
 * less the AFP's commission, never more than the line), the worker's unemployment-insurance share, an APV, and a US stub's
 * 401(k) and HSA deferrals. The flows overview counts them as income that went straight into a
 * deposit. Dated and converted like the payslip's expense lines. A finiquito's combined
 * «cotizaciones de seguridad social» line cannot be split and is left out, as there.
 */
export function loadPayslipSavingsLines(): PayslipSavingsLine[] {
  const drafts: (PayslipSavingsLine & { amount_clp: number; amount_usd: number | null; amount_usd_at_expense: number | null })[] = [];
  for (const d of loadPayslipDeductions()) {
    const { payslip: p, line: l, day, pesosPerUnit } = d;
    const destination = SAVINGS_DESTINATION_BY_KIND[l.kind];
    if (!destination) continue;
    let amount = l.amount;
    if (l.kind === "pension") {
      // The taxable base is pesos: an AFP line printed in dollars cannot be split against it.
      if (pesosPerUnit !== 1) throw new Error(`payslip ${p.id}: an AFP line on a dollar payslip — its saving cannot be told from the commission`);
      // Never more than the payslip deducted (a line below the mandatory 10 % has no commission).
      amount = Math.min(l.amount, splitPayslipPensionLine(d).mandatory);
    }
    if (amount <= 0) continue;
    const amountClp = Math.round(amount * pesosPerUnit);
    const amountUsd = p.liquido_currency === "usd" ? amount : null; // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
    drafts.push({
      payslip_id: p.id,
      position: l.position,
      destination,
      expense_month: p.period_month,
      occurred_on: day,
      amount_clp: amountClp,
      amount_usd: amountUsd,
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, amountUsd, day),
    });
  }
  return withLineMoney(drafts).map(({ amount_clp: _clp, amount_usd: _usd, amount_usd_at_expense: _usdAt, ...line }) => line);
}
