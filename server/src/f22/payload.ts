/**
 * The /tax-return page payload: the local F22 for one año tributario as ordered rows (the client
 * only labels and formats them), plus the detail behind the draft's additions.
 */
import { chileWallClockNow } from "../chileDate.js";
import { buildPayslipChecks, payrollWithholdingMonths, payrollWithholdingYear } from "../payslipChecks.js";
import { f22Settlement } from "../f22Settlements.js";
import { db } from "../db.js";
import { portfolioStartYmd } from "../portfolioStart.js";
import { ART107_INR_FROM } from "./art107.js";
import { buildF22Draft } from "./draft.js";
import { PAYMENT_SECTION_CODES } from "./resident.js";
import type { F22OffsetBalance } from "./types.js";
import type { TaxResidencyPeriod } from "../taxResidency.js";

export type F22RowSection =
  | "income"
  | "subtotal"
  | "deduction"
  | "tax"
  | "credit"
  | "result"
  | "memo"
  | "payment"
  | "other";

export type F22PayloadRow = {
  code: number;
  section: F22RowSection;
  filed: number | null;
  informed: number | null;
  draft: number | null;
  /** Both filed and draft present and different (never the payment section, which the draft leaves to the SII). */
  changed: boolean;
  /** Informed by a third party and ≠ filed. */
  informed_mismatch: boolean;
  /** The draft's value is the app's estimate of a code a third party reports later. */
  estimated: boolean;
};

/** Display order of the codes this taxpayer's return uses; any other stored code is appended as `other`. */
const ROW_LAYOUT: readonly [number, F22RowSection][] = [
  [1098, "income"],
  [1030, "income"],
  [547, "memo"],
  [494, "memo"],
  [770, "memo"],
  [110, "income"],
  [105, "income"],
  [1849, "memo"],
  [955, "income"],
  [161, "memo"],
  [155, "income"],
  [1869, "memo"],
  [152, "income"],
  [1878, "memo"],
  [1032, "income"],
  [1104, "income"],
  [748, "income"],
  [1901, "income"],
  [169, "income"],
  [1809, "memo"],
  [1813, "memo"],
  [1814, "memo"],
  [1815, "memo"],
  [1816, "memo"],
  [158, "subtotal"],
  [750, "deduction"],
  [751, "memo"],
  [170, "subtotal"],
  [157, "tax"],
  [32, "tax"],
  [76, "credit"],
  [34, "tax"],
  [951, "tax"],
  [952, "tax"],
  [1829, "tax"],
  [1830, "tax"],
  [833, "credit"],
  [136, "credit"],
  [1637, "credit"],
  [162, "credit"],
  [1018, "credit"],
  [746, "credit"],
  [610, "credit"],
  [198, "credit"],
  [304, "result"],
  [900, "result"],
  [305, "result"],
  [31, "result"],
];

/**
 * Every año tributario from the one declaring the portfolio's first year through the current
 * one (next April's, for this year's income), plus any older year with a filed form — newest
 * first. A year needs no form to be listed: its filed column is then empty.
 */
export function availableF22TaxYears(todayYmd: string = chileWallClockNow().ymd): number[] {
  const current = Number(todayYmd.slice(0, 4)) + 1;
  const first = Number(portfolioStartYmd().slice(0, 4)) + 1;
  const filed = (db.prepare(`SELECT DISTINCT tax_year FROM sii_f22_filed`).all() as { tax_year: number }[]).map(
    (r) => r.tax_year
  );
  const years = new Set(filed);
  for (let y = first; y <= current; y++) years.add(y);
  return [...years].sort((a, b) => b - a);
}

export function filedTaxYears(): number[] {
  return (db.prepare(`SELECT DISTINCT tax_year FROM sii_f22_filed`).all() as { tax_year: number }[]).map((r) => r.tax_year);
}

/** Account names by id, for the detail tables (a tax-lot disposal names its account by id only). */
function accountNamesById(): Map<number, string> {
  const rows = db.prepare(`SELECT id, name FROM accounts`).all() as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function offsetBalancePayload(o: F22OffsetBalance) {
  return {
    gains_clp: o.gainsClp,
    losses_clp: o.lossesClp,
    deducted_clp: o.deductedClp,
    unused_loss_clp: o.unusedLossClp,
    taxed_gain_clp: o.taxedGainClp,
    tax_effect_clp: o.taxEffectClp,
  };
}

export function buildF22Payload(taxYear: number) {
  const d = buildF22Draft(taxYear);
  const accountNames = accountNamesById();
  const accountName = (id: number) => {
    const name = accountNames.get(id);
    if (name == null) throw new Error(`F22 payload: no account ${id}`);
    return name;
  };
  const all = new Set([...Object.keys(d.filed ?? {}), ...Object.keys(d.informed), ...Object.keys(d.draft)].map(Number));
  const layout = new Map<number, F22RowSection>([
    ...ROW_LAYOUT,
    ...PAYMENT_SECTION_CODES.map((c) => [c, "payment"] as [number, F22RowSection]),
  ]);
  // A code only the draft has, at zero, says nothing (a year without crypto sales, dividends…).
  const chain = new Set(d.regime === "nonresident" ? [158, 32, 34, 305] : [158, 170, 157, 304, 305]);
  const shown = (c: number) =>
    d.filed?.[c] != null || d.informed[c] != null || (d.draft[c] ?? 0) !== 0 || (d.taxComputed && chain.has(c));
  for (const c of [...all]) if (!shown(c)) all.delete(c);
  const codes = [
    ...ROW_LAYOUT.map(([c]) => c).filter((c) => all.has(c)),
    ...PAYMENT_SECTION_CODES.filter((c) => all.has(c)),
    ...[...all].filter((c) => !layout.has(c)).sort((a, b) => a - b),
  ];
  const rows: F22PayloadRow[] = codes.map((code) => {
    const filed = d.filed?.[code] ?? null;
    const informed = d.informed[code] ?? null;
    const draft = d.draft[code] ?? null;
    const section = layout.get(code) ?? "other";
    return {
      code,
      section,
      filed,
      informed,
      draft,
      changed: section !== "payment" && filed != null && draft != null && draft !== filed,
      informed_mismatch: informed != null && filed != null && informed !== filed,
      estimated: d.estimatedCodes.includes(code),
    };
  });
  // The income tax determined: the IGC (304) plus, for a non-resident or a departure year, the Impuesto Adicional (34).
  const determined = (codes: Record<number, number> | null) => (codes == null ? null : (codes[304] ?? 0) + (codes[34] ?? 0));
  const windowPayload = (w: { fromYmd: string; throughYmd: string }) => ({ from: w.fromYmd, through: w.throughYmd });
  const residencyPeriod = (p: TaxResidencyPeriod) => ({ id: p.id, jurisdiction: p.jurisdiction, from: p.fromDate, to: p.toDate, note: p.note });
  return {
    tax_year: d.taxYear,
    income_year: d.incomeYear,
    available_tax_years: availableF22TaxYears(),
    provisional: d.provisional,
    base: d.base,
    regime: d.regime,
    residency: {
      regime: d.regime,
      declared: d.residency.year.declared,
      cl: d.residency.year.cl,
      us: d.residency.year.us,
      assumption: d.residency.assumption,
      periods: d.residency.year.periods.map(residencyPeriod),
      resident_window: d.residency.residentWindow == null ? null : windowPayload(d.residency.residentWindow),
      /** LIR art. 103's departure return (prorated brackets and credits) is not built: the resident part uses the full-year table. */
      art103_departure_return_built: false,
    },
    nonresident:
      d.nonresident == null
        ? null
        : {
            window: windowPayload(d.nonresident.window),
            tax_computed: d.nonresident.taxComputed,
            codes: Object.fromEntries(Object.entries(d.nonresident.codes).filter(([, v]) => v !== 0)),
            taxable_rent_clp: d.nonresident.rentals.taxableRentClp,
            exempt_rent_clp: d.nonresident.rentals.exemptRentClp,
            places: d.nonresident.rentals.places.map((p) => ({ slug: p.slug, label: p.label, dfl2: p.dfl2, credits: p.credits, rent_clp: p.rentClp })),
            art107: {
              sales: d.nonresident.art107.gains.disposals.length + d.nonresident.art107.gains.inrDisposals.length,
              result_clp: d.nonresident.art107.codes[1814],
              tax_clp: d.nonresident.art107.codes[1830],
            },
          },
    excluded: d.excluded.map((x) => ({ kind: x.kind, reason: x.reason, clp: x.clp, count: x.count, window: windowPayload(x.window) })),
    tax_computed: d.taxComputed,
    uta_clp: d.utaClp,
    uta_provisional: d.utaProvisional,
    salary: {
      months: d.salary.months,
      taxable_pay_clp: d.salary.taxablePayClp,
      withheld_tax_clp: d.salary.withheldTaxClp,
      incomplete_months: d.salary.incompleteMonths,
      provisional: d.salary.provisional,
    },
    fees: d.fees == null
      ? null
      : {
          receipts: d.fees.receipts,
          gross_clp: d.fees.grossClp,
          presumed_expenses_clp: d.fees.presumedExpensesClp,
          apv_clp: d.fees.apvClp,
          net_clp: d.fees.netClp,
          retention_clp: d.fees.retentionClp,
        },
    year_end_observado: d.yearEndObservado,
    settlement: f22Settlement(d.taxYear, d.filed),
    payroll_withholding: (() => {
      const checks = buildPayslipChecks();
      return { ...payrollWithholdingYear(d.incomeYear, checks), months: payrollWithholdingMonths(d.incomeYear, checks) };
    })(),
    rows,
    tax_filed: determined(d.filed),
    tax_draft: d.taxComputed ? determined(d.draft) : null,
    crypto: {
      method: d.crypto.method,
      fee_policy: d.crypto.feePolicy,
      informed_sales_clp: d.cryptoInformedSalesClp,
      sales_clp: d.crypto.proceedsClp,
      gain_december_clp: d.crypto.gainDecemberClp,
      provisional: d.crypto.provisional,
      reajuste_to_month: d.crypto.reajusteToMonth,
      sales: d.crypto.sales.map((s) => ({
        date: s.date,
        coin: s.coin.replace(/-USD$/, ""),
        units: s.units,
        proceeds_clp: s.proceedsClp,
        cost_clp: s.costClp,
        cost_reajustado_clp: s.costReajustadoClp,
        gain_clp: s.gainClp,
        december_pct: s.decemberPct,
        gain_december_clp: s.gainDecemberClp,
      })),
    },
    dividends: d.dividends.map((x) => ({
      date: x.date,
      net_usd: x.netUsd,
      gross_usd: x.grossUsd,
      withholding_usd: x.withholdingUsd,
      gross_clp: x.grossUsd == null ? null : x.grossUsd * d.yearEndObservado,
      withholding_clp: x.withholdingUsd == null ? null : x.withholdingUsd * d.yearEndObservado,
    })),
    loss_offset: {
      parts: d.lossOffset.parts.map((x) => ({ source: x.source, gain_clp: x.gainClp, loss_clp: x.lossClp })),
      ...offsetBalancePayload(d.lossOffset),
    },
    foreign_share_offset: offsetBalancePayload(d.foreignShareOffset),
    foreign_shares: {
      default_mode: d.foreignShares.defaultMode,
      provisional: d.foreignShares.provisional,
      total_clp: d.foreignShares.totalClp,
      idpc_clp: d.foreignSharesIdpcClp,
      sales: d.foreignShares.disposals.map((s) => ({
        date: s.date,
        account_name: s.accountName,
        units: s.units,
        gain_usd: s.gainUsd,
        result_clp: s.resultClp,
      })),
    },
    art107: {
      lot_method: d.art107.gains.lotMethod,
      provisional: d.art107.gains.provisional,
      inr_from: ART107_INR_FROM,
      default_option: d.art107.gains.defaultOption,
      sales: [...d.art107.gains.disposals, ...d.art107.gains.inrDisposals]
        .sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId)
        .map((s) => ({
          date: s.date,
          account_name: s.accountName,
          ticker: s.ticker,
          kind: s.kind,
          units: s.units,
          proceeds_clp: s.proceedsClp,
          cost_clp: s.costClp,
          cost_reajustado_clp: s.costReajustadoClp,
          cost_close_dec31_clp: s.costCloseDec31Clp,
          result_clp: s.resultClp,
          regime: s.regime,
        })),
      // Taxed (tax_10pct) sales only.
      totals_clp: d.art107.gains.totalClp,
      result_clp: d.art107.codes[1814],
      carried_loss_clp: d.art107.codes[1815],
      carried_loss_source: d.art107.carry.source,
      base_clp: d.art107.codes[1816],
      tax_clp: d.art107.codes[1830],
      informed_sales_clp: d.art107InformedSalesClp,
      informed_result_clp: d.art107InformedResultClp,
      distributions: d.art107Distributions.map((x) => ({
        date: x.date,
        account_name: x.accountName,
        amount_clp: x.amountClp,
      })),
      distributions_clp: d.art107DistributionsClp,
    },
    rentals: {
      provisional: d.rentals.provisional,
      places: d.rentals.places.map((p) => ({
        slug: p.slug,
        label: p.label,
        dfl2: p.dfl2,
        credits: p.credits,
        rent_clp: p.rentClp,
        property_tax_paid_clp: p.propertyTaxPaidClp,
      })),
      taxable_rent_clp: d.rentals.taxableRentClp,
      exempt_rent_clp: d.rentals.exemptRentClp,
      property_tax_credit: d.propertyTaxCredit == null
        ? null
        : {
            paid_clp: d.propertyTaxCredit.paidClp,
            cap_clp: d.propertyTaxCredit.capClp,
            credit_clp: d.propertyTaxCredit.creditClp,
          },
    },
    foreign_income: {
      salary: {
        provisional: d.foreignSalary.provisional,
        stubs: d.foreignSalary.stubs.length,
        income_usd: d.foreignSalary.incomeUsd,
        gross_clp: d.foreignSalary.grossClp,
        us_tax_usd: d.foreignSalary.usTaxUsd,
        us_tax_source: d.foreignSalary.usTaxSource,
        us_tax_clp: d.foreignSalary.usTaxClp,
        net_clp: d.foreignSalary.netClp,
        credit_clp: d.foreignSalary.creditClp,
        credit_cap_clp: d.foreignSalaryCredit?.capClp ?? null,
        credit_applied_clp: d.foreignSalaryCredit?.appliedClp ?? null,
      },
      interest: {
        lines: d.foreignInterest.lines.map((l) => ({ date: l.date, account_name: accountName(l.accountId), usd: l.usd })),
        usd: d.foreignInterest.usd,
        clp: d.foreignInterest.clp,
      },
    },
    foreign_fx: {
      route: d.foreignFx.route,
      posture: d.foreignFx.posture,
      purchase_cost: d.foreignFx.purchaseCost,
      provisional: d.foreignFx.reajusteIsEstimate,
      reajuste_to_month: d.foreignFx.reajusteToMonth,
      disposals: d.foreignFx.disposals.map((x) => ({
        date: x.date,
        account_name: accountName(x.accountId),
        currency: x.currency,
        amount: x.amount,
        purchase_dates: x.purchaseDates,
        proceeds_clp: x.proceedsClp,
        cost_clp: x.costClp,
        gain_clp: x.gainClp,
        december_pct: x.decemberPct,
        gain_december_clp: x.gainDecemberClp,
      })),
      fees: d.foreignFx.fees.map((x) => ({
        date: x.date,
        account_name: accountName(x.accountId),
        currency: x.currency,
        amount: x.amount,
        cost_lost_clp: x.costLostClp,
      })),
      fees_lost_clp: d.foreignFx.feesLostClp,
      deferred: d.foreignFx.deferred.map((x) => ({
        date: x.date,
        account_name: accountName(x.accountId),
        currency: x.currency,
        amount: x.amount,
        gain_clp: x.gainClp,
      })),
      deferred_clp: d.foreignFx.deferredClp,
      by_currency: d.foreignFx.byCurrency.map((c) => ({
        currency: c.currency,
        disposals: c.disposals,
        result: c.resultClp,
        result_december: c.resultDecemberClp,
        fees_lost: c.feesLostClp,
        deferred: c.deferredClp,
      })),
      result_clp: d.foreignFx.resultClp,
      result_december_clp: d.foreignFx.resultDecemberClp,
      codes: {
        1901: d.foreignFx.codes[1901] ?? null,
        idpc_clp: d.foreignFx.codes.idpcClp ?? null,
        1032: d.foreignFx.codes[1032] ?? null,
        loss169: d.foreignFx.codes.loss169 ?? null,
      },
    },
  };
}

export type F22Payload = ReturnType<typeof buildF22Payload>;
