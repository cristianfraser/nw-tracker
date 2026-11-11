/**
 * The last step of the expense-line read pipeline (docs/untangle-plan.md F12): what the client
 * used to derive from a line, sent with it — the month it is shown in, which month-modal sections
 * list it in each installment mode, whether it counts toward gasto del mes, and which controls
 * its row offers. The client picks these fields; it keeps no copy of the rules.
 */
import { gastosPeriodMonthForLine, type CcInstallmentGastosMode } from "./ccExpensePeriodMonth.js";
import type { ExpenseMonthModalSection, FlowCcExpenseLineRow, Money } from "nw-tracker-contracts/dto/flows";
import { lineAmount } from "./lineMoney.js";

/**
 * The line this step reads: a finished line, wire or server-side (the server's carries the
 * builder fields beside its money). Its sign is its money's (`lineAmount`), the same in every unit.
 */
export type ShapeLine = Omit<FlowCcExpenseLineRow, "amount" | "values"> & { amount?: Money };

/**
 * The gastos rules a line's shape is read from, passed in by the pipeline (`flowsExpenses.ts`):
 * they live in modules that import the pipeline, so this step takes them instead of importing them.
 */
export type ExpenseLineShapeRules = {
  countsTowardGastosMes: (line: ShapeLine, mode: CcInstallmentGastosMode) => boolean;
  isGastosRefundLine: (line: ShapeLine) => boolean;
  isCcExpenseTotalsExcludedSlug: (slug: string) => boolean;
  isInstallmentCuotaZeroLine: (line: ShapeLine) => boolean;
};

const MODES: readonly CcInstallmentGastosMode[] = ["split", "total"];

function isNotaCreditoExcludedLine(line: ShapeLine): boolean {
  return line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota";
}

/** A negative line shown under «Abonos» (a payment, a credit): not a refund, not a nota pair. */
function isAbonoLine(line: ShapeLine, rules: ExpenseLineShapeRules): boolean {
  if (lineAmount(line).value >= 0 || rules.isGastosRefundLine(line)) return false;
  return line.nota_credito_role !== "matched_nota" && line.nota_credito_role !== "unmatched_nota";
}

/** The month-modal sections that list a line (in its period month) in one installment mode. */
function monthModalSections(
  line: ShapeLine,
  mode: CcInstallmentGastosMode,
  rules: ExpenseLineShapeRules
): ExpenseMonthModalSection[] {
  const sections: ExpenseMonthModalSection[] = [];
  const counts = rules.countsTowardGastosMes(line, mode);
  const cuotaZero = rules.isInstallmentCuotaZeroLine(line);
  const excludedSlug = rules.isCcExpenseTotalsExcludedSlug(line.category_slug);
  if (line.line_role === "installment_cuota") {
    if (!cuotaZero && counts) sections.push("installments");
  } else if (!excludedSlug) {
    // A plan's whole price lists under Compras in «Total» whether or not it counts (an annulled
    // plan is under Excluidos too); a one-shot purchase only when it counts.
    if (line.line_role === "installment_purchase_total" ? mode === "total" : counts) sections.push("purchases");
  }
  if (isAbonoLine(line, rules)) sections.push("abonos");
  const excludedCuota = line.line_role === "installment_cuota" && (cuotaZero || excludedSlug);
  const excludedOther =
    isNotaCreditoExcludedLine(line) ||
    (lineAmount(line).value > 0 && line.line_role !== "installment_cuota" && !counts);
  if (excludedCuota || excludedOther) sections.push("excluded");
  return sections;
}

/** A plain one-shot card purchase: what the row can turn into a plan. */
function isPlainCardPurchase(line: ShapeLine): boolean {
  return (
    line.source === "cc" &&
    line.statement_line_id > 0 &&
    line.line_role === "purchase" &&
    !line.installment_flag &&
    lineAmount(line).value > 0 &&
    line.piece_seq == null &&
    line.pieces_remainder !== true &&
    line.nota_credito_role == null &&
    line.is_financing_cost !== true &&
    (line.gastos_scope ?? "both") === "both"
  );
}

export function withExpenseLineShapes<L extends ShapeLine>(
  lines: readonly L[],
  rules: ExpenseLineShapeRules
): L[] {
  return lines.map((line) => {
    const counts = { split: false, total: false };
    const sections = { split: [] as ExpenseMonthModalSection[], total: [] as ExpenseMonthModalSection[] };
    for (const mode of MODES) {
      counts[mode] = rules.countsTowardGastosMes(line, mode);
      sections[mode] = monthModalSections(line, mode, rules);
    }
    return {
      ...line,
      period_month: gastosPeriodMonthForLine(line),
      counts_toward_gastos: counts,
      month_modal_sections: sections,
      abono: isAbonoLine(line, rules),
      pending_classification:
        line.line_role !== "installment_purchase_total" &&
        lineAmount(line).value > 0 &&
        line.category_slug === "unclassified" &&
        !isNotaCreditoExcludedLine(line),
      can_delete: line.source === "cc" && line.web_paste === true && line.statement_line_id > 0,
      // Only a line of the open cycle (the card feed or a paste) or one the bank lists in cuotas without
      // the count asks for a cuota count; a statement's one-shot line is settled as printed (user
      // decision 2026-11-08, the pre-F12 rule).
      can_make_installment:
        isPlainCardPurchase(line) && (line.cuota_purchase_kind != null || line.web_paste === true),
      can_edit_installment:
        line.source === "cc" && line.installment_source === "manual" && line.installment_purchase_id != null,
      can_edit_pieces:
        (line.source === "cc" || line.source === "checking") &&
        line.statement_line_id > 0 &&
        line.line_role === "purchase" &&
        !line.installment_flag &&
        line.checking_refund !== true &&
        lineAmount(line).value > 0,
    };
  });
}
