/** GET /api/tax-return — the local Formulario 22 (server: f22DraftPayload.ts). */
export type TaxReturnRowSection =
  | "income"
  | "subtotal"
  | "deduction"
  | "tax"
  | "credit"
  | "result"
  | "memo"
  | "payment"
  | "other";

export type TaxReturnRow = {
  code: number;
  section: TaxReturnRowSection;
  filed: number | null;
  informed: number | null;
  draft: number | null;
  changed: boolean;
  informed_mismatch: boolean;
  estimated: boolean;
};

export type TaxReturnCryptoSale = {
  date: string;
  coin: string;
  units: number;
  proceeds_clp: number;
  cost_clp: number;
  cost_reajustado_clp: number;
  gain_clp: number;
  december_pct: number;
  gain_december_clp: number;
};

export type TaxReturnDividend = {
  date: string;
  net_usd: number;
  /** Null until the broker document with the gross / withholding split is imported. */
  gross_usd: number | null;
  withholding_usd: number | null;
  gross_clp: number | null;
  withholding_clp: number | null;
};

export type TaxReturnForeignShareSale = {
  date: string;
  account_name: string;
  units: number;
  gain_usd: number;
  result_clp: { usd_31dic: number; clp_ipc: number };
};

export type TaxReturnLossOffsetSource = "crypto" | "foreign_shares" | "foreign_dividends" | "funds_interest";

/** Gains and losses that offset each other within one year, and what is left on either side. */
export type TaxReturnOffsetBalance = {
  gains_clp: number;
  losses_clp: number;
  deducted_clp: number;
  unused_loss_clp: number;
  taxed_gain_clp: number;
  /** IGC at stake for the unused loss or the taxed gain; null without a tax chain. */
  tax_effect_clp: number | null;
};

/** The year's code-169 pool (F22 line 17): losses deduct only from these gains, in the same year. */
export type TaxReturnLossOffset = TaxReturnOffsetBalance & {
  parts: { source: TaxReturnLossOffsetSource; gain_clp: number; loss_clp: number }[];
};

export type TaxReturnResponse = {
  tax_year: number;
  income_year: number;
  available_tax_years: number[];
  provisional: boolean;
  base: "filed" | "informed" | "payroll" | "none";
  tax_computed: boolean;
  uta_clp: number;
  uta_provisional: boolean;
  salary: {
    months: number;
    taxable_pay_clp: number;
    withheld_tax_clp: number;
    incomplete_months: string[];
    provisional: boolean;
  };
  year_end_observado: number;
  /** How the filed form was settled: its refund or payment against the linked bank movements. */
  settlement: {
    expected: { kind: "refund" | "payment"; amount: number } | null;
    links: { kind: "refund" | "payment"; account_id: number; account_name: string; movement_id: number | null; occurred_on: string; amount: number; description: string }[];
    settled: number;
    difference: number | null;
  } | null;
  /** The year's salary payslips: tax withheld vs the monthly table on each payslip's taxable amount. */
  payroll_withholding: {
    income_year: number;
    payslips: number;
    withheld: number;
    by_table: number;
    difference: number;
    months_with_differences: string[];
    months: { payslip_id: number; period_month: string; origin: "document" | "rebuilt"; withheld: number; by_table: number; difference: number }[];
  };
  rows: TaxReturnRow[];
  tax_filed: number | null;
  tax_draft: number | null;
  crypto: {
    method: "fifo" | "lifo" | "average";
    fee_policy: "excluded" | "included";
    informed_sales_clp: number | null;
    sales_clp: number;
    gain_december_clp: number;
    provisional: boolean;
    reajuste_to_month: string;
    sales: TaxReturnCryptoSale[];
  };
  dividends: TaxReturnDividend[];
  loss_offset: TaxReturnLossOffset;
  /** Foreign share sales netted among themselves: a loss offsets nothing else. */
  foreign_share_offset: TaxReturnOffsetBalance;
  foreign_shares: {
    default_mode: "usd_31dic" | "clp_ipc";
    provisional: boolean;
    total_clp: { usd_31dic: number; clp_ipc: number };
    idpc_clp: number;
    sales: TaxReturnForeignShareSale[];
  };
};
