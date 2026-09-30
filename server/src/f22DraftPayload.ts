/**
 * The /tax-return page payload: the local F22 for one año tributario as ordered rows (the client
 * only labels and formats them), plus the detail behind the draft's additions.
 */
import { db } from "./db.js";
import { buildF22Draft, PAYMENT_SECTION_CODES } from "./f22Draft.js";

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
  /** Draft ≠ filed (never for the payment section, which the draft leaves to the SII). */
  changed: boolean;
  /** Informed by a third party and ≠ filed. */
  informed_mismatch: boolean;
};

/** Display order of the codes this taxpayer's return uses; any other stored code is appended as `other`. */
const ROW_LAYOUT: readonly [number, F22RowSection][] = [
  [1098, "income"],
  [161, "memo"],
  [155, "income"],
  [1869, "memo"],
  [152, "income"],
  [1878, "memo"],
  [1032, "income"],
  [1104, "income"],
  [748, "income"],
  [169, "income"],
  [158, "subtotal"],
  [750, "deduction"],
  [751, "memo"],
  [170, "subtotal"],
  [157, "tax"],
  [136, "credit"],
  [162, "credit"],
  [1018, "credit"],
  [304, "result"],
  [305, "result"],
  [31, "result"],
];

export function availableF22TaxYears(): number[] {
  return (db.prepare(`SELECT DISTINCT tax_year FROM sii_f22_filed ORDER BY tax_year DESC`).all() as { tax_year: number }[]).map(
    (r) => r.tax_year
  );
}

export function buildF22Payload(taxYear: number) {
  const d = buildF22Draft(taxYear);
  const all = new Set([...Object.keys(d.filed), ...Object.keys(d.informed), ...Object.keys(d.draft)].map(Number));
  const layout = new Map<number, F22RowSection>([
    ...ROW_LAYOUT,
    ...PAYMENT_SECTION_CODES.map((c) => [c, "payment"] as [number, F22RowSection]),
  ]);
  const codes = [
    ...ROW_LAYOUT.map(([c]) => c).filter((c) => all.has(c)),
    ...PAYMENT_SECTION_CODES.filter((c) => all.has(c)),
    ...[...all].filter((c) => !layout.has(c)).sort((a, b) => a - b),
  ];
  const rows: F22PayloadRow[] = codes.map((code) => {
    const filed = d.filed[code] ?? null;
    const informed = d.informed[code] ?? null;
    const draft = d.draft[code] ?? null;
    const section = layout.get(code) ?? "other";
    return {
      code,
      section,
      filed,
      informed,
      draft,
      changed: section !== "payment" && (draft ?? 0) !== (filed ?? 0),
      informed_mismatch: informed != null && informed !== (filed ?? 0),
    };
  });
  return {
    tax_year: d.taxYear,
    income_year: d.incomeYear,
    available_tax_years: availableF22TaxYears(),
    uta_clp: d.utaClp,
    year_end_observado: d.yearEndObservado,
    rows,
    tax_filed: d.filed[304] ?? 0,
    tax_draft: d.draft[304] ?? 0,
    crypto: {
      method: d.crypto.method,
      fee_policy: d.crypto.feePolicy,
      informed_sales_clp: d.cryptoInformedSalesClp,
      sales_clp: d.crypto.proceedsClp,
      gain_december_clp: d.crypto.gainDecemberClp,
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
      gross_usd: x.grossUsd,
      withholding_usd: x.withholdingUsd,
      gross_clp: x.grossUsd * d.yearEndObservado,
      withholding_clp: x.withholdingUsd * d.yearEndObservado,
    })),
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
  };
}

export type F22Payload = ReturnType<typeof buildF22Payload>;
