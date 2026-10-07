import { billingMonthForStatementDate } from "./ccBillingMonth.js";
import { BILLS_CC_EXPENSE_SLUG, countsTowardCcExpenseGastosMes } from "./ccExpenseCategories.js";
import {
  listCcFacturadoFinancingLinks,
  type CcFacturadoFinancingLink,
} from "./ccFacturadoFinancingLinksDb.js";
import {
  hasSplittableMortgageExpenseDepositLink,
  type ExpenseDepositLinkDto,
} from "./expenseDepositLinks.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { isPdfStatementSource } from "./ccManualBillingMonth.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";

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
 *   synthetic lines carrying `L_i`'s category), and the financing's cost — Σ cuotas minus the
 *   closed statement's `monto_facturado`, the pesos the cuotas actually paid — is added as a
 *   `bills` line per month so it isn't lost. Never Σ cuotas − Σ financed lines: cuotas the
 *   financed card billed inside that month stay on that card and a nota de crédito nets the
 *   facturado, so both would read as ± interest (the ·0101 August-2026 link printed 3x.xxx of
 *   phantom «bills» that way). No closed statement yet → no evidence of interest → no gap line.
 *
 * Projected slices are display derivations: their category is read from the source line at build
 * time, so they carry `category_statement_line_id` = the source's real statement line id and the
 * category PATCH targets that line (the synthetic ids here are not PATCHable). Gap lines have no
 * single source line and keep a null anchor. A slice's `installment_total_clp` is the source
 * expense's full amount, so the table's «/$total» superscript reads like a plan cuota; gap lines
 * carry none.
 *
 * Grand totals: total mode = `F` (Σ financed expenses); cuotas mode = `F` + the interest gap,
 * which is `T` (Σ financing cuotas) whenever the facturado consists of the financed purchase lines
 * alone.
 */

/**
 * Resolver for the facturado a link's financing paid (CLP), injectable so the projection stays a
 * pure function of its inputs in tests. Null = no closed statement for that month yet.
 */
export type FacturadoClpResolver = (
  financedAccountId: number,
  financedBillingMonth: string
) => number | null;

/**
 * `monto_facturado` of the financed account's closed CLP statement for a billing month — the peso
 * amount the financing actually paid. Billing month = the statement date's month, the same rule
 * the expense lines use. Null while the month has no closed statement (the open web-paste bucket
 * is not one); duplicate copies of one statement collapse on their identical total, but two closed
 * statements that disagree on it throw — an inconsistent ledger, never something to average.
 */
export function statementFacturadoClpForBillingMonth(
  accountId: number,
  billingMonth: string
): number | null {
  const rows = db
    .prepare(
      `SELECT statement_date, source_pdf, monto_facturado FROM cc_statements
       WHERE account_id = ? AND currency = 'clp' AND monto_facturado IS NOT NULL`
    )
    .all(accountId) as { statement_date: string; source_pdf: string; monto_facturado: number }[];
  const totals = new Set<number>();
  for (const r of rows) {
    if (!isPdfStatementSource(r.source_pdf)) continue;
    const iso = parseDdMmYyToIso(r.statement_date);
    if (!iso || billingMonthForStatementDate(iso) !== billingMonth) continue;
    totals.add(Math.round(r.monto_facturado));
  }
  if (totals.size === 0) return null;
  if (totals.size > 1) {
    throw new Error(
      `account ${accountId} has ${totals.size} closed CLP statements with different monto_facturado for ${billingMonth}: ${[...totals].join(", ")}`
    );
  }
  return [...totals][0]!;
}

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
    categoryUnique: boolean;
    /** Source line the category PATCH redirects to; null for gap lines (no single source). */
    categoryStatementLineId: number | null;
    /** Plan-style total for the «/$total» superscript: the source expense's amount; null for gap lines. */
    installmentTotalClp: number | null;
    merchant: string | null;
    merchantKey: string;
    purchaseKey: string;
    expenseDepositLinks?: ExpenseDepositLinkDto[];
  }
): FlowCcExpenseLineRow {
  const occurredOn = `${overrides.month}-28`;
  // USD allocates by CLP share of the base line (same FX date), so month slices sum back
  // to the base USD; gap lines convert at the anchor's implied rate the same way.
  let amountUsdAtExpense: number | null = null;
  if (base.amount_usd_at_expense != null) {
    if (base.amount_clp === 0) {
      throw new Error(
        `cannot project USD amounts from ${base.source}:${base.statement_line_id}: amount_clp is 0`
      );
    }
    amountUsdAtExpense = base.amount_usd_at_expense * (overrides.amountClp / base.amount_clp);
  }
  return {
    ...base,
    source: "cc",
    statement_line_id: overrides.statementLineId,
    expense_month: overrides.month,
    billing_month: overrides.month,
    purchase_month: overrides.month,
    occurred_on: occurredOn,
    purchase_on: occurredOn,
    statement_date: "",
    amount_clp: overrides.amountClp,
    amount_usd: null,
    amount_usd_at_expense: amountUsdAtExpense,
    merchant: overrides.merchant,
    merchant_key: overrides.merchantKey,
    category_slug: overrides.categorySlug,
    category_unique: overrides.categoryUnique,
    installment_flag: 1,
    installment_total_clp: overrides.installmentTotalClp,
    nro_cuota_current: overrides.cuotaCurrent,
    nro_cuota_total: overrides.cuotaTotal,
    line_role: "installment_cuota",
    gastos_scope: "split_only",
    nota_credito_role: undefined,
    category_statement_line_id: overrides.categoryStatementLineId,
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
  links: CcFacturadoFinancingLink[] = listCcFacturadoFinancingLinks(),
  facturadoClpFor: FacturadoClpResolver = statementFacturadoClpForBillingMonth
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
    // Interest = what the cuotas add on top of the facturado they paid; up to one peso per cuota
    // is rounding (each cuota rounds on its own), and a facturado only partly financed (gap < 0)
    // has no cost to show.
    const facturado = facturadoClpFor(link.financed_account_id, link.financed_billing_month);
    const gap = facturado == null ? 0 : totalCuotas - facturado;

    for (const i of financedIdx) scopeByIndex.set(i, "total_only");
    for (const i of financingAllIdx) scopeByIndex.set(i, "excluded");

    // Per financed expense: divide L_i equally across the n months, preserving face value.
    for (const i of financedIdx) {
      const src = lines[i]!;
      const srcCategoryAnchorId =
        src.statement_line_id > 0
          ? src.statement_line_id
          : src.category_statement_line_id ?? null;
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
              categoryUnique: src.category_unique,
              categoryStatementLineId: srcCategoryAnchorId,
              installmentTotalClp: src.amount_clp,
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
            categoryUnique: src.category_unique,
            categoryStatementLineId: srcCategoryAnchorId,
            installmentTotalClp: src.amount_clp,
            merchant: src.merchant,
            merchantKey: src.merchant_key,
            purchaseKey: `financing-proj:${link.id}:${src.purchase_key}:${m}`,
          })
        );
      });
    }

    // Financing interest gap as a `bills` line per month.
    if (gap > n) {
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
            categoryUnique: false,
            categoryStatementLineId: null,
            installmentTotalClp: null,
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
