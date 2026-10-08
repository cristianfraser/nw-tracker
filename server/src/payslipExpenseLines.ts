/**
 * Payroll deductions that are spending, as expense lines (`source: "payslip"`): health (the legal
 * 7 % and the Isapre top-up) and the employer life insurance under «Salud», the AFP's commission
 * (the printed AFP line less the mandatory 10 % of the taxable base) under «Comisiones AFP», the
 * income tax withheld under «Impuestos», and the USD contract's transfer fee under «Comisiones».
 * The mandatory pension, unemployment and APV contributions are savings (deposits into those
 * accounts) and an advance nets an earlier deposit: none is an expense. A finiquito's combined
 * «cotizaciones de seguridad social» line cannot be split, so it is left out.
 *
 * Each line is dated to its payslip's month (the month worked, paid on its last day): `expense_month`
 * is the payslip's period, `occurred_on` the day the pay reached the account (the paired deposit, else
 * a USD wire's day, else the month's last day). The category is the deduction's, never editable.
 */
import { db } from "./db.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsExpenses.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import { splitPensionLine, type PayslipLineKind } from "./payslipLineKinds.js";

/** `statement_line_id` of a payslip line: payslip id × this + the line's position (unique, positive). */
export const PAYSLIP_EXPENSE_LINE_ID_FACTOR = 1000;

const CATEGORY_BY_KIND: Partial<Record<PayslipLineKind, string>> = {
  health: "healthcare",
  health_additional: "healthcare",
  life_insurance: "healthcare",
  income_tax: "taxes",
  transfer_fee: "fees",
};

type PayslipRow = {
  id: number;
  period_month: string;
  employer_name: string;
  liquido_currency: "clp" | "usd";
  total_imponible_clp: number | null;
  total_haberes_clp: number | null;
  paid_on: string | null;
};

type LineRow = { payslip_id: number; position: number; side: "haber" | "descuento"; kind: PayslipLineKind | null; label: string; amount: number };

function monthEnd(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function loadPayslipExpenseLineDrafts(): FlowCcExpenseLineRowDraft[] {
  const payslips = db
    .prepare(
      `SELECT p.id, p.period_month, p.employer_name, p.liquido_currency, p.total_imponible_clp, p.total_haberes_clp,
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

  const out: FlowCcExpenseLineRowDraft[] = [];
  for (const p of payslips) {
    const lines = linesBy.get(p.id) ?? [];
    const day = p.paid_on ?? monthEnd(p.period_month);
    // A dollar payslip's lines are in dollars; its stored peso gross gives the rate it was paid at.
    let pesosPerUnit = 1;
    if (p.liquido_currency === "usd") {
      const grossUsd = lines.filter((l) => l.side === "haber").reduce((s, l) => s + l.amount, 0);
      if (p.total_haberes_clp == null || !(grossUsd > 0)) throw new Error(`payslip ${p.id}: a dollar payslip without its peso gross`);
      pesosPerUnit = p.total_haberes_clp / grossUsd;
    }
    for (const l of lines) {
      if (l.side !== "descuento") continue;
      if (l.kind == null) throw new Error(`payslip ${p.id}: a line without a kind — re-run the payslip import`);
      let category: string | undefined;
      let amount = l.amount;
      let label = l.label;
      if (l.kind === "pension") {
        if (p.total_imponible_clp == null) throw new Error(`payslip ${p.id}: an AFP line without a taxable base to split it`);
        amount = splitPensionLine(l.amount, p.total_imponible_clp).commission;
        category = "pension_fees";
        label = "Comisión AFP";
      } else {
        category = CATEGORY_BY_KIND[l.kind];
      }
      if (!category || amount <= 0) continue;
      const amountClp = Math.round(amount * pesosPerUnit);
      const amountUsd = p.liquido_currency === "usd" ? amount : null;
      const merchant = `${label} · ${p.employer_name}`;
      out.push({
        source: "payslip",
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
  }
  return out;
}
