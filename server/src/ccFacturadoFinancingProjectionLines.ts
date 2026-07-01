import { BILLS_CC_EXPENSE_SLUG, countsTowardCcExpenseGastosMes } from "./ccExpenseCategories.js";
import {
  listCcFacturadoFinancingLinks,
  type CcFacturadoFinancingLink,
} from "./ccFacturadoFinancingLinksDb.js";
import {
  hasSplittableMortgageExpenseDepositLink,
  type ExpenseDepositLinkDto,
} from "./expenseDepositLinks.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";

/**
 * Facturado-financing projection.
 *
 * A Lider (or other issuer) facturado paid in cuotas via one or more Santander installment
 * purchases is declared as a financing link (see ccFacturadoFinancingLinksDb.ts). For each link:
 *
 * - **Total mode:** the financed purchases keep their real categories in their purchase month;
 *   the financing installment purchases are suppressed (`gastos_scope: "excluded"`).
 * - **Cuotas mode:** the raw financed purchases and raw financing cuotas are hidden; each financed
 *   expense `L_i` is divided equally over the `n` distinct cuota billing months (`split_only`
 *   synthetic lines carrying `L_i`'s category), and the financing interest gap (Σ cuotas −
 *   facturado) is added as a `bills` line per month so it isn't lost.
 *
 * Grand totals: total mode = `F` (Σ financed expenses); cuotas mode = `T` (Σ financing cuotas).
 */

/** Distribute an integer `total` across `n` slots so the slots sum back exactly to `total`. */
function splitIntegerEvenly(total: number, n: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const cum = Math.round((total * k) / n);
    out.push(cum - prev);
    prev = cum;
  }
  return out;
}

/** Base for synthetic projected-line ids — well below the -1e6 range used by installment totals. */
const PROJECTION_SYNTHETIC_ID_BASE = -1_000_000_000;

function makeProjectedLine(
  base: FlowCcExpenseLineRow,
  overrides: {
    statementLineId: number;
    amountClp: number;
    month: string;
    cuotaCurrent: number;
    cuotaTotal: number;
    categorySlug: string;
    merchant: string | null;
    merchantKey: string;
    purchaseKey: string;
    expenseDepositLinks?: ExpenseDepositLinkDto[];
  }
): FlowCcExpenseLineRow {
  const occurredOn = `${overrides.month}-28`;
  return {
    ...base,
    source: "cc",
    statement_line_id: overrides.statementLineId,
    expense_month: overrides.month,
    gastos_period_month: undefined,
    billing_month: overrides.month,
    purchase_month: overrides.month,
    occurred_on: occurredOn,
    purchase_on: occurredOn,
    statement_date: "",
    amount_clp: overrides.amountClp,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: overrides.merchant,
    merchant_key: overrides.merchantKey,
    category_slug: overrides.categorySlug,
    category_unique: false,
    installment_flag: 1,
    nro_cuota_current: overrides.cuotaCurrent,
    nro_cuota_total: overrides.cuotaTotal,
    line_role: "installment_cuota",
    gastos_scope: "split_only",
    nota_credito_role: undefined,
    category_statement_line_id: null,
    purchase_key: overrides.purchaseKey,
    purchase_notes: "",
    expense_deposit_links: overrides.expenseDepositLinks,
  };
}

/**
 * Tag financed / financing lines with `gastos_scope` and append `split_only` projected cuota lines.
 * Returns a new array; input lines are copied (never mutated). No links → input returned as-is.
 */
export function applyCcFacturadoFinancingProjection(
  lines: readonly FlowCcExpenseLineRow[],
  links: CcFacturadoFinancingLink[] = listCcFacturadoFinancingLinks()
): FlowCcExpenseLineRow[] {
  if (links.length === 0) return [...lines];

  // Scope overrides keyed by array index, plus synthetic lines to append.
  const scopeByIndex = new Map<number, "total_only" | "excluded">();
  const projected: FlowCcExpenseLineRow[] = [];
  let nextSyntheticId = PROJECTION_SYNTHETIC_ID_BASE;

  for (const link of links) {
    const financingKeys = new Set(
      link.financing.map((f) => `${f.account_id}|${f.purchase_key}`)
    );

    const financedIdx: number[] = [];
    const financingCuotaIdx: number[] = [];
    const financingAllIdx: number[] = [];

    lines.forEach((ln, i) => {
      const key = `${ln.account_id}|${ln.purchase_key}`;
      if (financingKeys.has(key)) {
        financingAllIdx.push(i);
        if (ln.line_role === "installment_cuota" && ln.nro_cuota_current !== 0 && ln.amount_clp > 0) {
          financingCuotaIdx.push(i);
        }
        return;
      }
      if (
        ln.account_id === link.financed_account_id &&
        ln.billing_month === link.financed_billing_month &&
        ln.line_role === "purchase" &&
        ln.amount_clp > 0 &&
        countsTowardCcExpenseGastosMes(ln.category_slug, {
          installment_flag: ln.installment_flag,
          nro_cuota_current: ln.nro_cuota_current,
        })
      ) {
        financedIdx.push(i);
      }
    });

    if (financedIdx.length === 0 || financingCuotaIdx.length === 0) continue;

    // Distinct cuota billing months (the schedule), sorted.
    const months = [...new Set(financingCuotaIdx.map((i) => lines[i]!.billing_month))].sort();
    const n = months.length;
    const totalCuotas = financingCuotaIdx.reduce((s, i) => s + lines[i]!.amount_clp, 0);
    const facturado = financedIdx.reduce((s, i) => s + lines[i]!.amount_clp, 0);
    const gap = totalCuotas - facturado;

    for (const i of financedIdx) scopeByIndex.set(i, "total_only");
    for (const i of financingAllIdx) scopeByIndex.set(i, "excluded");

    // Per financed expense: divide L_i equally across the n months, preserving face value.
    for (const i of financedIdx) {
      const src = lines[i]!;
      const mortgageLink = src.expense_deposit_links?.find((l) => l.depto_cuota != null);
      if (hasSplittableMortgageExpenseDepositLink(mortgageLink)) {
        // Mortgage line: split each cuota into carrying (bills) + amortization (offset), so the
        // aggregate's mortgage-split branch recognizes it (same handling as in Total mode).
        const carrySlices = splitIntegerEvenly(mortgageLink.carrying_clp, n);
        const amortSlices = splitIntegerEvenly(mortgageLink.amortization_clp, n);
        months.forEach((m, k) => {
          const payment = carrySlices[k]! + amortSlices[k]!;
          projected.push(
            makeProjectedLine(src, {
              statementLineId: nextSyntheticId--,
              amountClp: payment,
              month: m,
              cuotaCurrent: k + 1,
              cuotaTotal: n,
              categorySlug: BILLS_CC_EXPENSE_SLUG,
              merchant: src.merchant,
              merchantKey: src.merchant_key,
              purchaseKey: `financing-proj:${link.id}:${src.purchase_key}:${m}`,
              expenseDepositLinks: [
                {
                  ...mortgageLink,
                  payment_clp: payment,
                  carrying_clp: carrySlices[k]!,
                  amortization_clp: amortSlices[k]!,
                },
              ],
            })
          );
        });
        continue;
      }
      const slices = splitIntegerEvenly(src.amount_clp, n);
      months.forEach((m, k) => {
        projected.push(
          makeProjectedLine(src, {
            statementLineId: nextSyntheticId--,
            amountClp: slices[k]!,
            month: m,
            cuotaCurrent: k + 1,
            cuotaTotal: n,
            categorySlug: src.category_slug,
            merchant: src.merchant,
            merchantKey: src.merchant_key,
            purchaseKey: `financing-proj:${link.id}:${src.purchase_key}:${m}`,
          })
        );
      });
    }

    // Financing interest gap as a `bills` line per month (skip if non-positive).
    if (gap > 0) {
      const gapSlices = splitIntegerEvenly(gap, n);
      const anchor = lines[financedIdx[0]!]!;
      months.forEach((m, k) => {
        if (gapSlices[k] === 0) return;
        projected.push(
          makeProjectedLine(anchor, {
            statementLineId: nextSyntheticId--,
            amountClp: gapSlices[k]!,
            month: m,
            cuotaCurrent: k + 1,
            cuotaTotal: n,
            categorySlug: BILLS_CC_EXPENSE_SLUG,
            merchant: anchor.merchant,
            merchantKey: anchor.merchant_key,
            purchaseKey: `financing-proj-gap:${link.id}:${m}`,
          })
        );
      });
    }
  }

  const out = lines.map((ln, i) => {
    const scope = scopeByIndex.get(i);
    return scope ? { ...ln, gastos_scope: scope } : ln;
  });
  out.push(...projected);
  return out;
}
